# API reference

[English](../api.md) | 繁體中文

本文件描述已發布的 Wave 1 API 與已接受的 parameterized-query slice。權威保證以[六點語意契約](./concepts.md#語意契約)為準。

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

`defineQueries(definitions)` 回傳 `Queries` registry。Duration 接受正數 milliseconds，或以 `ms`、`s`、`m`、`h`、`d` 結尾的字串。預設值為 `timeout: '30s'`、`lease: timeout + 30s` 與 `source: 'default'`。

Non-array registry、空白或重複名稱、缺少 fetcher、非法 duration，以及 `timeout >= lease` 都會在建構時拋出 `ConfigError`。Fetcher 會收到：

- `signal`：到達 timeout 時 abort
- `now`：tick 的 epoch milliseconds timestamp
- `attempt`：目前連續失敗次數加一

### Parameterized queries

已接受的 Wave 2 slice 讓有限的 runtime variants 共用同一份 definition：

```ts
const analytics = defineParameterizedQuery({
  name: 'course-analytics',
  every: '10m',
  variants: () => courseIds.flatMap((courseId) =>
    ['7d', '30d'].map((window) => ({ courseId, window })),
  ),
  fetch: ({ params, signal }) => fetchAnalytics(params, { signal }),
})

const queries = defineQueries([analytics])
```

`variants` 可以是 array，或回傳 array 的 synchronous function。每次 `defineQueries` 建構 registry 時都會求值。有限 runtime set 改變時，`PollerDO` 可從 `queries` getter 回傳重新建構的 registry。每個 variant 都有獨立的 schedule row、lease、failure count、backoff 與 result envelope。一般 registry reconcile 會建立新增的 variants，並刪除移除的 variants 與 envelopes。

Params 必須是由有限數字、字串、boolean、null、array 與 plain object 組成的 JSON value。Hash 前會排序 object keys。Cycle、class instance、`undefined` 與非有限數字會在 registry 建構時失敗。Canonical params 相同時會視為 duplicate variant。

`queryKey(name, params?)` 是穩定的 storage identity function。Fixed name 保持不變。Variant identity 使用保留的 `@df/v1/` namespace、encoded public base name，以及 canonical params 的 SHA-256。Raw params 不會出現在 schedule rows、D1 keys 或 `RunReport`。不要把 credential、token 或 private payload 放入 params。Secret 應放在 binding 或 fetcher closure。

不在有限 registry 內的任意 on-demand variants 仍不支援。

### Poller

```ts
const poller = createPoller({
  queries,
  driver,
  store,
  sources: { analytics: { maxPerTick: 2 } },
})

const report = await poller.runDue()
const value = await poller.read<Result>('analytics-7d')
```

`createPoller(config)` 必須提供：

- `queries`：`Queries` registry 或 raw query definitions
- `driver`：`{ serialized, defer(promise), schedule? }`
- `store`：一個同時持有 result envelopes 與 schedule rows 的 store

選用欄位為 `sources`、`clock` 與 `random`。`clock` 和 `random` 供 deterministic adapter 與 test 使用。規則見 [排程那一半從哪來](./writing-adapters.md#排程那一半從哪來建構時就決定)。

Missing 或 malformed driver、缺少任一半的 store、非法 source budget，以及在 non-serialized driver 下無法原子 claim 的 store，都會在建構時被拒絕。

`runDue(now?)` 會 reconcile registry、選擇到期工作、套用 per-source budgets、claim leases、concurrently 執行 fetchers，並回傳：

```ts
interface RunReport {
  ran: string[]
  skippedLeased: string[]
  deferredBudget: string[]
  failed: Array<{ name: string; message: string }>
}
```

成功 refresh 會從完成時間排定下一次執行。失敗會保留舊 envelope，並以有 jitter 的 exponential backoff 重試，上限為 `every`。

`poller.read(name, params?, options?)` 讀 result store。Registry 不存在該 name 或 parameter variant 時會拋錯。

```ts
await poller.read('course-analytics', { courseId: 'course-a', window: '7d' }, {
  swrRefresh: (refresh) => driver.defer(refresh),
})
```

結果 stale 時，`swrRefresh` 會收到一個刷新 promise，而 read 不會等它。Miss 不需要這種交接：讀取自己會去抓。那個 promise 受排程節制：query 沒到期時它什麼都不做，所以流量無法超越失敗上游的 backoff；lease 則讓併發刷新只產生一次上游呼叫。

完全沒有資料的讀取會等第一筆結果，最多等該 query 自己的 `timeout` 那麼久。沒有東西要設定：一個 query，一個「最多多久」的答案。已經有結果時（不論 stale）一律立刻回傳。

Poller 在沒有人持有 lease 時自己抓，有人持有就等那個人，所以同時來多少讀者都只有一次上游呼叫 - 和讓併發 tick 只跑一次的是同一個 lease。Query 正處於 backoff 之間時直接回 `null`，不為一個不會來的東西等待；到達 timeout 時，那次抓取會像在排程 tick 上一樣被 abort 並記為失敗，讀取則回 `null`。

### Reader

Reader 沒有 fetcher，也從不碰排程那一半 - 它唯一呼叫的方法是 `readResult`：

```ts
const reader = createReader({ store, queries })
const fixed = await reader.read<Result>('analytics-7d')
const variant = await reader.read<Result>('course-analytics', {
  courseId: 'course-a',
  window: '7d',
})
```

`queries` 是選填的，而它決定兩件事：registry 之外的名字會拋錯而不是讀成 `null`；以及 miss 時會等那個正在抓的 executor - reader 不能自己抓，但它可以等，最多等該 query 的 `timeout` 那麼久。不給 registry 時，reader 只需要一個 store，這正是它能活在另一個 Worker、另一個服務、另一個語言裡的原因；此時 miss 會立刻回 `null`，因為沒有東西告訴它第一筆資料可能要多久。

結果格式為：

```ts
interface ReadResult<T> {
  data: T
  fetchedAt: number
  isStale: boolean
  age: number
  lastError?: { at: number; message: string; count: number }
}
```

`read()` 只在第一次成功 refresh 前回傳 `null`，絕不呼叫上游。

### Stores 與 test utilities

- `memoryStore()` 回傳 reference full `Store` implementation。
- `storeContractSuite(label, factory)` 從 `@datafridge/core/contract-tests` 匯出，供 Vitest adapter compatibility tests 使用。
- `FakeClock` 與 `flushMicrotasks` 支援 deterministic tests。
- `parseDuration`、`queryKey`、`systemClock`、`ConfigError` 與 `TimeoutError` 是 public utilities。
- Store 與 engine interfaces 都以 TypeScript types 從 package root 匯出。

`@datafridge/core` 沒有 runtime dependency。只有匯入 `@datafridge/core/contract-tests` 時才需要選用的 `vitest` peer。

## `@datafridge/cloudflare`

Runtime exports 都可從 package root 使用，也提供獨立 subpaths：

| Export | Subpath | 用途 |
|---|---|---|
| `PollerDO`, `ensureStarted` | `@datafridge/cloudflare/do` | Durable Object alarm scheduler |
| `d1` | `@datafridge/cloudflare/d1` | D1 store：result envelopes 與 atomic schedule claims |
| `cronDriver`, `cronPoller` | `@datafridge/cloudflare/cron` | Cron Trigger integration |
| `INVOCATION_WALL_CLOCK_LIMIT_MS` | package root | Cloudflare timeout ceiling |

### Durable Object alarms

Subclass `PollerDO<Env>`、提供 `queries` 與 `store(env)`，並可選擇提供 `sources`。Durable Object 把自己的排程簿記放在它的 SQLite storage，所以 store 只有 result 那一半會被用到。

```ts
class Poller extends PollerDO<Env> {
  queries = queries
  sources = { analytics: { maxPerTick: 2 } }

  store(env: Env) {
    return d1(env.DB)
  }

  protected override onRunReport(report: RunReport) {
    logSanitized(report)
  }
}
```

`onRunReport(report)` 是每次 alarm tick 後的選用 operational hook。不要記錄 query payload、credential 或 sensitive error details。Hook 失敗會被 alarm loop 吸收，下一個 alarm 仍會排定。

`ensureStarted(namespace, instanceName?)` 會 idempotently 啟動一個具名 `PollerDO` instance。預設 instance name 是 `datafridge-poller`。

Registry、source budgets 與 Cloudflare timeout ceiling 會在 object 啟動及每次 alarm 前驗證。`timeout` 必須短於 15 分鐘，每個 `maxPerTick` 必須是正整數。

### D1 stores

- `d1(db)` 實作完整的 atomic `Store`：result envelopes，加上以檢查 version 的 `UPDATE` 進行 claim 的 schedule rows，因此在非 serialized driver 下也安全。`PollerDO` 自帶 schedule plane，會直接把 D1 的那一半閒置。

它會在第一次寫入前自己建表，所以 `@datafridge/cloudflare/migrations/0001_datafridge_init.sql` 是可選的；暖 isolate 底下表被刪掉時會重建並重試一次。讀取路徑從不建表 - 還不存在的 result table 讀起來就是 `null`。超過 D1 2,000,000-byte row limit 的寫入會被拒絕，舊資料保持不變。

### Cron Triggers

`cronPoller(config)` 在每次 invocation 內完成 env-dependent store 建構，並回傳 scheduled handler：

```ts
export default {
  scheduled: cronPoller<Env>({
    queries,
    store: (env) => d1(env.DB),
    sources: { analytics: { maxPerTick: 2 } },
  }),
}
```

`onRunReport` 與 `PollerDO` 的 hook 同一份契約：寫 log 前先 sanitize，而拋錯的 hook 會被吸收，不會讓該次 tick 失敗。它會在 module 建構時驗證 query registry、timeout ceiling 與 store shape。需要直接呼叫 `createPoller` 並取得 `RunReport` 時，可使用 lower-level non-serialized `cronDriver(ctx)`。

### Init CLI

Package 會安裝 `datafridge` binary：

```sh
pnpm exec datafridge init --scheduler <durable-object|cron> --store <d1> [--config wrangler.toml]
```

兩個 flag 都是必填：沒有預設配對，而且只會寫出所選組合需要的 declarations - `durable-object` 寫 Durable Object binding 與它的 SQLite class migration，`cron` 寫每分鐘的 `[triggers]`，兩者都加上 D1 binding。既有 declarations 會保留。CLI 只編輯 TOML，若旁邊有 `wrangler.json` 或 `wrangler.jsonc`，則拒絕建立衝突的 TOML file。

完整部署流程見 [Cloudflare 設定與營運](./cloudflare.md)。
