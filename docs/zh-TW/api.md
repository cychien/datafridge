# API reference

[English](../api.md) | 繁體中文

## `@datafridge/core`

### Query registry

```ts
const queries = defineQueries([
  {
    name: 'analytics-7d',
    every: '10m',
    timeout: '30s',
    lease: '1m',
    source: 'analytics',
    fetch: async ({ signal, now, attempt }) => fetchValue({ signal, now, attempt }),
  },
])
```

`defineQueries(definitions)` 回傳 `Queries` registry。每個 fixed query 可設定：

| 欄位 | 必填／預設值 | 意義與設定方式 |
|---|---|---|
| `name` | 必填 | Query 的公開識別名稱，也是 `read(name)` 使用的名稱。Registry 內必須唯一、不得為空，也不得以保留前綴 `@df/v1/` 開頭。 |
| `every` | 必填 | 成功抓取後，下一次排程刷新的目標間隔，也決定結果何時開始回報 `isStale: true`。它不是精確 cron，rate limit、backoff 或平台延遲都可能讓實際刷新更晚。 |
| `timeout` | `'30s'` | 一次 fetch 最多可執行多久。時間到時會 abort `signal`；cold read 的等待上限也是這個值。 |
| `lease` | `timeout + 30s` | Claim 後禁止其他 executor 重複執行的期限。Executor 死亡時，lease 到期後工作才能被重新 claim。必須大於 `timeout`，通常使用預設值。 |
| `source` | `'default'` | 上游額度的分組名稱。使用同一份供應商額度的 queries 應使用相同名稱。 |
| `fetch` | 必填 | 呼叫上游的 async function。回傳值會寫入 Store；失敗時應 throw，並將 `signal` 傳給支援取消的 client。 |
| `codec` | 選填 | `{ encode(value), decode(raw) }`。將非 JSON-native 資料 encode 後儲存，並在持有 registry 的 reader 讀取時 decode。 |
| `validUntil` | 選填 | `(ctx: { params?, now }) => number`。回傳資料本身失效的 epoch milliseconds；到期後資料仍會回傳，但 `status` 是 `'invalid'`。 |

Duration 接受正數 milliseconds，或以 `ms`、`s`、`m`、`h`、`d` 結尾的字串，例如 `5000`、`'30s'`、`'10m'`。

`fetch` context：

| 欄位 | 意義 |
|---|---|
| `signal` | 在 `timeout` 到期時 abort 的 `AbortSignal`。 |
| `now` | 這次上游呼叫開始時的 epoch milliseconds。 |
| `attempt` | 第一次是 `1`，每次連續失敗後加一，成功後重設。 |

### Parameterized queries

```ts
const analytics = defineParameterizedQuery({
  name: 'course-analytics',
  every: '10m',
  variants: [
    { courseId: 'course-a', window: '7d' },
    { courseId: 'course-a', window: '30d' },
  ],
  fetch: ({ params, signal }) => fetchAnalytics(params, { signal }),
})

const queries = defineQueries([analytics])
```

Parameterized query 沿用 fixed query 的設定，並增加：

| 欄位 | 必填／預設值 | 意義 |
|---|---|---|
| `variants` | 三選一 | Params 陣列，或收到 `{ signal }` 並回傳 params 陣列的 function。陣列只展開一次；function 可為 async，並在每個 tick 重新解析。 |
| `dimensions` | 三選一 | 每個 params 欄位的候選值，datafridge 會展開笛卡兒積。每個值可為陣列，或收到 `{ signal }` 的 function。 |
| `anyParams` | 三選一 | 設為 `true` 代表接受任何 params，詳見下一節。 |
| `fetch.params` | 自動提供 | 目前 variant 的 params snapshot。 |

`variants`、`dimensions`、`anyParams` 只能設定一個。每個列出的 variant 都有獨立的 result、schedule、lease 與 backoff；dynamic 清單新增或移除 params 時會自動 reconcile。

Params 必須是有限數字、字串、boolean、`null`、array 或 plain object，不得包含 credential。可用 `queryKey(name, params)` 取得穩定的 storage identity。

