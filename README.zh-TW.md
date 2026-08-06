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
          │ read() - 一次本地查詢，永遠不等上游
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

定義你想 poll 的內容：

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

誰定時去抓，以及資料放哪。

**誰定時去抓**

- `PollerDO` - 用 Cloudflare Durable Object 當排程，到期時間精確。
- `cronPoller` - 用 Cloudflare Cron Trigger 當排程，最細一分鐘。

**資料放哪**

- `d1(env.DB)` - 放進你的 D1。

兩邊可自由搭配，也都可以換成你自己的實作。

## 完整範例

`PollerDO` 當 scheduler、`d1` 當 store，加上一個負責讀取的 route：

```ts
import { createReader, defineQueries } from '@datafridge/core'
import { d1, ensureStarted, PollerDO } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
}

export class Poller extends PollerDO<Env> {
  queries = defineQueries([
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

  store(env: Env) {
    return d1(env.DB)
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    await ensureStarted(env.POLLER)
    const reader = createReader({ store: d1(env.DB) })
    return Response.json(await reader.read('weekly-summary'))
  },
}
```

Durable Object 在這裡的身分是 scheduler：用 alarm 喚醒自己、執行每個 tick 到期的 query 且兩個 tick 永不重疊、把 schedule 簿記放在自己的 SQLite。Envelope 寫進你的 D1。讀取本身直接查 D1，完全不經過 Durable Object - 你的 handler 與那一列資料之間，沒有 scheduler、沒有鎖、也沒有 coordinator。

`ensureStarted()` 是便宜且 idempotent 的 RPC，也是上面範例中唯一一次 Durable Object 呼叫。它第一次會點燃 alarm chain，部署後會重新點燃，所以在讀取路由上 await 它完全沒問題。若想讓 request path 完全不碰它，就別 await，改交給 handler 的 `ExecutionContext`：`ctx.waitUntil(ensureStarted(env.POLLER))`，或改在部署後的 hook 呼叫。它也會察覺 registry 的變動：下一個 tick 會替新增的 query 建立 row，並把刪掉的 query 連 row 與 envelope 一起移除。

第一次讀取會回 `null`，因為還沒 fetch 過任何東西。第一次成功刷新之後，每次讀取都會有資料。

這個 Worker 需要的 infra - `wrangler` 宣告、`datafridge init` scaffold、package 內附的 D1 schema、Cron Trigger 設定，以及營運 checklist - 都在 [docs/zh-TW/cloudflare.md](./docs/zh-TW/cloudflare.md)。

[`examples/cloudflare-basic`](./examples/cloudflare-basic) 就是這套設定的可執行版本，在 `wrangler dev` 下輪詢一個故意做慢的假 API。

## 讀取結果

Reader 只需要一個 result store，沒有 fetcher、也沒有 schedule，所以你可以把它放在另一個 Worker、另一個服務，甚至完全不用 TypeScript：envelope 就是純 JSON row。

```ts
const result = await createReader({ store: d1(env.DB) }).read<Summary>('weekly-summary')
```

```ts
{ data: Summary, fetchedAt: number, isStale: boolean, age: number, lastError?: { at, message, count } } | null
```

- `fetchedAt` 是資料實際被抓下來的時間，epoch 毫秒。
- `age` 是它此刻多舊，讓你套用自己的門檻（「超過兩小時就顯示警告」）。
- `age` 超過該 query 的 `every` 之後，`isStale` 為 `true`。它只是標籤、從不阻擋：stale 資料一樣立即回傳，跟 fresh 資料完全一樣。
- `null` 代表那個 key 底下沒有 envelope。通常是第一次成功刷新還沒落地，但名稱拼錯、或傳入一組沒有註冊過的 params，同樣會讀到 `null`，因為 reader 身上沒有 registry 可以拿來核對名稱。

如果同一個 process 裡已經有 poller，就用 `poller.read(name, options)`：它讀同一個 store，並且會額外拒絕 registry 之外的名稱。

## 上游失敗時

