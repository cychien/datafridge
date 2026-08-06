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

<h3 align="center">資料的冰箱。永遠有貨，而且都標好日期。</h3>

<p align="center"><a href="./README.md">English</a> · <strong>繁體中文</strong></p>

你有一個頁面要呼叫第三方 analytics API。順的時候四秒，而且對方有 rate limit，你不可能每個訪客都打一次。所以你加了 cache，結果每次過期後的第一個訪客都得吞下那四秒。接著上游掛掉，一個數字一小時內根本不會怎麼變的頁面，就這樣噴了錯誤。

datafridge 把這件事反過來做。你只註冊一次 query，給它一個名字和一個間隔。背景的 scheduler 定期刷新，把結果寫進你自己的資料庫。你的 request handler 只做一次本地讀取，不管上游是快、是慢、被限流還是整個掛掉，成本都一樣。`bentocache`、`cachified` 這類 cache library 是 request-triggered：沒人來讀就不會刷新，所以總得有人付那筆延遲。datafridge 照排程刷新，所以沒有人要付。

- **讀取永遠不等上游。** `read()` 只碰你的 result store，沒有別的。不存在「第一個請求替所有人付延遲」的冷啟動。
- **每次讀取都有日期。** `fetchedAt`、`age`、`isStale` 跟資料一起回來，「多舊算太舊」由你決定，不必用猜的。
- **上游的 outage 不是你的 outage。** 刷新失敗會保留最後一筆成功值，並把錯誤記在旁邊。頁面照常渲染。
- **Rate limit 是一個設定欄位。** 用 `source` 分組、限制每個 tick 最多跑幾個，不管你註冊了多少 query，這個上限都成立。
- **設定寫錯在建構時就炸，而不是半夜三點。** timeout 比 lease 長、名稱重複、scheduler 的簿記無處可放，全部在你建立 poller 的當下就報錯。

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
   │ your store (D1)                             │
   └──────┬──────────────────────────────────────┘
          │ read() - 一次本地查詢，永遠不等上游
          ▼
   { data, fetchedAt, isStale, age }
```

`@datafridge/core` 是引擎：純邏輯、時鐘注入、零 runtime 依賴。`@datafridge/cloudflare` 是 adapter package，讓它跑在 Durable Object alarms、Cron Triggers 與 D1 上。Fetcher 永遠是你的 code，datafridge 不會代替你去跟任何 vendor 講話。

## 安裝

```sh
pnpm add @datafridge/core @datafridge/cloudflare
# 或：npm install @datafridge/core @datafridge/cloudflare
```

兩個 package 都只提供 ESM，開發工具需要 Node.js 20 以上。Worker code 跑在 Cloudflare Workers runtime。

## 設定就是一個陣列

一個 query 就是一個名字、一個間隔，加上一個負責 fetch 的 function。這就是全部的設定面：

```ts
import { defineQueries } from '@datafridge/core'

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
```

`every` 接受 `'30s'`、`'10m'`、`'1h'`、`'1d'` 或毫秒數字。`signal` 會在 timeout（預設 30 秒）時 abort，所以卡住的上游不會永久佔住一個名額。在 `fetch` 裡 throw，stale-if-error 就會接手。

每個 query 可選的欄位：`timeout`、`lease`、`source`。接下來的一切，都只是把這個陣列接到 scheduler 與 store 上。

## Cloudflare quick start

三個步驟：宣告 infrastructure、套用 schema、寫 Worker。

**1. Scaffold wrangler 宣告。**

```sh
pnpm exec datafridge init cloudflare
# npm：npx --no-install datafridge init cloudflare
```

這會把 Durable Object binding、SQLite class migration、一分鐘的 Cron Trigger 與 D1 binding 寫進 `wrangler.toml`。它是 idempotent 的，不會改寫你已有的宣告，也拒絕在既有的 `wrangler.json` 或 `wrangler.jsonc` 旁邊建立 TOML（這時它會把宣告印出來讓你自己放）。要指定別的檔案就用 `--config path/to/wrangler.toml`。它會把兩種組合都 scaffold 出來；保留你要用的那組，刪掉另一組。

組合 A 只需要其中三段，短到可以自己手寫：

```toml
[[durable_objects.bindings]]
name = "POLLER"
class_name = "Poller"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Poller"]

[[d1_databases]]
binding = "DB"
database_name = "datafridge"
database_id = "..."
```

`class_name` 必須與你的 Worker 匯出的 `PollerDO` subclass 名稱一致。`database_id` 是 CLI 唯一填不了的欄位（它會寫成 `TODO`）：執行 `pnpm exec wrangler d1 create datafridge`，或選一個既有的 database，把它印出來的 ID 貼進去。

**2. 套用 package 內附的 D1 schema。**

```sh
pnpm exec wrangler d1 execute YOUR_DATABASE --remote \
  --file node_modules/@datafridge/cloudflare/migrations/0001_datafridge_init.sql
```

**3. 寫 Worker。**

```ts
import { createReader, defineQueries } from '@datafridge/core'
import { d1Results, ensureStarted, PollerDO } from '@datafridge/cloudflare'

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

Durable Object 在這裡的身分是 scheduler：用 alarm 喚醒自己、執行每個 tick 到期的 query 且兩個 tick 永不重疊、把 schedule 簿記放在自己的 SQLite。Envelope 寫進你的 D1。讀取本身直接查 D1，完全不經過 Durable Object - 你的 handler 與那一列資料之間，沒有 scheduler、沒有鎖、也沒有 coordinator。

