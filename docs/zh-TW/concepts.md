# Concepts

[English](../concepts.md) | 繁體中文

整個 library 就是一條不變量：

> **App 要資料的時候，永遠拿得到。** 不一定是最新的 - 但永遠有，而且在上游允許的範圍內盡可能新。

以下的一切都是從它推導出來的。

## 解法，以及解法欠你的東西

只有兩個機制，也只需要兩個：

- **提前 polling。** Scheduler 依各自的週期刷新每個 query，所以等到有人來問的時候，答案已經在本地了。讀到東西的讀取直接回傳、完全不碰上游，不論它多 stale - 刷新既有資料是 scheduler 的職責，而一個會觸發抓取的讀取，會剛好在上游最撐不住的時候給它最大的壓力。
- **Miss 時去抓。** 什麼都沒有就沒有東西可回，所以那次讀取自己去抓，上限是該 query 自己的 `timeout`。這是讀取唯一能造成的上游呼叫。

決定替你呼叫上游，就製造了四個問題，而這個 library 四個都自己扛：

| 問題 | 機制 |
|---|---|
| Rate limit | 每個 source 一份 quota ledger，記在 store 裡，所有呼叫不論起因都遵守它 |
| 失敗 | 保留 last-known-good、帶 jitter 的 exponential backoff，供應商指定時間時就照它的 `Retry-After` |
| 同一個呼叫送兩次 | per-key lease：第一個到的去抓，其他人等寫回 |
| 一個窗口塞不下的工作量 | 以過期比例排優先序讓沒有東西餓死，並保留一部分額度避免讀者被排程擠掉 |

四個都在同一個地方被回答。排程刷新與讀取 miss 是同一種工作走不同的門進來，而且從同一個 dispatcher 出去：沒有第二條路可以讓其中任何一項失效。

## 語意契約

這六項保證就是產品本身。所有實作都必須遵守：

1. **有資料的讀取永不等待、也永不觸碰上游。** 回答一筆已存的結果就是一次本地讀取，fresh、stale、`invalid` 一律如此。
2. **沒資料的讀取觸發恰好一次上游抓取。** 同時到達的讀者會合流成那一次呼叫，等待上限是該 query 的 `timeout` - 排程 entry 走 per-key lease，registry 沒有指名的 params 走暫時性的 flight。兩者都住在 store 裡，所以合流跨 process 成立，不是只在單一 process 內。
3. **上游呼叫永不超過該 source 宣告的速率，不論是誰引起的。** 排程刷新與讀取觸發的抓取花的是同一份 quota ledger。
4. **被 rate limit 推遲的工作永不餓死、也不會白白失敗。** 被拒絕的刷新維持到期並以過期比例升權；被拒絕的讀取在自己的 timeout 內等窗口輪轉，並回 `throttled` 而不是假裝沒有這個東西。
5. **失敗會保留 last-known-good 並以帶 jitter 的 backoff 重試。** 死掉的 executor 的工作在 lease 到期後被接手，遲到的寫回會被 version 拒絕。
6. **非法設定在建構時拋錯**，不會拖到某個 tick 才爆。

它們就是規格本身，而不是某份規格的摘要。本頁其餘部分說明實現它們的 lease、version、quota、backoff 與 staleness model；每個 store adapter 都必須通過 `@datafridge/core/contract-tests` 的契約相容性套件，才算正確。

## 一張圖的架構

```
┌──────────────────────────────────────────────┐
│  Driver - who ticks, and how often            │
│  wave 1: DO Alarms / Cron Triggers            │
├──────────────────────────────────────────────┤
│  Core - pure logic, zero deps, no IO,         │
│  injected clock: registry, due computation,   │
│  priority, quota, backoff, lease, staleness   │
├──────────────────────────────────────────────┤
│  Store - where results and schedule state live│
│  wave 1: D1                                   │
└──────────────────────────────────────────────┘
```

三軸正交：**store** 決定狀態放哪、**driver** 決定誰來踢、**fetcher** 跟著 fridge 實例跑在哪都行。