### 開放的 parameter 空間

```ts
const funnel = defineParameterizedQuery({
  name: 'course-funnel',
  anyParams: true,
  timeout: '20s',
  source: 'posthog',
  fetch: ({ params, signal }) => fetchFunnel(params, { signal }),
})
```

| 欄位 | 必填／預設值 | 意義 |
|---|---|---|
| `name` | 必填 | Query base name。 |
| `anyParams` | 必須為 `true` | 接受任何合法的 `QueryParams`。 |
| `timeout` | `'30s'` | 每次讀取觸發的上游呼叫期限。 |
| `source` | `'default'` | Rate-limit 分組名稱。 |
| `fetch` | 必填 | 每次讀取時執行，context 會包含 `params`。 |

`anyParams` 不接受 `every`、`lease`、`validUntil` 或 `codec`。每次讀取都是一次不儲存的新呼叫；同時讀取相同 params 仍會合流。Reader 必須使用完整的 Store。

### Fridge

```ts
const fridge = createFridge({ queries, driver, store, sources })

const report = await fridge.runDue()
const value = await fridge.read<Result>('analytics-7d')
```

`createFridge(config)`：

| 欄位 | 必填／預設值 | 意義 |
|---|---|---|
| `queries` | 必填 | `Queries` registry 或 query definitions。 |
| `store` | 必填 | 同時提供 result 與 schedule 能力的完整 `Store`。 |
| `driver` | 必填 | Scheduler integration，設定如下表。 |
| `sources` | 無限制 | 每個 source 的 rate limit 與 concurrency policy。 |
| `clock` | `systemClock` | 可注入的 clock，主要供 adapter 與 test 使用。 |
| `random` | system random | 可注入的 random function，主要供 adapter 與 test 使用。 |

`driver`：

| 欄位 | 必填／預設值 | 意義 |
|---|---|---|
| `serialized` | 必填 | 是否保證同一時間只有一個 `runDue()`。 |
| `defer` | 必填 | 接住背景 promise，例如 Workers 的 `ctx.waitUntil`。 |
| `schedule` | 選填 | Driver 自帶的 `SchedulePlane`；省略時使用 Store 的 schedule 能力。 |
| `budgetMs` | 選填 | 單次 invocation 的 wall-clock budget。放不下的 query 會延到下一次執行。 |

`sources[source]`：

| 欄位 | 必填／預設值 | 意義 |
|---|---|---|
| `limit.requests` | 使用 `limit` 時必填 | 每個窗口允許的呼叫數。 |
| `limit.per` | 使用 `limit` 時必填 | 固定、epoch-aligned 窗口的長度。 |
| `limit.reserve` | `0` | 保留給 cold reads、不讓 scheduled refresh 使用的額度。必須小於 `requests`。 |
| `maxConcurrent` | 無限制 | 同一 source 最多同時執行的上游呼叫數。 |

每個 source policy 必須設定 `limit`、`maxConcurrent` 或兩者。

`runDue(now?)` 執行到期工作並回傳：

```ts
interface RunReport {
  ran: string[]
  skippedLeased: string[]
  throttled: string[]
  deferred: string[]
  failed: Array<{ name: string; message: string }>
  nextRunAt: number | null
}
```

`fridge.read(name, params?)` 與 `Reader.read()` 使用相同讀取語意。

### Reader

```ts
const reader = createReader({ store, queries, sources, defer })
const result = await reader.read<Result>('analytics-7d')
```

`createReader(config)`：

| 欄位 | 必填／預設值 | 意義 |
|---|---|---|
| `store` | 必填 | Results-only 或完整的 `Store`。完整 Store 搭配 `queries` 時可在 cold miss 自行 fetch。 |
| `queries` | 選填 | 驗證 query name，並提供 cold miss 的 `timeout` 與 fetcher。省略時，miss 立即回 `null`。 |
| `sources` | 無限制 | Reader 自行 fetch 時使用的 source policies。 |
| `defer` | no-op | 接住比 response 活得更久的工作；Workers 通常傳入 `ctx.waitUntil`。 |
| `clock` | `systemClock` | 可注入的 clock。 |
| `random` | system random | 可注入的 random function。 |

