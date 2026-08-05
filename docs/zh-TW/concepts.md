# Concepts

[English](../concepts.md) | 繁體中文

datafridge 把慢或不穩定的 API 變成永遠即回、永遠有資料、永遠標著年齡的本地讀取。本頁說明支撐這個承諾的資料模型與語意。

## 一張圖的架構

```
┌──────────────────────────────────────────────┐
│  Driver - who ticks, and how often            │
│  wave 1: DO Alarms / Cron Triggers            │
├──────────────────────────────────────────────┤
│  Core - pure logic, zero deps, no IO,         │
│  injected clock: registry, due computation,   │
│  priority, budget, backoff, lease, staleness  │
├──────────────────────────────────────────────┤
│  Store - where results and schedule state live│
│  wave 1: D1                                   │
└──────────────────────────────────────────────┘
```

三軸正交：**store** 決定狀態放哪、**driver** 決定誰來踢、**fetcher** 跟著 poller 實例跑在哪都行。

Core 的唯一入口是冪等的 `runDue(now)`。Core 永遠不擁有 event loop、不自己排程、不持有跨呼叫的記憶體狀態 - 一切都從 store 讀出、計算、寫回。這就是同一份 core 能同時活在常駐的 Node process、冷啟的 Worker、多實例併發環境的原因。

## 兩個 plane

每個 query 有兩類狀態，一致性需求完全不同，因此分屬兩個 plane。

### Result plane - 產品本體

使用者讀的東西。可以放在任何便宜、讀取快的儲存。

```ts
interface Envelope<T> {
  data: T
  fetchedAt: number            // epoch ms
  freshUntil: number           // fetchedAt + every; after this, isStale = true
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

Schedule plane 只有兩個合法的家：

1. 一個具備原子條件寫入（CAS）能力的 store - 適用任何併發環境（多實例 cron、多機部署）。
2. 一個有狀態且 serialized 的 driver 內部 - driver 自己保證單寫者，簿記存哪裡是它的實作細節（DO alarms 用自己的 SQLite；node timer 會用 process 記憶體加任意持久化）。

正式的 resolution 規則見 [writing-adapters.md](./writing-adapters.md)。

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
                        5m query's period but only 0.07 of a 60m query's)
3. Apply budget         group by source, take the top maxPerTick per group;
                        squeezed-out queries stay due and are picked up next tick
4. Claim lease          claim(name, version, now + timeout + margin);
                        losing the claim means someone else is on it - skip
5. Execute + write back concurrently (Promise.allSettled), each fetch wrapped
                        in an AbortSignal timeout
                        success: writeResult + nextRunAt = completion time + every,
                                 failCount = 0
                        failure: keep old envelope, failCount++,
                                 nextRunAt = now + backoff(failCount)
Returns RunReport { ran, skippedLeased, deferredBudget, failed }
```

關鍵決策：

- **Fixed-delay 語意。** 下一輪從完成時間起算。慢 query 自然自我放慢，永遠不會排在自己後面堆積。
- **Backoff。** `min(every, 1m * 2^(failCount - 1))` 加 jitter，上限收在 `every`，因為比正常週期更慢地重試沒有意義。
- **Jitter。** 首次註冊時給 `nextRunAt` 加隨機偏移，讓整數倍週期的 queries 永遠不會固定對齊同一個 tick、集體衝撞同一個 source 的預算。預算是保險絲，jitter 讓保險絲平常不用燒。
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
| 被預算擠掉 | 保持到期，下個 tick 優先（過期比例升高） | 舊資料，稍舊一點 |
| 連續失敗 | backoff 收斂在 `every`，永久保留 last-known-good | 舊資料 + 可見的 `lastError` |
