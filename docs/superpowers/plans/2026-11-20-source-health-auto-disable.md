# 源健康检查与自动停用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定时检测视频源与直播源可用性：连续 2 次失败自动停用，连续 2 次成功自动恢复，手动停用不受自动逻辑影响。

**Architecture:** 纯状态机与探活逻辑集中在 `src/lib/source-health.ts`；`/api/cron` 串起视频源探活与直播源 m3u 刷新并落库；后台手动启用/停用写入 `disabledBy: 'manual'`；后台表格展示自动停用状态。

**Tech Stack:** Next.js 14 App Router, TypeScript, Jest。

**Spec:** 用户在对话中确认的方案：连续失败才停用、恢复后自动启用、大面积失败（我方网络问题）本轮不落库、搜索无结果不算坏。

## Global Constraints

- 老配置里 `disabled: true` 且无 `disabledBy` 必须视为 manual（向后兼容）。
- 不新增任何 npm 依赖。
- 新增的状态字段一律可选，不改变既有存储读写的必填约定。
- 风格随仓库：单引号、2 空格缩进、`@/` 路径别名。
- 只改代码，不动部署配置（vercel.json 的 cron 频率由用户自行决定）。

## Review Focus

- 我方服务器断网/ DNS 故障时，不能把所有源都自动停用（熔断：`>=5` 个源且失败率 `>=80%` 时本轮不落库）。
- 自动停用的源在恢复前必须每轮继续探活，否则永远回不来。
- 手动停用的源不能被自动恢复逻辑重新启用。
- 直播源 m3u 拉取失败/解析出 0 频道算失败，但 `channelNumber` 仍要更新，避免后台数字过期。
- 视频源返回合法 JSON 但 `list` 为空（搜不到结果）不算失败。

---

### Task 1: 健康状态机

**Files:**

- Create: `src/lib/source-health.ts`
- Test: `src/lib/__tests__/source-health.test.ts`

**Interfaces:**

- Produces:

```ts
export const FAIL_THRESHOLD = 2;
export const RECOVER_THRESHOLD = 2;
export interface HealthFields {
  disabled?: boolean;
  disabledBy?: 'auto' | 'manual';
  failCount?: number;
  successCount?: number;
  lastCheckAt?: string;
  lastCheckError?: string;
}
export type HealthReport = { ok: true } | { ok: false; error: string };
export function shouldProbe(item: HealthFields): boolean;
export function applyHealthReport(
  item: HealthFields,
  report: HealthReport,
  now?: Date
): void;
export function shouldSuppressDisabling(failed: number, total: number): boolean;
```

- [ ] **Step 1: 写失败测试**（`src/lib/__tests__/source-health.test.ts`）

断言：

1. 首次失败：`failCount === 1`，`disabled` 仍为 `undefined`。
2. 连续第二次失败：`disabled === true`，`disabledBy === 'auto'`。
3. 失败后成功一次：`failCount === 0`，不进入 disabled。
4. 自动停用后成功一次仍停用；连续第二次成功解锁 `disabled === false` 且 `disabledBy === undefined`。
5. `shouldProbe({disabled:true})` 为 `false`（老数据视为 manual），`shouldProbe({disabled:true, disabledBy:'auto'})` 为 `true`。
6. manual 停用的对象调用 `applyHealthReport` 后状态不变。
7. `shouldSuppressDisabling(8,10) === true`；`(2,10) === false`；`(3,3) === false`（源太少不熔断）。
8. `lastCheckAt` 写入 ISO 字符串；失败时 `lastCheckError` 写入原因，恢复后清空。

- [ ] **Step 2: 运行 `pnpm test src/lib/__tests__/source-health.test.ts` 确认失败**

- [ ] **Step 3: 实现**

规则：失败 `failCount+1`，达到 `FAIL_THRESHOLD` 时置 `disabled: true, disabledBy: 'auto'`；成功清零 `failCount`，若当前是 auto 停用则 `successCount+1`，达到 `RECOVER_THRESHOLD` 解锁并清空 `disabledBy/successCount`。manual 停用直接返回不改。

- [ ] **Step 4: 测试通过后提交**