- 有資料時立即回傳，不呼叫上游。
- 完整 Store 的 cold miss 會 fetch；results-only Store 只等待其他 executor 寫入。
- 額度或 concurrency 已滿時回傳 `{ status: 'throttled', retryAt }`。

```ts
interface ReadResult<T> {
  data: T
  fetchedAt: number
  isStale: boolean
  age: number
  status: 'ok' | 'invalid'
  validUntil?: number
  lastError?: { at: number; message: string; count: number }
}
```

沒有任何成功結果且在 `timeout` 內也未取得資料時回傳 `null`。

### Stores 與 test utilities

| Export | 用途 |
|---|---|
| `memoryStore()` | 完整 `Store` 的 in-memory reference implementation。 |
| `storeContractSuite(label, factory)` | 從 `@datafridge/core/contract-tests` 匯入，驗證 Store adapter。 |
| `FakeClock`, `flushMicrotasks` | Deterministic test utilities。 |
| `parseDuration`, `queryKey`, `resolveSources`, `systemClock` | Public utilities。 |
| `ConfigError`, `TimeoutError`, `RateLimitError` | Public error classes。 |

Store、driver、query 與 result interfaces 都可從 package root 匯入。`@datafridge/core` 沒有 runtime dependency；只有 contract tests 使用選填的 `vitest` peer。

## `@datafridge/cloudflare`

| Export | Subpath | 用途 |
|---|---|---|
| `FridgeDO`, `ensureStarted` | `@datafridge/cloudflare/do` | Durable Object alarm scheduler。 |
| `d1` | `@datafridge/cloudflare/d1` | D1 Store。 |
| `cronDriver`, `cronFridge` | `@datafridge/cloudflare/cron` | Cron Trigger integration。 |
| `INVOCATION_WALL_CLOCK_LIMIT_MS` | package root | Cloudflare invocation ceiling。 |

### `FridgeDO`

```ts
export class Poller extends FridgeDO<Env> {
  queries = queries
  sources = sourcePolicies

  store(env: Env) {
    return d1(env.DB)
  }

  protected override onRunReport(report: RunReport) {
    logSanitized(report)
  }
}
```

| 成員 | 必填／預設值 | 意義 |
|---|---|---|
| `queries` | 必填 | Registry 或 query definitions。 |
| `store(env)` | 必填 | 回傳完整的 `Store`：`d1(env.DB)`、`postgresStore(...)` 或任何其他 Store。每次 alarm 開始時呼叫。 |
| `sources` | 無限制 | Source policies。 |
| `onRunReport(report)` | no-op | 每次 alarm 後的 hook。不要記錄 payload 或未清理的 error details。 |

`store(env)` 每次 alarm 都會呼叫，所以應回傳一個輕量 wrapper，包住物件自己持有的連線：Durable Object 可以在自己的 requests 與 alarms 之間重用連線，因此把 Postgres pool 放在 instance 上並回傳 `postgresStore(this.pool)`，不要每次 alarm 都開一個新 pool。

`ensureStarted(namespace, instanceName?)` 會啟動 alarm chain；`instanceName` 預設為 `'datafridge'`。重複呼叫是安全的。Cloudflare query 的 `timeout` 必須短於 15 分鐘。

### `d1`

`d1(db)` 將 `D1Database` 包裝成完整、可 atomic claim 的 `Store`。

- 第一次寫入時自動建表；內附 migration 可選用。
- 讀取不會建立 schema，不存在的 table 視為空 Store。
- 超過 D1 2,000,000-byte row limit 的結果會被拒絕，舊結果保留。

### `cronFridge`

```ts
export default {
  scheduled: cronFridge<Env>({
    queries,
    store: (env) => d1(env.DB),
    sources,
    onRunReport,
  }),
}
```

