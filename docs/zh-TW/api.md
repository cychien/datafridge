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

`queryKey(name, params?)` 是穩定的 storage identity function。Fixed name 保持不變。Variant identity 使用保留的 `@df/v1/` namespace、encoded public base name，以及 canonical params 的 SHA-256。Raw params 不會出現在 D1 keys 或 `RunReport`；variant 的 schedule row 則會用一個獨立欄位把它們存在 hash 過的名字旁邊。不要把 credential、token 或 private payload 放入 params。Secret 應放在 binding 或 fetcher closure。

### 開放的 parameter 空間

有些 parameter 空間太大或太開放，列不出來。`anyParams` 完全不宣告清單：任何 params 都接受，而讀它就是一次全新的呼叫。

```ts
const funnel = defineParameterizedQuery({
  name: 'course-funnel',
  anyParams: true,
  timeout: '20s',
  source: 'posthog',
  fetch: ({ params, signal }) => fetchFunnel(params, { signal }),
})
```

`variants`、`dimensions`、`anyParams` 三者擇一。

**是不是一個 entry，由 registry 決定，永遠不由「剛好有人問了」決定。** Registry 指名的 parameter 組合 - 寫在 `variants`、由 `dimensions` 展開、或由 dynamic 清單回傳的 - 是持久的排程 entry，有自己的 row、lease、backoff 與已儲存的結果。Registry 沒有指名的組合就不是 entry，讀它不會存下任何東西：沒有結果、沒有 schedule row、沒有成員資格。它是一次呼叫，也就照呼叫來回答。

那次呼叫一樣從所有東西共用的那個 dispatcher 出去，所以它會扣 source 的窗口（含等待中的讀者應得的 reserve）、遵守 `maxConcurrent`、受 base 自己的 `timeout` 約束，也認得 `RateLimitError`。

**重疊的讀取仍然會合流。** 同一個 `queryKey` 的第一個讀者發出呼叫；在它還在跑的時候抵達的每一個讀者都加入那個 flight，並拿走它的答案。一百個同時進來的請求就是一次上游呼叫、一格額度，不管它們落在幾個 Worker 上 - flight 協調在 store 裡，不在某個 process 的記憶體裡。在那個 flight 結束**之後**才抵達的讀取，是一個新的 flight、一次新的呼叫：答案屬於等它的那批讀者，把它交給下一個來問的人就會變成快取，而那正是未指名組合不該有的東西。

- **它永遠不會被排程。** Open base 對 tick 沒有任何貢獻，所以它不宣告 `every`、`lease` 或 `validUntil`；什麼都不存，所以也不吃 `codec`。這四個只要屬性存在就在建構時被拒絕 - 包含明確寫成 `undefined` 的情況 - 與 `anyParams` 並列的清單，以及不是 `true` 的 `anyParams`，同樣如此。
- **Flight 是暫時的。** 它不存結果、會自己過期，並由下一個 tick 清掉。Leader 死了之後，過了它的期限就由下一個讀者接手；已結束的答案在那批讀者拿到後不久就不再被交出去。
- **讀取必須帶 params。** 沒有 params 的 open base 什麼組合都沒指名。
- **Reader 必須有能力發出那次呼叫。** `createReader` 需要完整的 store - 能 claim、能計額度的那種，例如 `d1(env.DB)` - 不能是 results-only。這在建構 reader 時就檢查，不是等到有人來讀。
- **呼叫失敗回 `null`**，而且不留下 backoff，因為沒有東西可以讓 backoff 掛上去。希望失敗被記住時，請改用宣告過的 variant。

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
- `driver`：`{ serialized, defer(promise), schedule?, budgetMs? }`
- `store`：一個同時持有 result envelopes 與 schedule rows 的 store