```bash
git add src/lib/source-health.ts src/lib/__tests__/source-health.test.ts
git commit -m "feat(source): 源健康状态机与自动停用策略"
```

### Task 2: 视频源探活

**Files:**

- Modify: `src/lib/source-health.ts`
- Test: `src/lib/__tests__/source-health.test.ts`

**Interfaces:**

- Produces: `probeVideoSource(api: string, options?: ProbeOptions): Promise<HealthReport>`，`ProbeOptions = { timeoutMs?: number; keyword?: string; fetchImpl?: typeof fetch; headers?: Record<string,string> }`。

- [ ] **Step 1: 写失败测试**

用注入的 `fetchImpl`（返回普通对象 `{ok, status, json}`）断言：

1. `{list: []}` → `ok: true`。
2. `{code: 0}`（无 list）→ `ok: false`。
3. HTTP 500 → `ok: false`，error 含 `500`。
4. `json()` 抛错 → `ok: false`，error 含 `JSON`。
5. 请求 URL 包含 `ac=videolist` 与 `wd=`。
6. `fetchImpl` reject 时 `ok: false` 且不抛出。

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 实现**：`${api}?ac=videolist&wd=${encodeURIComponent(keyword ?? '测试')}`，默认 10s 超时（AbortController + setTimeout），`Math.floor`。请求头默认 `API_CONFIG.search.headers`。

- [ ] **Step 4: 测试通过后提交**

```bash
git add -A src/lib
git commit -m "feat(source): 视频源探活请求"
```

### Task 3: 类型扩展

**Files:**

- Modify: `src/lib/admin.types.ts`（SourceConfig 项与 LiveConfig 项）

- [ ] **Step 1: 加字段** `disabledBy?: 'auto' | 'manual'; failCount?: number; successCount?: number; lastCheckAt?: string; lastCheckError?: string;`
- [ ] **Step 2: `pnpm typecheck` 通过**
- [ ] **Step 3: 提交**

### Task 4: cron 接线

**Files:**

- Modify: `src/app/api/cron/route.ts`

- [ ] **Step 1: 把局部 `runWithConcurrency` 提到模块作用域**
- [ ] **Step 2: 用 `refreshSourcesHealth()` 取代 `refreshAllLiveChannels()`**：`shouldProbe` 过滤 → 视频源 6 并发探活、直播源 4 并发 `refreshLiveChannels(liveInfo, { timeoutMs: 15000 })` → 汇总 → `shouldSuppressDisabling` 命中则只打日志不落库 → 否则 `applyHealthReport` 后 `db.saveAdminConfig`。
- [ ] **Step 3: `pnpm typecheck` 通过**
- [ ] **Step 4: 提交**

### Task 5: 手动操作打标记

**Files:**

- Modify: `src/app/api/admin/source/route.ts`（disable/enable/batch_disable/batch_enable/add）
- Modify: `src/app/api/admin/live/route.ts`（disable/enable/add/edit）
- Modify: `src/lib/live.ts`（`refreshLiveChannels` 增加可选 `timeoutMs`）

规则：手动停用写 `disabledBy='manual'`；手动启用清空 `disabledBy/failCount/successCount/lastCheckError`。

- [ ] **Step 1: 改两个 route + live.ts 超时参数**
- [ ] **Step 2: `pnpm typecheck`**
- [ ] **Step 3: 提交**

### Task 6: 后台展示

**Files:**

- Modify: `src/app/admin/page.tsx`（DataSource / LiveDataSource 类型、视频源状态徽章、直播源状态徽章 ~2373 / ~4209）

- [ ] **Step 1: 徽章文案**：启用中 / 已禁用 / **自动停用**（`disabled && disabledBy === 'auto'`），`title` 展示 `lastCheckAt` 与 `lastCheckError`。
- [ ] **Step 2: `pnpm typecheck && pnpm lint`**
- [ ] **Step 3: 提交**

### Task 7: 全量验证

- [ ] `pnpm test`、`pnpm typecheck`、`pnpm lint` 全绿
- [ ] 人工核对 cron 在禁用/恢复两轮下的状态变化（读代码 + 单元测试覆盖）
- [ ] 提交
