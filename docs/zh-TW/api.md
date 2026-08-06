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

另外兩個選填欄位決定存進去的東西長什麼樣：

```ts
{
  name: 'lesson-engagement',
  every: '15m',
  codec: {
    encode: (v) => ({ rows: [...v.byPath] }),
    decode: (raw) => ({ byPath: new Map(raw.rows) }),
  },
  validUntil: ({ now }) => endOfTodayUtc(now),
  fetch: ...,
}
```

`codec` 在寫入時把抓到的值轉成純 JSON、讀出時轉回來，存 `Map`、`Set`、`Date` 不再需要手寫的中間型別。存的 row 依然是純 JSON - 任何語言都讀得動 - 只有持有 registry 的 reader 會 decode；裸 reader 看到的是編碼後的形式。`encode` 拋錯視為一次 fetch 失敗，保留前一筆結果。

`validUntil` 給那種自己會過期的資料用：「今天的流量」到了午夜就不再是今天的，不管它多新。它回傳那個邊界（epoch ms，收得到 `params` 與 `now`）；邊界存在結果上，過了邊界的讀取回報 `status: 'invalid'` 但照樣給資料，而 scheduler 會在邊界重抓、而不是等完整個週期 - `nextRunAt` 變成 `min(完成時間 + every, validUntil)`。以年齡計的新鮮度（`isStale`）和時間窗的有效性是兩條獨立的軸。

### Parameterized queries

一份 definition 涵蓋一組有限的 variants：

```ts
const analytics = defineParameterizedQuery({
  name: 'course-analytics',
  every: '10m',
  dimensions: {
    window: ['7d', '30d'],
    courseId: async () => listCourseIds(db),
  },
  fetch: ({ params, signal }) => fetchAnalytics(params, { signal }),
})

const queries = defineQueries([analytics])
```

`dimensions` 展開成各項的笛卡兒積，每個 dimension 是 params 的一個欄位；`variants` 則直接列出 params 物件。兩者擇一。無論哪種，每個 variant 都有獨立的 schedule row、lease、failure count、backoff 與 result envelope。

**陣列是靜態的，函式是動態的。** 陣列在建構時展開一次。函式 - 不論是 `variants` 本身，或任何一個 dimension - 在每個 tick 重新解析、可以是 async，清單活在資料庫裡時就用它。Reconcile 會替新出現的 variant 建 row，替離開的 variant 刪掉 row 與結果。解析拋錯時什麼都不會被刪：該 base 保留手上已有的一切，失敗記進那個 tick 的 `RunReport`，名字是 base name。

解析函式和 `fetch` 一樣會拿到 `{ signal }` - `courseId: ({ signal }) => listCourseIds(db, { signal })` - 並受該 base 自己的 `timeout` 節制，所以卡住的清單會被 abort，並視為一次失敗的解析。各個 base 併發解析，一個卡住不會拖累其他。冷讀取時這份額度和等待共用：解析成員身分與等第一筆結果加起來就是一個 `timeout`，不會變成兩個。

讀取 dynamic variant 刻意不對稱：已存的結果直接回、不查清單；只有 miss 才解析 - 為了抓一個成員，或拒絕不是成員的 params。

Params 必須是由有限數字、字串、boolean、null、array 與 plain object 組成的 JSON value。Hash 前會排序 object keys。Cycle、class instance、`undefined` 與非有限數字會在 variant 展開時被拒絕。Canonical params 相同視為 duplicate variant - 靜態清單在建構時擋下，動態清單則成為那個 tick 的失敗。

`queryKey(name, params?)` 是穩定的 storage identity function。Fixed name 保持不變。Variant identity 使用保留的 `@df/v1/` namespace、encoded public base name，以及 canonical params 的 SHA-256。Raw params 不會出現在 schedule rows、D1 keys 或 `RunReport`。不要把 credential、token 或 private payload 放入 params。Secret 應放在 binding 或 fetcher closure。

不在有限 registry 內的任意 on-demand variants 仍不支援。

### Fridge

```ts
const fridge = createFridge({
  queries,
  driver,
  store,
  sources: { analytics: { limit: { requests: 100, per: '1m', reserve: 10 } } },
})

const report = await fridge.runDue()
const value = await fridge.read<Result>('analytics-7d')
```