`ensureStarted()` 是便宜且 idempotent 的 RPC，也是上面範例中唯一一次 Durable Object 呼叫。它第一次會點燃 alarm chain，部署後會重新點燃，所以在讀取路由上 await 它完全沒問題。若想讓 request path 完全不碰它，就別 await，改交給 handler 的 `ExecutionContext`：`ctx.waitUntil(ensureStarted(env.POLLER))`，或改在部署後的 hook 呼叫。它也會察覺 registry 的變動：下一個 tick 會替新增的 query 建立 row，並把刪掉的 query 連 row 與 envelope 一起移除。

第一次讀取會回 `null`，因為還沒 fetch 過任何東西。第一次成功刷新之後，每次讀取都會有資料。

[`examples/cloudflare-basic`](./examples/cloudflare-basic) 就是這套設定的可執行版本，在 `wrangler dev` 下輪詢一個故意做慢的假 API。

## 讀取結果

Reader 只需要一個 result store，沒有 fetcher、也沒有 schedule，所以你可以把它放在另一個 Worker、另一個服務，甚至完全不用 TypeScript：envelope 就是純 JSON row。

```ts
const result = await createReader({ results: d1Results(env.DB) }).read<Summary>('weekly-summary')
```

```ts
{ data: Summary, fetchedAt: number, isStale: boolean, age: number, lastError?: { at, message, count } } | null
```

- `fetchedAt` 是資料實際被抓下來的時間，epoch 毫秒。
- `age` 是它此刻多舊，讓你套用自己的門檻（「超過兩小時就顯示警告」）。
- `age` 超過該 query 的 `every` 之後，`isStale` 為 `true`。它只是標籤、從不阻擋：stale 資料一樣立即回傳，跟 fresh 資料完全一樣。
- `null` 代表第一次成功刷新還沒落地。這是唯一什麼都拿不到的情況。

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

## 選擇 scheduler

Cloudflare 提供兩套完整組合。兩者都把 envelope 存在 D1，也都完整遵守語意契約。

| | 組合 A | 組合 B |
|---|---|---|
| Scheduler | Durable Object alarms | Cron Triggers |
| Schedule state | Durable Object SQLite | D1，使用 atomic compare-and-swap claim |
| Result state | D1 | D1 |
| 粒度 | 精確的 alarm timestamp，最低 1 秒 | 最低 1 分鐘 |
| 平台元件 | Durable Object + D1 | 只有 D1 |
| 何時選它 | 你要精確的到期時間與動態 backoff | 你不想多管一個 Durable Object |

組合 A 就是上面的 quick start。組合 B 只有一個 export：

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

Scheduled invocation 可能重疊，所以組合 B 不是 serialized 的，schedule plane 必須具備原子性。`d1Store` 用檢查 version 的 `UPDATE` 來 claim，這既是這個配對安全的原因，也是 `cronPoller` 只給 `d1Results` 會在建構時直接報錯、而不是默默重複 fetch 的原因。

兩種組合的讀取方式完全相同：`createReader({ results: d1Results(env.DB) })`。

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
    store: (env) => d1Store(env.DB),
    sources: { posthog: { maxPerTick: 2 } },
  }),
}
```

同樣的 `sources` 欄位也能當作 `PollerDO` subclass 的 property。它是無狀態的，所以在併發 executor 之間依然正確，而且給你一個硬上限：不論你註冊多少 query，上游呼叫都不會超過 `maxPerTick × tick 頻率`。被預算擠掉的 query 會保持到期，而且每等一個 tick 優先度就上升，因為優先度看的是過期*比例* `(now - nextRunAt) / every` 而非絕對遲到時間。沒有人會餓死。

Jitter 是另外一半：第一次註冊時會替每個 query 的 `nextRunAt` 加上隨機偏移，所以 `5m`、`10m`、`1h` 的 query 不會永遠對齊在同一個 tick、一次擠爆同一個 source。預算是保險絲，jitter 讓保險絲平常不用燒。

## 語意契約

這六項保證就是產品本身。所有實作都必須遵守：

1. **讀取永遠立即回傳。** `read()` 只存取 result store，絕不等待上游。
2. **讀取永遠附帶時間。** 每筆結果都有 `fetchedAt`，caller 永遠知道資料年齡。
3. **Stale-if-error。** 上游失敗時保留 last-known-good 結果並標示為 stale，不會用錯誤取代它。
4. **At-least-once refresh。** Executor 在執行中死亡時，lease 過期後會由另一個 executor 接手。
5. **寫回一致性。** Version 檢查會拒絕 concurrent 或 zombie executor 的遲到寫回。
6. **Fail at config time。** 非法 duration、重複名稱、不安全的 lease、不受平台支援的 timeout，以及無法解析的 schedule plane，都會在建構時拋錯。

它們就是規格本身，而不是某份規格的摘要。[docs/zh-TW/concepts.md](./docs/zh-TW/concepts.md) 說明實現它們的 lease、version、backoff 與 staleness model；每個 store adapter 都必須通過 `@datafridge/core/contract-tests` 的契約相容性套件，才算正確。

## datafridge 不是什麼

- **不是 API connector。** Fetcher 永遠是你的 code，沒有 vendor 整合需要你跟著維護。
- **不是 proxy。** 只服務你以名稱註冊過的 query，不會因為有人來要就去抓。
- **不是 dashboard，也不是 config DSL。** 設定就是 code，放在你的 repo 裡，有型別檢查。
- **不是 request-triggered caching。** 不管有沒有人來讀，刷新都照排程發生。

1.0 尚未提供（文件中稱已出貨的範圍為 Wave 1）：

- Node timer、Redis、SQLite、Postgres、KV 或 Cache API adapters
- 不在有限 registry 內的 unbounded、on-demand 或任意 custom-range variants
- 精確的 shared quota-window accounting
- Metrics exporters 與 dashboards
- QStash 或 Inngest provisioning drivers
- Documentation website

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
