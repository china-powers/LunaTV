/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { AdminConfig } from '@/lib/admin.types';
import { API_CONFIG, getConfig, refineConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { fetchVideoDetail } from '@/lib/fetchVideoDetail';
import { refreshLiveChannels } from '@/lib/live';
import {
  applyHealthReport,
  copyHealthState,
  HealthFields,
  HealthReport,
  isManuallyDisabled,
  probeVideoSource,
  shouldProbe,
  shouldSuppressDisabling,
} from '@/lib/source-health';
import { SearchResult } from '@/lib/types';

export const runtime = 'nodejs';

// 最小执行间隔：该任务会遍历所有用户的播放记录/收藏并请求上游，
// 频繁触发会造成资源浪费，这里做一层节流与互斥，避免任务堆叠
const MIN_INTERVAL_MS = 5 * 60 * 1000;
let runningJob: Promise<void> | null = null;
let lastRunAt = 0;

// 健康检查并发与超时：视频源只发一次搜索请求，直播源要拉整个 m3u，分开配置
const VIDEO_PROBE_CONCURRENCY = 6;
const LIVE_PROBE_CONCURRENCY = 4;
const LIVE_FETCH_TIMEOUT_MS = 15 * 1000;

// 一轮健康检查里单个源的检测结果（视频源没有频道数，用 null 占位）
interface HealthCheckResult {
  source: HealthFields & { key: string; channelNumber?: number };
  channelNumber: number | null;
  report: HealthReport;
}

// 带并发上限地跑一组任务，结果顺序与入参一致
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;
  const worker = async () => {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  );
  return results;
}

function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  return runWithConcurrency(
    items.map((item) => () => task(item)),
    concurrency
  );
}