Core 的唯一入口是冪等的 `runDue(now)`。Core 永遠不擁有 event loop、不自己排程、不持有跨呼叫的記憶體狀態 - 一切都從 store 讀出、計算、寫回。這就是同一份 core 能同時活在常駐的 Node process、冷啟的 Worker、多實例併發環境的原因。

## 兩個 plane

每個 query 有兩類狀態，一致性需求完全不同。一個 `Store` 同時持有兩者；這個區分仍然重要，因為它們的一致性需求不同，而且有狀態且 serialized 的 driver 可能自己保管排程那一半。

### Result plane - 產品本體

使用者讀的東西。可以放在任何便宜、讀取快的儲存。

```ts
interface Envelope<T> {
  data: T
  fetchedAt: number            // epoch ms
  freshUntil: number           // fetchedAt + every; after this, isStale = true
  validUntil?: number          // 資料自己的到期時間；過了它 status = 'invalid'
  lastError?: { at: number; message: string; count: number }
}
```

Envelope 以純 JSON 序列化。任何語言的 consumer 只要能直接讀底層 result store 就能用 - 不需要 TypeScript runtime。

### Schedule plane - 協調用的簿記

很小，但必須支援原子操作，或被序列化保護。

```ts
interface ScheduleRow {
  name: string
  nextRunAt: number
  failCount: number
  leaseUntil: number | null
  version: number              // for CAS; can be relaxed under serialized execution
}
```

這一半只有兩個合法的家：

1. store 本身，前提是它具備原子條件寫入（CAS）能力 - 適用任何併發環境（多實例 cron、多機部署）。
2. 一個有狀態且 serialized 的 driver 內部 - driver 自己保證單寫者，簿記存哪裡是它的實作細節（node timer 會用 process 記憶體加任意持久化）。這時 store 的排程那一半就閒置。已出貨的東西都不走這條：`FridgeDO` 不保管任何自己的 dispatch 狀態，所以同一個 store 上的 Durable Object 與 cron trigger 是透過它協調，而不是透過「剛好是 singleton 的那個物件」。

正式規則見 [writing-adapters.md](./writing-adapters.md)。

## Parameter variants 與 identity

Parameterized query 會把有限的 runtime list 展開成一般 scheduled identities。每個 variant 都有自己的 `ScheduleRow`、lease、version、failure count、backoff 與 `Envelope`。因此 registry reconcile 對新增或移除 variant 的行為，與新增或移除 fixed query 完全相同。

Variant params 是 canonical JSON。Storage key 為 `@df/v1/<encoded-base-name>/<sha256-of-canonical-params>`，所以 raw ID 與 preset value 不會出現在 D1 key 或 `RunReport`。SHA-256 提供跨 object key ordering 的穩定 collision-resistant identity。Params 用來識別，不是 secret storage。Credential 與 private payload 必須留在 binding 或 fetcher closure。

`anyParams` base 沒有清單，也沒有 entry。是不是 entry 由 registry 決定：它指名的 params 是持久的排程 entry，它沒有指名的 params 根本不是 entry - 讀它就是走同一個 dispatcher 的一次全新呼叫，扣同一個 source 窗口、受同一個 timeout 約束，什麼都不存。讀者剛好問了什麼，不能就此把自己變成 scheduler 從此得永遠負責的工作。

這種 params 的重疊讀取仍然會合流，走的是暫時性的 flight 而不是 lease：一次呼叫、一格額度、一個答案交給所有在等它的人。Flight 會自己過期、不存結果，所以在它結束之後才抵達的讀者會拿到一次全新的呼叫 - 合流與快取的差別，正是「答案屬於誰」。

## Staleness 語意

- 結果在 `freshUntil`（`fetchedAt + every`）之前是 **fresh**。之後 `read()` 回報 `isStale: true`。
- `read()` 也回傳 `age`（距 `fetchedAt` 的毫秒數），caller 可以套用自己的門檻。
- `read()` 只在該 query 從未成功 fetch 過（首輪尚未完成）時回傳 `null`。caller 應明確處理這個情況。
- Staleness 是標籤，永遠不是阻擋：stale 資料跟 fresh 資料一樣即回。