| 欄位 | 必填／預設值 | 意義 |
|---|---|---|
| `queries` | 必填 | Registry 或 query definitions。 |
| `store(env)` | 必填 | 每次 invocation 建立完整 Store。一般 Worker 無法跨 invocation 重用連線，因此請給它一個在 statements 之間不持有連線的 store，例如 `postgresStore(neon(url, { fullResults: true }))`。 |
| `sources` | 無限制 | Source policies。 |
| `onRunReport(report)` | no-op | 每次 tick 後的 hook。 |

`cronDriver(ctx)` 是 lower-level non-serialized driver，適合需要直接使用 `createFridge` 或 `RunReport` 的整合。

### Init CLI

```sh
pnpm exec datafridge init --scheduler <durable-object|cron> --store d1 [--config wrangler.toml]
```

| Flag | 必填／預設值 | 意義 |
|---|---|---|
| `--scheduler` | 必填 | `durable-object` 或 `cron`。 |
| `--store` | 必填 | 目前為 `d1`。 |
| `--config` | `wrangler.toml` | 要更新的 TOML file。 |

CLI 會保留既有 declarations，只加入所選組合需要的 bindings、migration 或 cron trigger。完整部署流程見 [Cloudflare 設定](./cloudflare.md)。

## `@datafridge/postgres`

| Export | 用途 |
|---|---|
| `postgresStore(db)` | 支援 atomic claim 與 `listDue` 的 Postgres Store。 |
| `ensureSchema(db)` | 建立 store 擁有的 tables 與 indexes（若不存在）。 |
| `POSTGRES_SCHEMA` | 同一份 DDL 的單一 statements，供你自己的 migration pipeline 使用。 |
| `PostgresQueryable`, `PostgresClient` | `db` 可接受的 client 形狀。 |

```ts
import { createReader } from '@datafridge/core'
import { ensureSchema, postgresStore } from '@datafridge/postgres'

const store = postgresStore(pool)
await ensureSchema(pool) // 選用：否則第一次寫入時會自動執行
const reader = createReader({ store, queries, sources })
```

`db` 就是你的 app 已經持有的 client；store 從不自己開連線，也沒有 runtime dependency。任何具備 `query(text, params) => Promise<{ rows }>` 的東西都可以：node-postgres 的 `Pool`、`Client` 或 `PoolClient`、PGlite、Neon 的 `Pool` 與 `Client`，或 `neon(url, { fullResults: true })`；也接受 node-postgres 或 PGlite 的 Drizzle database，每個 statement 都會重新讀取它的 `$client`，所以按 request 或按 Durable Object 分配連線的 database 也能正常運作。node-postgres 的 `Client` 一次只服務一個 statement；多個 reads 或 ticks 共用時請用 `Pool`。

- **每個操作一個 statement，不用 transaction。** Atomicity 來自 Postgres row lock：claim 是 `UPDATE ... WHERE version = $n`，取得 lock 後會對最新的 row 重新檢查條件；quota ledger 與 concurrency permits 都是針對每個 source 一列的單一 `INSERT ... ON CONFLICT DO UPDATE`；flights 也用同樣方式取得，sweep 會跳過被其他連線 lock 住的 row。因此在 `READ COMMITTED` 下直接傳入 pool 是安全的。
- **Tables。** `datafridge_results`、`datafridge_schedule`、`datafridge_quota`、`datafridge_permit` 與 `datafridge_flight`，不帶 schema 前綴，因此會建立在連線 `search_path` 的第一個 schema。內附的 `migrations/0001_datafridge_init.sql` 與 `POSTGRES_SCHEMA` 內容相同。
- **Schema。** 第一次寫入前套用，每個 client 一次，且以單一 statement 逐一檢查物件是否存在再建立：多個 process 同時啟動都會成功，沒有 schema `CREATE` 權限的 role 也能在別人 migrate 好的 tables 上運作。讀取不會建立任何東西；不存在的 table 視為空。執行中被 drop 的 table 會在下一次寫入時重建。若有 schema 工具管理同一個 database 並會刪除它不認得的 tables，請把 `datafridge_*` 排除在外。
- **保真度。** Envelope 以 JSON text 儲存，key 順序與每個字串都原樣保留；時間戳記使用 `DOUBLE PRECISION`，任何 JavaScript number 都能精確保存。