`createFridge(config)` 必須提供：

- `queries`：`Queries` registry 或 raw query definitions
- `driver`：`{ serialized, defer(promise), schedule? }`
- `store`：一個同時持有 result envelopes 與 schedule rows 的 store

選用欄位為 `sources`、`clock` 與 `random`。`clock` 和 `random` 供 deterministic adapter 與 test 使用。規則見 [排程那一半從哪來](./writing-adapters.md#排程那一半從哪來建構時就決定)。

Missing 或 malformed driver、缺少任一半的 store、非法 source policy，以及在 non-serialized driver 下無法原子 claim 的 store，都會在建構時被拒絕。

`sources` 宣告每個 source 能承受什麼。`limit` 是硬天花板，記在 store 的 quota ledger 裡、由所有 executor 共用；`reserve` 從每個窗口保留一部分不給排程刷新，讓等待中的讀者仍然過得去；`maxConcurrent` 限制單一 instance 在途的呼叫數。見 [rate limiting](./rate-limiting.md)。

`runDue(now?)` 會 reconcile registry、以最過期優先選擇到期工作、對每個 source 的 ledger 計數、claim leases、concurrently 執行 fetchers，並回傳：

```ts
interface RunReport {
  ran: string[]
  skippedLeased: string[]
  throttled: string[]
  failed: Array<{ name: string; message: string }>
}
```

成功 refresh 會從完成時間排定下一次執行。失敗會保留舊 envelope，並以有 jitter 的 exponential backoff 重試，上限為 `every`。

`fridge.read(name, params?)` 讀 result store。Registry 不存在該 name 或 parameter variant 時會拋錯。

```ts
await fridge.read('course-analytics', { courseId: 'course-a', window: '7d' })
```

讀取只有兩種行為，沒有任何選項可以改變它們：

- **有資料** - 立刻回傳，fresh、stale、`invalid` 一律如此，且完全不碰上游。刷新既有資料是 scheduler 的職責，所以讀一筆 stale 結果永遠不會替一個已經在掙扎的上游再加壓。
- **沒資料** - 當下去抓，最多等該 query 自己的 `timeout` 那麼久。沒有東西要設定：一個 query，一個「最多多久」的答案。

Fridge 在沒有人持有 lease 時自己抓，有人持有就等那個人，所以同時來多少讀者都只有一次上游呼叫 - 和讓併發 tick 只跑一次的是同一個 lease。Query 正處於 backoff 之間時直接回 `null`，不為一個不會來的東西等待；到達 timeout 時，那次抓取會像在排程 tick 上一樣被 abort 並記為失敗，讀取則回 `null`。

Source 額度用完時的 miss 回傳第三種 status，而不是 `null` - 因為「還沒輪到你」不等於「沒有這個東西」：

```ts
const result = await fridge.read<Result>('analytics-7d')
if (result?.status === 'throttled') return retryAfter(result.retryAt)
```

`createReader` 永遠不會產生它：reader 沒有 fetcher，它做的事沒有一件會被限流。

### Reader

Reader 沒有 fetcher：回答一次讀取只需要 `readResult`；store 有提供 `readSchedule` 時，miss 會多讀一次排程列，用來分辨「馬上就要落地的抓取」和「已經排到之後的重試」：

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
  status: 'ok' | 'invalid' // 資料自己的時間窗過了就是 'invalid'；資料照樣回傳
  validUntil?: number
  lastError?: { at: number; message: string; count: number }
}
```

`read()` 只在第一次成功 refresh 前回傳 `null`，絕不呼叫上游。

### Stores 與 test utilities

- `memoryStore()` 回傳 reference full `Store` implementation。
- `storeContractSuite(label, factory)` 從 `@datafridge/core/contract-tests` 匯出，供 Vitest adapter compatibility tests 使用。
- `FakeClock` 與 `flushMicrotasks` 支援 deterministic tests。
- `parseDuration`、`queryKey`、`systemClock`、`resolveSources`、`ConfigError`、`TimeoutError` 與 `RateLimitError` 是 public utilities。Adapter 用 `resolveSources` 在自己的建構時就擋下非法的 source policy。
- Store 與 engine interfaces 都以 TypeScript types 從 package root 匯出。

`@datafridge/core` 沒有 runtime dependency。只有匯入 `@datafridge/core/contract-tests` 時才需要選用的 `vitest` peer。

## `@datafridge/cloudflare`

Runtime exports 都可從 package root 使用，也提供獨立 subpaths：

| Export | Subpath | 用途 |
|---|---|---|
| `FridgeDO`, `ensureStarted` | `@datafridge/cloudflare/do` | Durable Object alarm scheduler |
| `d1` | `@datafridge/cloudflare/d1` | D1 store：result envelopes 與 atomic schedule claims |
| `cronDriver`, `cronFridge` | `@datafridge/cloudflare/cron` | Cron Trigger integration |
| `INVOCATION_WALL_CLOCK_LIMIT_MS` | package root | Cloudflare timeout ceiling |

### Durable Object alarms

Subclass `FridgeDO<Env>`、提供 `queries` 與 `store(env)`，並可選擇提供 `sources`。Durable Object 把自己的排程簿記放在它的 SQLite storage，所以 store 只有 result 那一半會被用到。

```ts
class Poller extends FridgeDO<Env> {
  queries = queries
  sources = { analytics: { limit: { requests: 100, per: '1m', reserve: 10 } } }

