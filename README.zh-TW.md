# datafridge

[English](./README.md) | 繁體中文

資料的冰箱。datafridge 按排程補貨（proactive polling），所以開門即拿（`read()` 永遠不等上游），每項食物都貼著有效期限標籤（`fetchedAt` / `freshUntil` / `isStale`），就算超市燒掉了，冰箱裡還有存糧（stale-if-error）。

> **狀態：pre-release。** 此處描述的 API 依循 [DESIGN.md](./DESIGN.md)，在第一次 npm publish 之前仍可能變動。Wave 1 只支援 Cloudflare（Durable Object alarms + D1，或 Cron Triggers + D1）。[Roadmap](#roadmap-wave-2) 列出的東西目前都還不存在。里程碑進度見 [PLAN.md](./PLAN.md)。

## 語意契約

這六條保證就是產品本身。所有實作都不得違反：

1. **讀取永遠即回。** `read()` 只碰 result store，永遠不等上游。
2. **讀取永遠附帶時間。** 每個結果都帶 `fetchedAt`，caller 永遠知道資料多舊。
3. **Stale-if-error。** 上游失敗時保留 last-known-good 結果並標記 `isStale`，application 完全無感。
4. **At-least-once refresh。** 執行中的實例暴斃，租約（lease）過期後工作會自動被重撿，不需要任何清理程序。
5. **寫回一致性。** 併發或 zombie 執行者的過期寫回會被拒絕，store 永遠一致。
6. **Fail at config time。** 非法設定（timeout >= lease、沒有合法的 schedule plane、重複 name）在建構時就報錯，絕不留到 runtime。

## 為什麼

- **Request-triggered SWR libraries**（bentocache、cachified、stale-while-revalidate-cache）只在有人來讀時才刷新。沒有流量就沒有保鮮，而且冷啟動的第一個請求得吞下慢查詢。datafridge 主動刷新，資料永遠是熱的。
- **重量級 ETL 平台**（Airbyte、Fivetran）是 connector 生意，不是能隨插即用丟進 TypeScript 專案的 library。
- **自幹的 cron + Redis** 每個專案都重寫一次，而且 lease 處理、backoff、staleness 語意每次都做不全。

datafridge 是 **proactive scheduled refresh**、**per-source rate limiting**、**serve-stale-on-error** 三者的組合，做成模組完全正交、可替換的 TypeScript library：store 決定狀態放哪、driver 決定誰來踢、fetcher 跟著 poller 實例跑在哪都行。

Non-goals：不做 API connector（fetcher 一律是你自己的 closure）、不做 dashboard、不做 config DSL（config 就是 code）、不做 transparent proxy（只服務事先註冊的 named queries）。

## Quick start（Cloudflare）

Wave 1 提供兩套完整的 Cloudflare 接法。兩者都用你自己的 D1 資料庫當 result store。

### 組合 A（推薦）：Durable Object alarms + D1 results

Durable Object 在這裡的身分純粹是 scheduler：alarm 自我喚醒、單線程執行到期的 queries、排程簿記存在自己的 SQLite（driver 內部細節）。結果落在你的 D1，讀取端直接查 D1，完全不經過 DO。

```ts
// poller.ts
import { defineQueries } from '@datafridge/core'
import { PollerDO, d1Results } from '@datafridge/cloudflare'

const queries = defineQueries([
  {
    name: 'posthog-weekly',
    every: '10m',
    source: 'posthog',
    fetch: ({ signal }) => posthogQuery(weeklyReportSql, { signal }),
  },
])

export class Poller extends PollerDO {
  queries = queries
  results(env: Env) {
    return d1Results(env.DB)
  }
}
```

```ts
// worker.ts - the read side; same Worker or a completely different one
import { createReader } from '@datafridge/core'
import { d1Results, ensureStarted } from '@datafridge/cloudflare'

export default {
  async fetch(req, env) {
    await ensureStarted(env.POLLER) // idempotent; ignites the alarm chain
    const r = await createReader({ results: d1Results(env.DB) }).read('posthog-weekly')
    return Response.json(r)
    // r: { data, fetchedAt, isStale, age } | null (null = first fetch not done yet)
  },
}
```

```toml
# wrangler.toml
[[durable_objects.bindings]]
name = "POLLER"
class_name = "Poller"

[[d1_databases]]
binding = "DB"
database_id = "..."

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Poller"]
```

### 組合 B：Cron Triggers + D1 full store

完全不用 Durable Object。D1 同時承擔兩個 plane：results，以及由 compare-and-swap claim（`UPDATE ... WHERE version = ?`）保護的排程簿記，所以併發的 cron invocation 是安全的。排程粒度下限為 1 分鐘。

```ts
import { defineQueries, createPoller } from '@datafridge/core'
import { d1Store } from '@datafridge/cloudflare'

const queries = defineQueries([
  {
    name: 'posthog-weekly',
    every: '10m',
    source: 'posthog',
    fetch: ({ signal }) => posthogQuery(weeklyReportSql, { signal }),
  },
])

export default {
  scheduled: (event, env, ctx) =>
    ctx.waitUntil(createPoller({ store: d1Store(env.DB), queries }).runDue()),
}
```

```toml
# wrangler.toml
[triggers]
crons = ["* * * * *"] # minimum granularity: 1 minute
```

### 選哪個？

| | 組合 A（doAlarms） | 組合 B（cron + D1 CAS） |
|---|---|---|
| 排程粒度 | 任意 timestamp | 1 分鐘下限 |
| 排程可動態調整 | 可（backoff、runtime 改頻率） | tick 固定，due 判斷仍動態 |
| 併發保護 | driver 序列化，零成本 | D1 CAS claim |
| 元件 | DO + D1 | 只有 D1 |

生命週期細節（alarm 鏈點火、registry reconcile）與平台限制見 [docs/zh-TW/cloudflare.md](./docs/zh-TW/cloudflare.md)。

## 從任何地方讀取

結果是 result store 裡的純 JSON envelope。任何能連到 store 的 process 都能讀，不需要 poller 存在：

```ts
import { createReader } from '@datafridge/core'

const reader = createReader({ results: d1Results(env.DB) })
const r = await reader.read<WeeklyReport>('posthog-weekly')
```

完整的 poller 也直接提供 `poller.read()`，所以跑 poller 的那個家不需要另建 reader。其他語言的 consumer 只要能讀底層 store 就行，envelope 格式是純 JSON。

## 文件

- [docs/zh-TW/concepts.md](./docs/zh-TW/concepts.md) - 兩個 plane、envelope 與 schedule row、staleness 與失敗語意
- [docs/zh-TW/cloudflare.md](./docs/zh-TW/cloudflare.md) - 兩個組合的完整細節、生命週期、平台限制
- [docs/zh-TW/writing-adapters.md](./docs/zh-TW/writing-adapters.md) - ResultStore / ScheduleStore / Driver contracts 與 adapter 的驗收方式
- [docs/zh-TW/rate-limiting.md](./docs/zh-TW/rate-limiting.md) - per-tick budget、jitter，以及什麼時候才需要精確配額記帳

## Roadmap（wave 2+）

計劃中，目前尚未提供：

- `@datafridge/node`（setInterval driver）、`@datafridge/sqlite`、`@datafridge/redis`
- Result-plane 讀取加速複本（KV / Cache API；result plane 可接受最終一致性）
- 精確的 per-source 配額記帳（見 [docs/zh-TW/rate-limiting.md](./docs/zh-TW/rate-limiting.md)）
- 參數化 queries（`variants: () => params[]`）
- Metrics hook（`RunReport` 介面已為此預留）
- QStash / Inngest provisioning drivers
- `npx datafridge init cloudflare` scaffolding CLI（wave 1，里程碑 M3）
