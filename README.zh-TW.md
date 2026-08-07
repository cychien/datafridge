<h1 align="center">datafridge</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@datafridge/core"
    ><img
      alt="@datafridge/core on npm"
      src="https://img.shields.io/npm/v/%40datafridge%2Fcore?style=flat-square&label=%40datafridge%2Fcore"
  /></a>
  <a href="https://www.npmjs.com/package/@datafridge/cloudflare"
    ><img
      alt="@datafridge/cloudflare on npm"
      src="https://img.shields.io/npm/v/%40datafridge%2Fcloudflare?style=flat-square&label=%40datafridge%2Fcloudflare"
  /></a>
  <a href="https://github.com/cychien/datafridge/actions/workflows/ci.yml"
    ><img
      alt="CI"
      src="https://img.shields.io/github/actions/workflow/status/cychien/datafridge/ci.yml?branch=main&style=flat-square&label=ci"
  /></a>
</p>

<h3 align="center">資料隨時拿取，穩定可靠</h3>

<p align="center"><a href="./README.md">English</a> · <strong>繁體中文</strong></p>

當我們的系統依賴第三方資料，很容易因為第三方來源不穩，使得我們系統看起來不可靠。

這些不穩包括回應慢、資料時有時無、使用量一大或呼叫太頻繁就撞上 rate limit 等，一旦 user 遇到這些問題，而我們系統又沒處理時，user 就會抱怨我們。

datafridge 幫你處理這件事。你只需要註冊一次 query，設定 scheduler、result store，以及抓取頻率和 rate limit 這類 metadata，背景的 scheduler 就會定期把最新的第三方資料寫進你自己的資料庫。

整個 library 就是一個承諾：**你的 app 要資料的時候，永遠拿得到。** 不一定是最新的 - 但永遠有，而且在上游允許的範圍內盡可能新。

```
   scheduler tick（Durable Object alarm 或 cron）
        │
        ▼
   ┌──────────────┐   fetch   ┌──────────────┐
   │ your fetcher │ ────────► │ upstream API │   慢 · 限流 · 不穩
   └──────┬───────┘           └──────────────┘
          │ { data, fetchedAt }        失敗時：保留最後一筆成功值、
          ▼                            記錄錯誤、以 backoff 重試
   ┌─────────────────────────────────────────────┐
   │ your store                                  │
   └──────┬──────────────────────────────────────┘
          │ read() - 一次本地查詢
          ▼
   { data, fetchedAt, isStale, age }
```

`@datafridge/core` 是引擎：純邏輯，零 runtime 依賴。`@datafridge/cloudflare` 是 adapter package，讓它能使用 Cloudflare infra 例如 Durable Object alarms、Cron Triggers 或 D1。

## 安裝

```sh
npm install @datafridge/core @datafridge/cloudflare
# 或：pnpm add @datafridge/core @datafridge/cloudflare
```

兩個 package 都只提供 ESM，開發工具需要 Node.js 20 以上。

## 定義 query

```ts
import { defineQueries } from '@datafridge/core'

const queries = defineQueries([
  {
    name: 'weekly-summary',
    timeout: '30s',            // 選填，預設 30s，超過時間會終止 fetch
    lease: '1m',               // 選填，預設 timeout + 30s
    source: 'default',         // 選填，預設 'default'，rate limit 的分組單位
    every: '10m',
    fetch: async ({ signal }) => {
      const response = await fetch('https://api.example.com/weekly-summary', { signal })
      if (!response.ok) throw new Error(`upstream status ${response.status}`)
      return response.json()
    },
  },
])
```

## 接上 scheduler 與 store

**scheduler**

- `FridgeDO` - 用 Cloudflare Durable Object 當排程，到期時間精確。
- `cronFridge` - 用 Cloudflare Cron Trigger 當排程，最細一分鐘。

**store**

- `d1(env.DB)` - 放進你的 D1。

兩邊可自由搭配，也可以自訂義 adapters。