選用欄位為 `sources`、`clock` 與 `random`。`clock` 和 `random` 供 deterministic adapter 與 test 使用。規則見 [排程那一半從哪來](./writing-adapters.md#排程那一半從哪來建構時就決定)。

單一 tick 要做多少事，沒有旋鈕可調。一個 tick 讀一頁有界的 row、先做最過期的、只在某次呼叫自己的 `timeout` 還塞得進 invocation 的 `budgetMs`、而且它的 source 這個 tick 還沒拒絕過時才放行，其餘原封不動留著。分頁大小是實作細節，刻意不開放設定；約束一個 tick 的是你早就宣告過的那些東西 - `every`、`timeout`、`limit`、`reserve`、`maxConcurrent` - 再加上 driver 回報的 wall clock。

Missing 或 malformed driver、缺少任一半的 store、非法 source policy，以及在 non-serialized driver 下無法原子 claim 的 store，都會在建構時被拒絕。

`sources` 宣告每個 source 能承受什麼。`limit` 是硬天花板，記在 store 的 quota ledger 裡、由所有 executor 共用；`reserve` 從每個窗口保留一部分不給排程刷新，讓等待中的讀者仍然過得去；`maxConcurrent` 限制所有共用這個 store 的 executor 同時在途的呼叫數。見 [rate limiting](./rate-limiting.md)。

`runDue(now?)` 會 reconcile registry、以最過期優先選擇到期工作、對每個 source 的 ledger 計數、claim leases、concurrently 執行 fetchers，並回傳：

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

`throttled` 是 source 的窗口，`deferred` 是這次 invocation 承接不了的其他一切 - 剩餘的 wall clock，或該 source 的併發上限。兩者都讓 row 維持原樣，所以兩者都只是更過期地回來，不會遺失，而且兩者都會餵給 `nextRunAt`：天花板會說出自己何時可能鬆開，用完 wall clock 則是請求下一次 invocation。`nextRunAt` 是這個 fridge 下一次有工作的時間，由該 tick 手上既有的 row 算出來 - 自己排喚醒的 driver 用它，而不必再問一次 storage；`null` 代表根本沒有任何排程。

成功 refresh 會從完成時間排定下一次執行。失敗會保留舊 envelope，並以有 jitter 的 exponential backoff 重試，上限為 `every`。

`fridge.read(name, params?)` 讀 result store。Registry 不存在該 name 或 parameter variant 時會拋錯。

```ts
await fridge.read('course-analytics', { courseId: 'course-a', window: '7d' })
```

讀取只有兩種行為，沒有任何選項可以改變它們：

- **有資料** - 立刻回傳，fresh、stale、`invalid` 一律如此，且完全不碰上游。刷新既有資料是 scheduler 的職責，所以讀一筆 stale 結果永遠不會替一個已經在掙扎的上游再加壓。
- **沒資料** - 當下去抓，最多等該 query 自己的 `timeout` 那麼久。沒有東西要設定：一個 query，一個「最多多久」的答案。

Fridge 在沒有人持有 lease 時自己抓，有人持有就等那個人，所以同時來多少讀者都只有一次上游呼叫 - 和讓併發 tick 只跑一次的是同一個 lease。Query 正處於 backoff 之間時直接回 `null`，不為一個不會來的東西等待；到達 timeout 時，那次抓取會像在排程 tick 上一樣被 abort 並記為失敗，讀取則回 `null`。

Source 額度用完 - 或者它的呼叫全都已經在途 - 時的 miss 回傳第三種 status，而不是 `null`，因為「還沒輪到你」不等於「沒有這個東西」：

```ts
const result = await fridge.read<Result>('analytics-7d')
if (result?.status === 'throttled') return retryAfter(result.retryAt)
```

持有完整 store 的 reader 也一樣會回傳它，因為那是同一條讀取路徑。

### Reader

```ts
const reader = createReader({ store, queries, sources, defer })
const fixed = await reader.read<Result>('analytics-7d')
const variant = await reader.read<Result>('course-analytics', {
  courseId: 'course-a',
  window: '7d',
})
```

`store` 決定一個 reader 被允許做什麼，而它有兩種。

**Results-only store** - 有 `readResult`、以及可有可無的 `readSchedule` - 造出一個只會「給」與「等」的 reader。命中就立刻回答；miss 則等那個正在抓的 executor，而有 `readSchedule` 時它能分辨「馬上要落地的抓取」與「已經排到之後的重試」，因此不會白等一段 backoff。這就是能活在另一個 Worker、另一個服務、另一個語言裡的那個 reader。

**完整的 store** - 能 claim、能計額度的那種，例如 `d1(env.DB)` - 造出一個還能自己抓的 reader，走的是 tick 走的同一個 dispatcher。Miss 會在同一個 lease 後面合流、扣同一個 source 窗口，並留下同樣一筆普通的 entry；`anyParams` 的讀取則以一次全新呼叫回答。這就是讓 request path 能自己成立的東西：迴圈裡沒有 scheduler，也沒有 singleton 要排隊。因為它現在會被限流，它的讀取也可能回 `status: 'throttled'`。

`queries` 是選填的，而它決定兩件事：registry 之外的名字會拋錯而不是讀成 `null`；以及 miss 知道自己最多能花多久。不給它時，reader 只需要一個 store，miss 會立刻回 `null`，因為沒有東西告訴它第一筆資料可能要多久。`sources` 宣告這個 reader 自己發出的呼叫要遵守的天花板，而 `defer`（Workers 上是 `ctx.waitUntil`）是那些活得比答案久的抓取去完成的地方。

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

`read()` 只在什麼都還沒存下來時回傳 `null` - 第一次成功 refresh 之前，或失敗的 query 還在兩次重試之間。Results-only reader 絕不呼叫上游；持有完整 store 的那個則走 tick 走的同一個 dispatcher 自己抓，所以它的 miss 也可能回 `status: 'throttled'`。

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

Subclass `FridgeDO<Env>`、提供 `queries` 與 `store(env)`，並可選擇提供 `sources`。Durable Object 自己不留任何協調狀態：schedule row、lease、quota ledger、permit、flight 與 result 全都住在你給它的 store 裡，它自己的 SQLite 只有一列，記著它上次是為哪一份 registry 點的火。它只負責調度 alarm，除此之外什麼都不做。

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

- `d1(db)` 實作完整的 atomic `Store`：result envelopes，加上以檢查 version 的 `UPDATE` 進行 claim 的 schedule rows，因此在非 serialized driver 下也安全。它就是整個協調平面 - `FridgeDO`、cron trigger，以及任意多個對著同一份 `d1(env.DB)` 的 request path reader，共用它的 row、lease、quota ledger、permit 與 flight。

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