什麼都不會被丟掉。刷新失敗會保留先前的 envelope、把 `lastError` 附在上面，並以帶 jitter 的 exponential backoff 重排：`min(every, 1m * 2^(failCount - 1))`。上限收在 `every`，因為重試得比正常間隔還慢對誰都沒好處。一次成功就把計數歸零。

| 發生了什麼 | Scheduler 怎麼做 | `read()` 回什麼 |
|---|---|---|
| 上游錯誤或 timeout | 記錄失敗、backoff、保留舊 envelope | 舊資料、`isStale`、`lastError` |
| Executor 執行到一半暴斃 | 租約過期後由另一個 tick 重新 claim | 舊資料、`isStale` |
| Zombie 遲到寫回 | Version 不符，寫入被拒 | 不受影響 |
| 被 source budget 擠掉 | 保持到期，下個 tick 優先度提高 | 舊資料，稍微舊一點 |
| 連續失敗數小時 | Backoff 收斂在 `every`，永久保留 last-known-good | 舊資料、`lastError` |
| 從未成功 fetch 過 | 依排程持續嘗試 | `null` |

支撐這一切的是三道各自獨立的關卡：`nextRunAt` 決定「該不該跑」、lease 決定「誰在跑」、version 決定「誰的結果算數」。慢速 fetch、暴斃的 executor、zombie 寫回各自打穿一關，下一關接住。

每個 tick 回傳一份 `RunReport`：`{ ran, skippedLeased, deferredBudget, failed }`。在 `PollerDO` subclass 上 override `onRunReport(report)` 就能記錄它 - 只記數量與允許清單內的名稱，因為錯誤訊息來自你的 fetcher，可能帶有上游細節。

## 同一個 query 的 preset variants

當同一個 fetch 適用於一組有限、且在部署時就已知的維度（course ID、preset 時間窗），宣告一次就好，不必自己寫迴圈：

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

每個 variant 都會變成一筆普通、獨立的 registry entry，各自擁有 schedule、lease、backoff、失敗計數與 envelope。新增或移除 variant 的 reconcile 行為，與新增或移除 named query 完全一樣。

Params 是身分，不是儲存空間。它們在建構時被快照，必須是有限的 JSON（object key 順序不影響結果），並被雜湊成 `@df/v1/<base-name>/<sha256>` 的 storage key - 所以原始參數值不會出現在 D1 key 或 `RunReport` 裡。永遠不要把 credential 放進去；secret 的家是 binding 與 fetcher closure。

只有 registry 內的有限 variant 會被排程與讀取。任意的 on-demand variant 不會在 read 時被建立。

## 依 source 做 rate limiting

替 query 標上 `source`，並限制該群組每個 tick 最多跑幾個：

```ts
export default {
  scheduled: cronPoller<Env>({
    queries,
    store: (env) => d1(env.DB),
    sources: { posthog: { maxPerTick: 2 } },
  }),
}
```

同樣的 `sources` 欄位也能當作 `PollerDO` subclass 的 property。它是無狀態的，所以在併發 executor 之間依然正確，而且給你一個硬上限：不論你註冊多少 query，上游呼叫都不會超過 `maxPerTick × tick 頻率`。被預算擠掉的 query 會保持到期，而且每等一個 tick 優先度就上升，因為優先度看的是過期*比例* `(now - nextRunAt) / every` 而非絕對遲到時間。沒有人會餓死。

Jitter 是另外一半：第一次註冊時會替每個 query 的 `nextRunAt` 加上隨機偏移，所以 `5m`、`10m`、`1h` 的 query 不會永遠對齊在同一個 tick、一次擠爆同一個 source。預算是保險絲，jitter 讓保險絲平常不用燒。

## 文件

- [API reference](./docs/zh-TW/api.md)
- [概念與失敗語意](./docs/zh-TW/concepts.md)
- [Cloudflare 設定與營運](./docs/zh-TW/cloudflare.md)
- [Rate limiting](./docs/zh-TW/rate-limiting.md)
- [撰寫 adapters](./docs/zh-TW/writing-adapters.md)
- [Release 流程與 package 名稱](./docs/zh-TW/releasing.md)
- [可執行的 Cloudflare 範例](./examples/cloudflare-basic)

## License

[MIT](./LICENSE)