## 初始化

```sh
npx --no-install datafridge init --scheduler durable-object --store d1
# 或：--scheduler cron --store d1
```

Scheduler：`durable-object`、`cron`。Store：`d1`。平台指南：[Cloudflare](./docs/zh-TW/cloudflare.md)。

## 完整範例

`FridgeDO` 當 scheduler、`d1` 當 store，加上一個負責讀取的 route：

```ts
import { createReader, defineQueries } from '@datafridge/core'
import { d1, ensureStarted, FridgeDO } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
}

const queries = defineQueries([
  {
    name: 'weekly-summary',
    every: '10m',
    fetch: async ({ signal }) => {
      const response = await fetch('https://api.example.com/weekly-summary', { signal })
      if (!response.ok) throw new Error(`upstream status ${response.status}`)
      return response.json()
    },
  },
])

export class Poller extends FridgeDO<Env> {
  queries = queries

  store(env: Env) {
    return d1(env.DB)
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    await ensureStarted(env.POLLER)
    const reader = createReader({ store: d1(env.DB), queries })
    return Response.json(await reader.read('weekly-summary'))
  },
}
```

`ensureStarted()` 負責啟動 scheduler (只有 durable-object scheduler 需要) - 沒有這行不會有任何 tick。讀取則直接查 D1。

[`examples/cloudflare-basic`](./examples/cloudflare-basic) 是可以跑的版本，在 `wrangler dev` 下輪詢一個故意做慢的假 API。

## 讀取結果

```ts
const reader = createReader({ store: d1(env.DB), queries })
const result = await reader.read<Summary>('weekly-summary')
```

`queries` 是選填的。

```ts
{ data: Summary, fetchedAt, isStale, age, status: 'ok' | 'invalid', validUntil?, lastError? } | null
```

- `fetchedAt` 是資料實際被抓下來的時間，epoch 毫秒。
- `age` 是它此刻多舊，讓你套用自己的門檻（「超過兩小時就顯示警告」）。
- `age` 超過該 query 的 `every` 之後，`isStale` 為 `true`。它只是標籤、從不阻擋：stale 資料一樣立即回傳，跟 fresh 資料完全一樣。
- `null` 代表什麼都沒有、而且在時間內也沒等到：上游失敗了，或正在重試之間。沒有給 `queries` 時，冷讀取和拼錯的名字也都會讀到 `null`，因為 reader 沒有 registry 可以參照。

## 上游失敗時

什麼都不會被丟掉。刷新失敗會保留先前的 cache、把 `lastError` 附在上面，並以帶 jitter 的 exponential backoff 重排：`min(every, 1m * 2^(failCount - 1))`。

| 發生了什麼 | Scheduler 怎麼做 | `read()` 回什麼 |
|---|---|---|
| 上游錯誤或 timeout | 記錄失敗、backoff、保留舊結果 | 舊資料、`isStale`、`lastError` |
| Executor 執行到一半暴斃 | 租約過期後由另一個 tick 重新 claim | 舊資料、`isStale` |
| Zombie 遲到寫回 | Version 不符，寫入被拒 | 不受影響 |
| 被 source 的 rate limit 擠掉 | 保持到期，下個 tick 優先度提高 | 舊資料，稍微舊一點 |
| 連續失敗數小時 | Backoff 收斂在 `every`，永久保留 last-known-good | 舊資料、`lastError` |
| 從未成功 fetch 過 | 依排程持續嘗試 | `null` |

## 同一個 query 的 preset variants

當同一個 fetch 適用於一組有限的維度（course ID、preset 時間窗），宣告一次就好，不必自己寫迴圈。陣列在建構時展開；函式每個 tick 重新解析、可以是 async，清單放在你的資料庫裡也行：