export async function GET(request: NextRequest) {
  console.log(request.url);
  try {
    console.log('Cron job triggered:', new Date().toISOString());

    if (runningJob) {
      return NextResponse.json({
        success: true,
        message: 'Cron job already running, skipped',
        timestamp: new Date().toISOString(),
      });
    }

    const now = Date.now();
    if (now - lastRunAt < MIN_INTERVAL_MS) {
      return NextResponse.json({
        success: true,
        message: 'Cron job skipped, triggered too frequently',
        timestamp: new Date().toISOString(),
      });
    }

    lastRunAt = now;
    runningJob = cronJob()
      .catch((err) => {
        console.error('Cron job failed:', err);
      })
      .finally(() => {
        runningJob = null;
      });

    return NextResponse.json({
      success: true,
      message: 'Cron job executed successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cron job failed:', error);

    return NextResponse.json(
      {
        success: false,
        message: 'Cron job failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

async function cronJob() {
  await refreshConfig();
  await refreshSourcesHealth();
  await refreshRecordAndFavorites();
}

async function refreshSourcesHealth() {
  const config = await getConfig();
  // 启用中的源 + 之前被自动停用的源都要探活，后者连续成功才能自动恢复
  const videoSources = (config.SourceConfig || []).filter(shouldProbe);
  const liveSources = (config.LiveConfig || []).filter(shouldProbe);

  if (videoSources.length === 0 && liveSources.length === 0) {
    return;
  }

  const [videoResults, liveResults] = await Promise.all([
    // 视频源按采集站搜索接口探活
    mapWithConcurrency(
      videoSources,
      VIDEO_PROBE_CONCURRENCY,
      async (source): Promise<HealthCheckResult> => ({
        source,
        channelNumber: null,
        report: await probeVideoSource(source.api, {
          headers: API_CONFIG.search.headers,
        }),
      })
    ),
    // 直播源按 m3u 拉取结果探活，顺带刷新频道数
    mapWithConcurrency(
      liveSources,
      LIVE_PROBE_CONCURRENCY,
      async (liveInfo): Promise<HealthCheckResult> => {
        try {
          const channelNumber = await refreshLiveChannels(liveInfo, {
            timeoutMs: LIVE_FETCH_TIMEOUT_MS,
          });
          const report: HealthReport =
            channelNumber > 0
              ? { ok: true }
              : { ok: false, error: '未解析到任何频道' };
          return { source: liveInfo, channelNumber, report };
        } catch (error) {
          console.error(
            `刷新直播源失败 [${liveInfo.name || liveInfo.key}]:`,
            error
          );
          return {
            source: liveInfo,
            channelNumber: 0,
            report: {
              ok: false,
              error: error instanceof Error ? error.message : '拉取 m3u 失败',
            } as HealthReport,
          };
        }
      }
    ),
  ]);

  const results = [...videoResults, ...liveResults];
  const failed = results.filter((result) => !result.report.ok).length;

  // 大面积同时失败多半是我方网络/DNS 问题，本轮一个源都不停，也不写频道数
  if (shouldSuppressDisabling(failed, results.length)) {
    console.warn(
      `[健康检查] ${failed}/${results.length} 个源同时失败，疑似本地网络问题，本轮不停用任何源`
    );
    return;
  }

  results.forEach((result) => {
    if (result.channelNumber !== null) {
      result.source.channelNumber = result.channelNumber;
    }
    applyHealthReport(result.source, result.report);
  });

  // 写回前重新取一次最新配置：探活可能持续数十秒，期间后台或其它实例可能改过
  // 配置，直接拿旧快照整份覆盖会把对方的人工停用、换源等改动冲掉
  await persistHealthState(videoResults, liveResults);

  const autoDisabled = results.filter(
    (result) => result.source.disabled && result.source.disabledBy === 'auto'
  ).length;
  console.log(
    `[健康检查] 完成：检测 ${results.length} 个源，失败 ${failed} 个，当前自动停用 ${autoDisabled} 个`
  );
}

// 只把本轮检测到的健康状态合并进最新配置，避免覆盖并发写入的其它改动
async function persistHealthState(
  videoResults: HealthCheckResult[],
  liveResults: HealthCheckResult[]
) {
  let latest: AdminConfig | null = null;
  try {
    latest = await db.getAdminConfig();
  } catch (error) {
    console.error('[健康检查] 读取最新配置失败，跳过写回:', error);
    return;
  }
  if (!latest) {
    return;
  }

  const checkedVideo = new Map(
    videoResults.map((result) => [result.source.key, result.source])
  );
  const checkedLive = new Map(
    liveResults.map((result) => [result.source.key, result.source])
  );

  (latest.SourceConfig || []).forEach((entry) => {
    const checked = checkedVideo.get(entry.key);
    // 探活期间被人工停用的源，以人工状态为准，不能被旧快照改回启用
    if (!checked || isManuallyDisabled(entry)) {
      return;
    }
    copyHealthState(entry, checked);
  });

  (latest.LiveConfig || []).forEach((entry) => {
    const checked = checkedLive.get(entry.key);
    if (!checked || isManuallyDisabled(entry)) {
      return;
    }
    copyHealthState(entry, checked);
    if (checked.channelNumber !== undefined) {
      entry.channelNumber = checked.channelNumber;
    }
  });

  await db.saveAdminConfig(latest);
}

async function refreshConfig() {
  let config = await getConfig();
  if (
    config &&
    config.ConfigSubscribtion &&
    config.ConfigSubscribtion.URL &&
    config.ConfigSubscribtion.AutoUpdate
  ) {
    try {
      const response = await fetch(config.ConfigSubscribtion.URL);

      if (!response.ok) {
        throw new Error(`请求失败: ${response.status} ${response.statusText}`);
      }

      const configContent = await response.text();

      // 对 configContent 进行 base58 解码
      let decodedContent;
      try {
        const bs58 = (await import('bs58')).default;
        const decodedBytes = bs58.decode(configContent);
        decodedContent = new TextDecoder().decode(decodedBytes);
      } catch (decodeError) {
        console.warn('Base58 解码失败:', decodeError);
        throw decodeError;
      }

      try {
        JSON.parse(decodedContent);
      } catch (e) {
        throw new Error('配置文件格式错误，请检查 JSON 语法');
      }
      config.ConfigFile = decodedContent;
      config.ConfigSubscribtion.LastCheck = new Date().toISOString();
      config = refineConfig(config);
      await db.saveAdminConfig(config);
    } catch (e) {
      console.error('刷新配置失败:', e);
    }
  } else {
    console.log('跳过刷新：未配置订阅地址或自动更新');
  }
}

async function refreshRecordAndFavorites() {
  try {
    const users = await db.getAllUsers();
    if (process.env.USERNAME && !users.includes(process.env.USERNAME)) {
      users.push(process.env.USERNAME);
    }
    // 函数级缓存：key 为 `${source}+${id}`，值为 Promise<VideoDetail | null>
    const detailCache = new Map<string, Promise<SearchResult | null>>();

    // 获取详情 Promise（带缓存和错误处理）
    const getDetail = async (
      source: string,
      id: string,
      fallbackTitle: string
    ): Promise<SearchResult | null> => {
      const key = `${source}+${id}`;
      let promise = detailCache.get(key);
      if (!promise) {
        promise = fetchVideoDetail({
          source,
          id,
          fallbackTitle: fallbackTitle.trim(),
        })
          .then((detail) => {
            const successPromise = Promise.resolve(detail);
            detailCache.set(key, successPromise);
            return detail;
          })
          .catch((err) => {
            console.error(`获取视频详情失败 (${source}+${id}):`, err);
            return null;
          });
        detailCache.set(key, promise);
      }
      return promise;
    };

    // 处理单个用户的播放记录和收藏
    const processUser = async (user: string) => {
      console.log(`开始处理用户: ${user}`);

      // 播放记录
      try {
        const playRecords = await db.getAllPlayRecords(user);
        const entries = Object.entries(playRecords);
        const totalRecords = entries.length;
        let processedRecords = 0;

        const tasks = entries.map(([key, record]) => async () => {
          try {
            const [source, id] = key.split('+');
            if (!source || !id) {
              console.warn(`跳过无效的播放记录键: ${key}`);
              return;
            }

            const detail = await getDetail(source, id, record.title);
            if (!detail) {
              console.warn(`跳过无法获取详情的播放记录: ${key}`);
              return;
            }

            const episodeCount = detail.episodes?.length || 0;
            if (episodeCount > 0 && episodeCount !== record.total_episodes) {
              await db.savePlayRecord(user, source, id, {
                title: detail.title || record.title,
                source_name: record.source_name,
                cover: detail.poster || record.cover,
                index: record.index,
                total_episodes: episodeCount,
                play_time: record.play_time,
                year: detail.year || record.year,
                total_time: record.total_time,
                save_time: record.save_time,
                search_title: record.search_title,
              });
              console.log(
                `更新播放记录: ${record.title} (${record.total_episodes} -> ${episodeCount})`
              );
            }

            processedRecords++;
          } catch (err) {
            console.error(`处理播放记录失败 (${key}):`, err);
          }
        });

        await runWithConcurrency(tasks, 5);
        console.log(`播放记录处理完成: ${processedRecords}/${totalRecords}`);
      } catch (err) {
        console.error(`获取用户播放记录失败 (${user}):`, err);
      }

      // 收藏
      try {
        let favorites = await db.getAllFavorites(user);
        favorites = Object.fromEntries(
          Object.entries(favorites).filter(([_, fav]) => fav.origin !== 'live')
        );
        const favEntries = Object.entries(favorites);
        const totalFavorites = favEntries.length;
        let processedFavorites = 0;

        const tasks = favEntries.map(([key, fav]) => async () => {
          try {
            const [source, id] = key.split('+');
            if (!source || !id) {
              console.warn(`跳过无效的收藏键: ${key}`);
              return;
            }

            const favDetail = await getDetail(source, id, fav.title);
            if (!favDetail) {
              console.warn(`跳过无法获取详情的收藏: ${key}`);
              return;
            }

            const favEpisodeCount = favDetail.episodes?.length || 0;
            if (favEpisodeCount > 0 && favEpisodeCount !== fav.total_episodes) {
              await db.saveFavorite(user, source, id, {
                title: favDetail.title || fav.title,
                source_name: fav.source_name,
                cover: favDetail.poster || fav.cover,
                year: favDetail.year || fav.year,
                total_episodes: favEpisodeCount,
                save_time: fav.save_time,
                search_title: fav.search_title,
              });
              console.log(
                `更新收藏: ${fav.title} (${fav.total_episodes} -> ${favEpisodeCount})`
              );
            }

            processedFavorites++;
          } catch (err) {
            console.error(`处理收藏失败 (${key}):`, err);
          }
        });

        await runWithConcurrency(tasks, 5);
        console.log(`收藏处理完成: ${processedFavorites}/${totalFavorites}`);
      } catch (err) {
        console.error(`获取用户收藏失败 (${user}):`, err);
      }
    };

    // 用户间并发处理（限制 3 个用户同时处理）
    const userTasks = users.map((user) => () => processUser(user));
    await runWithConcurrency(userTasks, 3);

    console.log('刷新播放记录/收藏任务完成');
  } catch (err) {
    console.error('刷新播放记录/收藏任务启动失败', err);
  }
}