## runDue pipeline

```
runDue(now):
1. Collect candidates   nextRunAt <= now (no record = first run = due now)
2. Prioritize           by overdue ratio (now - nextRunAt) / every, descending
                        (ratio, not absolute lateness: 4 minutes late is 0.8 of a
                        5m query's period but only 0.07 of a 60m query's),
                        then admit while the call's timeout fits the
                        invocation and its source has not refused yet
3. Take quota           one call against the source's ledger for the current
                        window, minus whatever `reserve` holds back for readers;
                        refused queries stay due and come back more overdue
4. Claim lease          claim(name, version, now + timeout + margin);
                        losing the claim means someone else is on it - skip,
                        and the quota it took goes back to the window
5. Execute + write back concurrently (Promise.allSettled), each fetch wrapped
                        in an AbortSignal timeout
                        success: writeResult + nextRunAt = completion time + every,
                                 failCount = 0
                        failure: keep old envelope, failCount++,
                                 nextRunAt = now + backoff(failCount)
Returns RunReport { ran, skippedLeased, throttled, deferred, failed, nextRunAt }
```

關鍵決策：

- **Fixed-delay 語意。** 下一輪從完成時間起算。慢 query 自然自我放慢，永遠不會排在自己後面堆積。
- **Backoff。** `min(every, 1m * 2^(failCount - 1))` 加 jitter，上限收在 `every`，因為比正常週期更慢地重試沒有意義。
- **Jitter。** 首次註冊時給 `nextRunAt` 加隨機偏移，讓整數倍週期的 queries 永遠不會固定對齊同一個 tick、集體衝撞同一個 source。Ledger 是保險絲，jitter 讓保險絲平常不用燒。
- **只有一個上游出口。** 第 3 到 5 步就是 dispatcher，而讀取時發現沒資料的抓取，進入點完全相同。沒有第二條路，所以一條 rate limit 不可能只對其中一種呼叫成立。
- **三道防線各守一關**：`nextRunAt` 管「該不該做」、lease 管「誰在做」、version 管「誰的結果算數」。慢速、崩潰、zombie 各打穿一關，下一關接住。

### 慢 query 的逐分鐘時間軸

`every: 5m`、`timeout: 4m`、tick 每分鐘：

```
12:00 tick    claim succeeds (lease until 12:04:30), fetch starts
12:01-12:04   nextRunAt is still 12:00 (updated only on completion), so the query
              looks due, but claim fails: silently skipped
              read() keeps returning the last good result instantly the whole time
Ending A      success: write back, nextRunAt = completion time + 5m
Ending B      timeout: abort, failCount = 1, backoff reschedule, old result kept
Ending C      executor dies: nothing written back; the 12:05 tick sees the expired
              lease and re-claims
Zombie write  version has moved on, write rejected; one upstream call wasted,
              store stays consistent
```

## 失敗語意

| 情況 | 行為 | `read()` 看到什麼 |
|---|---|---|
| 上游回錯 / timeout | failCount++，backoff 重排，保留舊 envelope | 舊資料 + `isStale` |
| 執行者中途暴斃 | 租約過期後下個 tick 重撿（at-least-once） | 舊資料 + `isStale` |
| Zombie 遲到寫回 | version 不符，寫入被拒 | 不受影響 |
| 首輪尚未完成 | - | `null`（caller 應處理） |
| Source 額度用完 | 保持到期，下個 tick 優先（過期比例升高） | 舊資料；miss 時為 `status: 'throttled'` |
| 超出這次 invocation 的容量 | 原封不動，名字放進 `deferred`，下個 tick 最過期 | 不受影響：讀取從不等待 tick |
| 連續失敗 | backoff 收斂在 `every`，永久保留 last-known-good | 舊資料 + 可見的 `lastError` |