  store(env: Env) {
    return d1(env.DB)
  }

  protected override onRunReport(report: RunReport) {
    logSanitized(report)
  }
}
```

`onRunReport(report)` 是每次 alarm tick 後的選用 operational hook。不要記錄 query payload、credential 或 sensitive error details。Hook 失敗會被 alarm loop 吸收，下一個 alarm 仍會排定。

`ensureStarted(namespace, instanceName?)` 會 idempotently 啟動一個具名 `FridgeDO` instance。預設 instance name 是 `datafridge`。

Registry、source policies 與 Cloudflare timeout ceiling 會在 object 啟動及每次 alarm 前驗證。`timeout` 必須短於 15 分鐘。

### D1 stores

- `d1(db)` 實作完整的 atomic `Store`：result envelopes，加上以檢查 version 的 `UPDATE` 進行 claim 的 schedule rows，因此在非 serialized driver 下也安全。`FridgeDO` 自帶 schedule plane，會直接把 D1 的那一半閒置。

它會在第一次寫入前自己建表，所以 `@datafridge/cloudflare/migrations/0001_datafridge_init.sql` 是可選的；暖 isolate 底下表被刪掉時會重建並重試一次。讀取路徑從不建表 - 還不存在的 result table 讀起來就是 `null`。超過 D1 2,000,000-byte row limit 的寫入會被拒絕，舊資料保持不變。

### Cron Triggers

`cronFridge(config)` 在每次 invocation 內完成 env-dependent store 建構，並回傳 scheduled handler：

```ts
export default {
  scheduled: cronFridge<Env>({
    queries,
    store: (env) => d1(env.DB),
    sources: { analytics: { limit: { requests: 100, per: '1m', reserve: 10 } } },
  }),
}
```

`onRunReport` 與 `FridgeDO` 的 hook 同一份契約：寫 log 前先 sanitize，而拋錯的 hook 會被吸收，不會讓該次 tick 失敗。它會在 module 建構時驗證 query registry、timeout ceiling 與 store shape。需要直接呼叫 `createFridge` 並取得 `RunReport` 時，可使用 lower-level non-serialized `cronDriver(ctx)`。

### Init CLI

Package 會安裝 `datafridge` binary：

```sh
pnpm exec datafridge init --scheduler <durable-object|cron> --store <d1> [--config wrangler.toml]
```

兩個 flag 都是必填：沒有預設配對，而且只會寫出所選組合需要的 declarations - `durable-object` 寫 Durable Object binding 與它的 SQLite class migration，`cron` 寫每分鐘的 `[triggers]`，兩者都加上 D1 binding。既有 declarations 會保留。CLI 只編輯 TOML，若旁邊有 `wrangler.json` 或 `wrangler.jsonc`，則拒絕建立衝突的 TOML file。

完整部署流程見 [Cloudflare 設定與營運](./cloudflare.md)。
