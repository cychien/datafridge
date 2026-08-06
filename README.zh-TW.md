# datafridge

[English](./README.md) | 繁體中文

## 語意契約

這六項保證就是產品本身。所有實作都必須遵守：

1. **讀取永遠立即回傳。** `read()` 只存取 result store，絕不等待上游。
2. **讀取永遠附帶時間。** 每筆結果都有 `fetchedAt`，caller 永遠知道資料年齡。
3. **Stale-if-error。** 上游失敗時保留 last-known-good 結果並標示為 stale，不會用錯誤取代它。
4. **At-least-once refresh。** Executor 在執行中死亡時，lease 過期後會由另一個 executor 接手。
5. **寫回一致性。** Version 檢查會拒絕 concurrent 或 zombie executor 的遲到寫回。
6. **Fail at config time。** 非法 duration、重複名稱、不安全的 lease、不受平台支援的 timeout，以及無法解析的 schedule plane，都會在建構時拋錯。

資料的冰箱。datafridge 主動刷新 named queries，讓 request-time 讀取不必等待緩慢或不穩定的上游。每次讀取都標示資料年齡，stale-if-error 則保留最後一筆成功值。

Wave 1 支援兩種 Cloudflare 組合：Durable Object alarms 搭配 D1 results，或 Cron Triggers 搭配完整 D1 store。已接受的 parameterized-query slice 則加入有限的 runtime variants，可表達 resource ID 與 preset window 等維度。Fetcher 仍是 application code。datafridge 不是 API connector、proxy、dashboard 或 configuration DSL。

## 安裝

```sh
pnpm add @datafridge/core @datafridge/cloudflare
# 或：npm install @datafridge/core @datafridge/cloudflare
```

兩個 package 都只提供 ESM，開發工具需要 Node.js 20 以上版本。Worker code 在 Cloudflare Workers runtime 執行。

## Parameterized preset queries

相同 fetch 適用於有限的 runtime variants 時，使用一個 parameterized definition：

```ts
import { defineParameterizedQuery, defineQueries } from '@datafridge/core'

const courseAnalytics = defineParameterizedQuery({
  name: 'course-analytics',
  every: '10m',
  source: 'posthog',
  variants: () => courseIds.flatMap((courseId) =>
    ['7d', '30d', '90d'].map((window) => ({ courseId, window })),
  ),
  fetch: ({ params, signal }) => queryPostHogPreset(params, { signal }),
})

const queries = defineQueries([courseAnalytics])
const result = await reader.read('course-analytics', { courseId: 'course-a', window: '30d' })
```

每個 variant 都有獨立的 schedule、lease、backoff 與 envelope。新增或移除 variant 時，reconcile 行為與 named query 相同。Storage 與 `RunReport` identity 只包含公開 base name 與 canonical SHA-256 digest，不包含 raw parameter values。Params 仍只能放非機密的 JSON dimensions。Credential 必須放在 binding 或 fetcher closure。

## Cloudflare quick start

部署任一組合前，先套用 package 內附的 D1 schema：

```sh
pnpm exec wrangler d1 execute YOUR_DATABASE --remote \
  --file node_modules/@datafridge/cloudflare/migrations/0001_datafridge_init.sql
```

### 組合 A：Durable Object alarms + D1 results

Durable Object 在自己的 SQLite 中管理 serialized schedule bookkeeping。結果寫入 D1，reader 則直接查詢 D1。

```ts
import { createReader, defineQueries } from '@datafridge/core'
import { d1Results, ensureStarted, PollerDO } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
}

const queries = defineQueries([
  {
    name: 'weekly-summary',
    every: '10m',
    timeout: '30s',
    source: 'analytics',
    fetch: ({ signal }) => fetchWeeklySummary({ signal }),
  },
])

export class Poller extends PollerDO<Env> {
  queries = queries

  results(env: Env) {
    return d1Results(env.DB)
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    await ensureStarted(env.POLLER)
    const reader = createReader({ results: d1Results(env.DB) })
    return Response.json(await reader.read('weekly-summary'))
  },
}
```

