# Rate limiting

[English](../rate-limiting.md) | 繁體中文

datafridge 按 `source`（query 定義上的 `source` 欄位，預設 `'default'`）把 queries 分組，並限制每個 source 被打的力道。所有上游呼叫都從同一個 dispatcher 出去，所以下面這個天花板是對**全部**呼叫的天花板 - 排程刷新與「讀取時發現沒資料」的抓取，吃的是同一個窗。

```ts
createFridge({
  driver: cronDriver(ctx),
  store: d1(env.DB),
  queries,
  sources: {
    posthog: {
      limit: { requests: 100, per: '1m', reserve: 10 },
      maxConcurrent: 4,
    },
  },
})
```

## 天花板：`limit`

`limit` 是精確記帳，不是啟發式。Store 為每個 source 保留一列 ledger - 它正在計數的窗口，以及那個窗口已經用掉幾次 - 每次呼叫都以與 claim lease 同一套 version-checked CAS 遞增它。兩個 Worker、一個 cron trigger 和一個 Durable Object 只要指向同一個 D1，就共用同一份計數。

窗口是**固定的、對齊 epoch**：`per: '1m'` 時，包含 12:34:56.789 的窗口從 12:34:00.000 開始，並從零開起。滑動窗在邊界上更精確，代價是每次呼叫都要存一個時間戳；固定窗加上 `reserve` 與 `maxConcurrent` 用一列就涵蓋同樣的範圍。

拿不到呼叫額度的排程刷新會**維持到期**。它在 claim lease 之前就被擋下，所以什麼都沒寫，下個 tick 看到的還是原來那筆 - 只是更過期。因為優先級是過期**比例** `(now - nextRunAt) / every`，被擠掉的 query 每等一個 tick 就升權，不會有東西餓死。這些名字會出現在 `RunReport.throttled`。

## 保留額度：窗口最後幾次呼叫歸誰

排程工作不在乎自己在窗內哪個時刻跑；讀者在乎，因為它背後有一個人。沒有保留額度時，剛好落在窗口邊界的 tick 可以在第一秒把整分鐘的額度花光，接下來 59 秒的每一次讀取都拿不到東西。

`reserve` 就是解法，而且它是唯一的配速旋鈕：排程刷新看到的是 `requests - reserve`，讀取 miss 看到的是完整的 `requests`。預設 0 - 對沒有冷讀取要保護的 source 是對的值，一旦有了就是錯的。

額度用完的讀取不會回 `null`，那代表「沒有這個東西」。它回的是第三種 status：

```ts
const result = await fridge.read('course-funnel', { courseId })
if (result?.status === 'throttled') {
  // 沒有東西壞掉，也沒有東西缺少：只是還沒輪到這個讀者。
  return retryAfter(result.retryAt)
}
```

放棄之前它會在自己的 `timeout` 之內等窗口輪轉 - 所以 timeout 比窗口長的 query 會在邊界另一側抓到資料，而不是失敗。等待期間它不佔 lease：先拿到額度，拿到的那一個才去 claim。

## 平滑：`maxConcurrent`

`maxConcurrent` 限制單一 instance 對某個 source 同時在途的呼叫數。它限制的是併發，不是總量 - 一百個到期的 query 配上 `maxConcurrent: 4` 仍然會打一百次，只是四個四個來。供應商能接受這個速率但不能接受突發時用它，並且要記得這樣一來一個 tick 會拖到它最慢的那條四人鏈那麼久（見 [Cloudflare invocation 上限](./cloudflare.md#上限與天花板)）。

## Jitter

首次註冊時，每個 query 的 `nextRunAt` 會加隨機偏移，讓整數倍週期的 queries（`5m`、`10m`、`1h`）永遠不會固定對齊同一個 tick、集體衝撞同一個 source。失敗的 backoff 帶 jitter 也是同一個理由。Ledger 是保險絲，jitter 讓保險絲平常不用燒。

## 上游說不的時候：`RateLimitError`

收到 429 的 fetcher 可以講出來，並把供應商要求的時間一起帶上：

```ts
import { RateLimitError } from '@datafridge/core'

fetch: async ({ signal }) => {
  const response = await fetch(url, { signal })
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') ?? 0)
    throw new RateLimitError('posthog rate limited', { retryAfterMs: retryAfter * 1_000 })
  }
  return response.json()
}
```

重試會排在供應商說的時間，而不是走一般的 backoff 曲線 - 仍然帶 jitter，因為被它擋下的每一個 executor 聽到的都是同一個數字。沒有 `retryAfterMs` 時就是一般的失敗、一般的 backoff。

## 什麼不計入

解析動態變體清單不算一次 source 呼叫。它不是 source query：它打的通常是你自己的資料庫或 config service，而不是那個被限流的供應商。它仍然受 base 的 `timeout` 約束、可以透過 `signal` 取消，失敗時也在自己的 schedule row 裡 backoff。

## 跨服務共用同一個上限

`takeQuota` 屬於 store 契約，所以一個 source 的 ledger 住在 store 住的地方。兩個服務指向同一個 D1 - 或未來同一個 Redis - 就共用同一份計數，不需要任何額外協調。機制就只有這樣：沒有另一個要跑的 rate limiter。