```ts
import { defineParameterizedQuery, defineQueries } from '@datafridge/core'

const courseAnalytics = defineParameterizedQuery({
  name: 'course-analytics',
  every: '10m',
  source: 'posthog',
  variants: () =>
    courseIds.flatMap((courseId) => ['7d', '30d', '90d'].map((window) => ({ courseId, window }))),
  fetch: ({ params, signal }) => queryPostHogPreset(params, { signal }),
})

const queries = defineQueries([courseAnalytics])
const result = await reader.read('course-analytics', { courseId: 'course-a', window: '30d' })
```

每個 variant 都會變成一筆普通、獨立的 registry entry，各自擁有 schedule、lease、backoff、失敗計數與自己存下來的結果。新增或移除 variant 的 reconcile 行為，與新增或移除 named query 完全一樣。

## 大到列不完的 parameter 空間

Parameter 空間開放到列不完時 - 任何自訂日期區間、任何一門課 - 用 `anyParams` 直接取代清單：

```ts
const funnel = defineParameterizedQuery({
  name: 'course-funnel',
  anyParams: true,
  timeout: '20s',
  source: 'posthog',
  fetch: ({ params, signal }) => fetchFunnel(params, { signal }),
})
```

是不是一個 entry，由 registry 決定，永遠不由「剛好有人問了」決定。Registry 指名的 params 是有 row、有 lease、有已儲存結果的排程 entry。它沒有指名的 params 則以一次全新呼叫回答 - 走同一個 dispatcher，所以同樣的 source 天花板、reserve、併發與 timeout 都適用 - 而且什麼都不存：沒有結果、沒有 row，也沒有你沒要求過的 polling。

這就是你做的取捨。宣告過的 variant 由我們替你保持在最新；開放的那種則是你問了才抓，每次都是一次呼叫。見[開放的 parameter 空間](./docs/zh-TW/api.md#開放的-parameter-空間)。

## 依 source 做 rate limiting

替 query 標上 `source`，並說明那個 source 能承受什麼：

```ts
export default {
  scheduled: cronFridge<Env>({
    queries,
    store: (env) => d1(env.DB),
    sources: {
      posthog: {
        limit: { requests: 100, per: '1m', reserve: 10 },
        maxConcurrent: 4,
      },
    },
  }),
}
```

`limit` 是真的在數，不是啟發式：store 為每個 source 保留一列 ledger，每次呼叫都用與 claim lease 同一套 version-checked CAS 遞增它，所以兩個 Worker 和一個 Durable Object 只要指向同一個資料庫，就共用同一份額度。所有上游呼叫都走它 - 排程刷新與「讀取時發現沒資料」的抓取吃的是同一個窗。

`reserve` 從每個窗口保留一部分不給排程刷新，否則剛好落在窗口邊界的 tick 會在第一秒把整分鐘花光，讓背後有真人的讀者什麼都拿不到。被擠掉的 query 會保持到期，而且每等一個 tick 優先度就上升，因為優先度看的是過期*比例* `(now - nextRunAt) / every` 而非絕對遲到時間。沒有人會餓死。

Jitter 是另外一半：第一次註冊時會替每個 query 的 `nextRunAt` 加上隨機偏移，所以 `5m`、`10m`、`1h` 的 query 不會永遠對齊在同一個 tick、一次擠爆同一個 source。Ledger 是保險絲，jitter 讓保險絲平常不用燒。

`maxConcurrent`、`throttled` 這個讀取狀態，以及用 `RateLimitError` 把供應商自己的 `Retry-After` 帶回來，見 [rate limiting](./docs/zh-TW/rate-limiting.md)。

## 文件

- [API reference](./docs/zh-TW/api.md)
- [概念與失敗語意](./docs/zh-TW/concepts.md)
- [Cloudflare 設定與營運](./docs/zh-TW/cloudflare.md)
- [Rate limiting](./docs/zh-TW/rate-limiting.md)
- [撰寫 adapters](./docs/zh-TW/writing-adapters.md)
- [可執行的 Cloudflare 範例](./examples/cloudflare-basic)

## License

[MIT](./LICENSE)