```toml
[[durable_objects.bindings]]
name = "POLLER"
class_name = "Poller"

[[d1_databases]]
binding = "DB"
database_name = "datafridge"
database_id = "..."

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Poller"]
```

`ensureStarted()` 可重複安全呼叫。第一次使用時會啟動 alarm chain，部署後則會 reconcile 變更過的 query registry。

### 組合 B：Cron Triggers + D1 full store

D1 同時儲存 results 與 schedule rows。Atomic compare-and-swap claim 可確保重疊的 scheduled invocations 安全執行。

```ts
import { defineQueries } from '@datafridge/core'
import { cronPoller, d1Store } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
}

const queries = defineQueries([
  {
    name: 'weekly-summary',
    every: '10m',
    source: 'analytics',
    fetch: ({ signal }) => fetchWeeklySummary({ signal }),
  },
])

export default {
  scheduled: cronPoller<Env>({
    queries,
    store: (env) => d1Store(env.DB),
  }),
}
```

```toml
[triggers]
crons = ["* * * * *"]
```

| | 組合 A | 組合 B |
|---|---|---|
| Scheduler | Durable Object alarms | Cron Triggers |
| Schedule state | Durable Object SQLite | 使用 atomic claims 的 D1 |
| Result state | D1 | D1 |
| 粒度 | 精確 alarm timestamp | 最低 1 分鐘 |
| 適合情境 | 動態 backoff 與最低 claim 成本 | 較少平台元件 |

## Init CLI

安裝 `@datafridge/cloudflare` 後，可把兩種支援組合的設定 scaffold 到 TOML config：

```sh
pnpm exec datafridge init cloudflare
# npm：npx --no-install datafridge init cloudflare
```

需要時可加上 `--config path/to/wrangler.toml`。此命令具備 idempotent 行為、保留既有 declarations、拒絕與 `wrangler.json` 或 `wrangler.jsonc` 衝突，並列出無法安全加入的 declaration。保留你要使用的組合，刪除另一組 declarations。

## 讀取與失敗行為

```ts
const result = await createReader({ results: d1Results(env.DB) }).read<Summary>(
  'weekly-summary',
)
// { data, fetchedAt, isStale, age, lastError? } | null
```

`null` 表示第一次成功 refresh 尚未完成。上游錯誤與 timeout 會保留舊 envelope、增加失敗狀態，並以有 jitter 的 exponential backoff 重試，上限為正常 interval。`runDue()` 回傳 `{ ran, skippedLeased, deferredBudget, failed }`。組合 A 的 subclass 可 override `onRunReport(report)`，用於 sanitized operational logging。

權威語意契約見 [DESIGN.md section 2](./DESIGN.md#2-語意契約)，lease、version、backoff 與 staleness model 見 [docs/zh-TW/concepts.md](./docs/zh-TW/concepts.md)。

## 文件

- [API reference](./docs/zh-TW/api.md)
- [Cloudflare 設定與營運](./docs/zh-TW/cloudflare.md)
- [概念與失敗語意](./docs/zh-TW/concepts.md)
- [Rate limiting](./docs/zh-TW/rate-limiting.md)
- [撰寫 adapters](./docs/zh-TW/writing-adapters.md)
- [Release 流程與 package 名稱](./docs/zh-TW/releasing.md)
- [可執行的 Cloudflare 範例](./examples/cloudflare-basic)

## Wave 2 排除項目

Wave 1 尚未提供：

- Node timer、Redis、SQLite、Postgres、KV 或 Cache API adapters
- 不在有限 registry 內的 unbounded、on-demand 或任意 custom-range variants
- 精確的 shared quota-window accounting
- Metrics exporters 與 dashboards
- QStash 或 Inngest provisioning drivers
- Documentation website

## License

[MIT](./LICENSE)
