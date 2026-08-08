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

它算的是呼叫，不是意圖。額度在 claim lease 之前就先扣，所以一個無處可去的呼叫不會去拿一個馬上要還的 lease - 而之後在 claim 上輸給同儕的 dispatch，會把那一格還回它當初扣的那個窗口，因為那次呼叫根本沒發生。

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

`maxConcurrent` 限制某個 source 同時在途的呼叫數 - 跨越所有共用這個 store 的 executor，不是每個 process 各算一份。它限制的是併發，不是總量：一百個到期的 query 配上 `maxConcurrent: 4` 仍然會打一百次，只是四個四個來。供應商能接受這個速率但不能接受突發時用它，並且要記得這樣一來一個 tick 會拖到它最慢的那條四人鏈那麼久（見[單次 invocation 願意承接多少](#容量單次-invocation-願意承接多少)）。

它是 store 裡的一張 permit，在呼叫期間持有、結束時歸還。死掉的持有者永遠不會歸還，所以 permit 也會過期；過期之前它算數，之後就不算。這才讓那個數字對一個 Durable Object、一個 cron trigger 和五十個併發 Worker invocation 是同一個意思 - 否則就是各有一份上限，那就不是上限。

在途就是在途：等額度窗口輪轉的讀者不持有 permit，所以什麼都沒在做的呼叫，不會佔住那個專門用來限制「真的在做事的呼叫」的預算。

兩種呼叫者的等待方式不同，理由和它們在額度窗口前的差別一樣。**讀取**會在自己的 `timeout` 之內排隊等 permit；若先到期，它回 `status: 'throttled'`，帶上最快可能空出來的那張 permit 的 `retryAt` - 絕不是 `null`，因為什麼都沒有送到上游，也沒有東西缺少。**排程刷新**則完全不排隊：它維持到期、更過期地回來，並出現在 `RunReport.deferred`。無論哪一種，那次呼叫預留的額度都會立刻還回去，因為呼叫根本沒發生。

## 容量：單次 invocation 願意承接多少

容量不是 rate limit，不屬於任何 source，也不是一個你去設定的數字。一個 tick 用你早就宣告過的東西自我約束：

- 它讀**一頁有界**、最早到期的 row。分頁大小是實作細節；重點是無論 registry 多大，一個 tick 讀的儲存量都不會超過那一頁。
- 它只在某次呼叫自己的 **`timeout`** 還塞得進這次 invocation 剩餘的 wall clock 時才放行，而那個剩餘量由 driver 以 `budgetMs` 回報。不可能做完的工作，一開始就不會開始。
- 它不再去問**這個 tick 已經拒絕過**的 source，不管是窗口用完還是 permit 全在外面。一次答覆就是它學到的方式；該 source 其餘的工作直接延後，不必再花一趟往返聽同一句話。
- 它讓**拒絕本身帶著意義**。天花板會說出自己何時可能鬆開 - 窗口邊界，或最快的那張 permit 到期時間 - 所以下一次喚醒就在那時，不是一秒後，也不是重複三百次。用完 wall clock 則說不出任何時間，只有它會要求立刻被接續。
- 它每個 tick 最多移除**有限筆**已離開的 row，因為一次掉了一萬個 variant 的清單是一次部署，不是一場事故。

裝不下的東西不會被碰：沒有 lease、沒有 store 寫入、沒有向上游要任何東西。那些名字會回到 `RunReport.deferred`，而因為優先級是過期比例，它們就是下一個 tick 看到最過期的那一批。Tick 同時回報 `nextRunAt`，所以有積壓時 `FridgeDO` 會立刻重設 alarm，以一秒的下限逐步排掉，而不是擠在一次可能撞上 wall clock 的 invocation 裡。

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

`takeQuota` 屬於 store 契約，所以一個 source 的 ledger 住在 store 住的地方。兩個服務只要指向同一個 Store backend，就共用同一份計數，不需要任何額外協調，也不需要另外執行 rate limiter。
