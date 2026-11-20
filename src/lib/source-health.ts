/**
 * 源健康检查：视频源 / 直播源的探活与自动停用、自动恢复策略。
 *
 * 设计要点：
 * - 连续 FAIL_THRESHOLD 次失败才停用，避免一次抖动就下线；
 * - 自动停用的源继续参与探活，连续 RECOVER_THRESHOLD 次成功才恢复；
 * - 手动停用的源不参与自动逻辑（老数据没有 disabledBy，一律按手动处理）；
 * - 大面积同时失败视为我方网络问题（熔断），调用方据此跳过本轮落库。
 *
 * 该模块不依赖项目内其它模块，方便单测。
 */

export const FAIL_THRESHOLD = 2;
export const RECOVER_THRESHOLD = 2;
export const BREAKER_MIN_SOURCES = 5;
export const BREAKER_FAILURE_RATIO = 0.8;

export interface HealthFields {
  disabled?: boolean;
  disabledBy?: 'auto' | 'manual';
  failCount?: number;
  successCount?: number;
  lastCheckAt?: string;
  lastCheckError?: string;
}

export type HealthReport = { ok: true } | { ok: false; error: string };

/** 手动停用（含没有 disabledBy 的老数据）不参与自动恢复 */
export function isManuallyDisabled(item: HealthFields): boolean {
  return item.disabled === true && (item.disabledBy ?? 'manual') === 'manual';
}

/** 只有启用中的源和自动停用的源需要探活 */
export function shouldProbe(item: HealthFields): boolean {
  return !item.disabled || item.disabledBy === 'auto';
}

/**
 * 应用一次探活结果，就地改写传入对象。
 * 调用方负责持久化，熔断命中时不要调用本函数。
 */
export function applyHealthReport(
  item: HealthFields,
  report: HealthReport,
  now: Date = new Date()
): void {
  if (isManuallyDisabled(item)) {
    return;
  }

  item.lastCheckAt = now.toISOString();

  if (report.ok) {
    item.failCount = 0;
    item.lastCheckError = undefined;

    if (item.disabled && item.disabledBy === 'auto') {
      item.successCount = (item.successCount ?? 0) + 1;
      if (item.successCount >= RECOVER_THRESHOLD) {
        item.disabled = false;
        item.disabledBy = undefined;
        item.successCount = 0;
      }
    } else {
      item.successCount = 0;
    }
    return;
  }

  item.successCount = 0;
  item.lastCheckError = report.error;
  item.failCount = (item.failCount ?? 0) + 1;

  if (!item.disabled && item.failCount >= FAIL_THRESHOLD) {
    item.disabled = true;
    item.disabledBy = 'auto';
  }
}

/**
 * 熔断：一轮检测里源足够多、且几乎全部失败时，多半是我方网络/DNS 出问题，
 * 此时停用全部源只会让站点彻底空掉，交给调用方跳过本轮。
 */
export function shouldSuppressDisabling(
  failed: number,
  total: number
): boolean {
  if (total < BREAKER_MIN_SOURCES) {
    return false;
  }
  return failed / total >= BREAKER_FAILURE_RATIO;
}

export type ProbeFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<Response>;

export interface ProbeOptions {
  timeoutMs?: number;
  keyword?: string;
  headers?: Record<string, string>;
  fetchImpl?: ProbeFetch;
}

const DEFAULT_PROBE_KEYWORD = '测试';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

/**
 * 按采集站的搜索接口探活：只要能返回带 list 数组的 JSON 就算健康，
 * list 为空（搜不到结果）不算坏。
 */
export async function probeVideoSource(
  api: string,
  options: ProbeOptions = {}
): Promise<HealthReport> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    keyword = DEFAULT_PROBE_KEYWORD,
    headers = DEFAULT_HEADERS,
    fetchImpl = fetch as unknown as ProbeFetch,
  } = options;

  const url = `${api}?ac=videolist&wd=${encodeURIComponent(keyword)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { ok: false, error: '返回内容不是合法 JSON' };
    }

    const list = (data as { list?: unknown } | null)?.list;
    if (!Array.isArray(list)) {
      return { ok: false, error: '返回数据缺少 list 字段' };
    }

    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: `请求超时（${timeoutMs}ms）` };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : '请求失败',
    };
  } finally {
    clearTimeout(timer);
  }
}
