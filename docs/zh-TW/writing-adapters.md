# Writing adapters

[English](../writing-adapters.md) | 繁體中文

datafridge 的 core 只依賴 contract，不假設任何平台特性。Durable Object、D1、Redis、cron、node timer 全部只是 adapter。某些後端讓 adapter 特別好寫（例如 DO 的單線程執行）- 那是該 adapter 的幸運，永遠不是 core 的假設。

介面刻意極小。Query registry 是 code 裡宣告的有限集合（幾個到幾十個 queries），所以逐筆 `readSchedule` 完全可行，`listDue` 只是優化。這就是「任何後端半天寫完一個 adapter」的保證。

## Store contract：兩個獨立插槽

```ts
interface ResultStore {
  readResult(name: string): Promise<Envelope | null>
  writeResult(name: string, env: Envelope): Promise<void>
  deleteResult(name: string): Promise<void>        // used by registry reconcile
}

interface ScheduleStore {
  readSchedule(name: string): Promise<ScheduleRow | null>
  writeSchedule(row: ScheduleRow): Promise<void>
  deleteSchedule(name: string): Promise<void>
  // atomic claim: succeeds only if version matches and the lease has expired
  claim(name: string, expectedVersion: number, leaseUntil: number, now: number): Promise<boolean>
  // optional capability: SQL backends can fetch all due rows in one query;
  // without it, core reads row by row
  listDue?(now: number, limit: number): Promise<ScheduleRow[]>
  capabilities: { atomicClaim: boolean; listDue: boolean }
}
```

「full Store」同時實作兩者。只能放結果的後端（像 Cloudflare KV 這種 blob store）只實作 `ResultStore`。

## 能力矩陣

`claim()` 是通用契約，每個後端用自己的原子原語實作。一個後端能不能承擔 schedule plane，取決於一個問題：它有沒有原子條件寫入？

| 後端 | atomic claim 實作 | result plane | schedule plane |
|---|---|---|---|
| Redis | `SET NX PX` / Lua script | 可 | 可 |
| D1 / Postgres / SQLite | `UPDATE ... WHERE version = ?`，檢查 changed rows | 可 | 可 |
| DO storage | 單線程 actor，天生序列化（claim 免 CAS） | 可 | 可（作為 doAlarms driver 的內部簿記） |
| Cloudflare KV | 做不到 - 無條件寫入原語、最終一致、last-writer-wins | 可（僅此而已） | 不可 |
| memoryStore | 單 process 內同步 | 可 | 可 |

KV 這類只會讀寫 blob 的後端永遠不能承擔 schedule plane。因為最終一致性，wave 1 完全不採用 KV；roadmap 只把它當作可選的 result-plane 讀取加速複本重新評估（result plane 語意本來就容忍 staleness）。

## Schedule plane 的 resolution 規則（fail at config time）

```
createPoller({ results, schedule?, driver, queries })
createPoller({ store, driver, queries })          // store = full Store, fills both planes

The schedule plane resolves in order:
1. An explicitly passed schedule store          -> use it (non-serialized drivers require atomicClaim)
2. The driver carries its own schedule          -> use the driver's
   (stateful serialized drivers, e.g. DO alarms)
3. store / results also implements ScheduleStore
   with atomicClaim                             -> use it (one backend does both, e.g. D1/Redis)
4. None of the above                            -> throw at construction, never degrade silently
```

三種典型寫法：

```ts
createPoller({ store: d1Store(env.DB), driver: cronShell(), queries })            // full store does both
createPoller({ results: d1Results(env.DB), driver: doAlarms(), queries })         // driver carries bookkeeping
createPoller({ results: redisResults(c), schedule: d1Schedule(env.DB),            // fully explicit, maximum mix
               driver: cronShell(), queries })
```

反例：`{ results: d1Results(...), driver: cronShell() }` - 只有 ResultStore 子集、cron 非 serialized、沒有明確的 schedule store。套用規則 4：建構時報錯。

## Driver contract

Driver 是 integration shell，它的義務：

1. 在自己的節奏下呼叫 `poller.runDue(now?)`。
2. 提供 `defer(promise)` - Workers 版接到 `ctx.waitUntil`；常駐 process 版是 no-op。
3. 宣告 `serialized: boolean` - 保證 `runDue` 永遠不會併發執行（單線程的 DO 或單一 node process 成立；Cron Triggers 不成立）。
4. 可選：自帶 `schedule: ScheduleStore`（有狀態 driver 的內部簿記，如 DO alarms）。

非 serialized 的 driver 搭配沒有 `atomicClaim` 的 schedule store，是建構時錯誤。

## 驗收標準：contract compatibility test suite

`@datafridge/core` 附帶一份 Store contract compatibility test suite，首先由內建的 `memoryStore` 參考實作驗證通過。它把設計中的每一條語意時間軸都編成確定性的測試（注入假時鐘、零 sleep）：claim/lease 行為、租約過期重撿、zombie 寫回被拒、兩個併發 `runDue` 對每個 query 恰好 fetch 一次，等等。

一個 adapter 通過這份套件對真實後端的完整執行，即為驗收 - 例如 Cloudflare 的 `d1Store` 對真的 D1 binding 跑完整套件，含併發 CAS claim 案例。任何 adapter 都不重寫自己的正確性測試；這份套件就是 adapter 生態的規格書。

## 分包原則

Package 是配銷單位，不是組合單位 - 組合自由由 core interface 保證，與包邊界無關。

1. **按共享 runtime 依賴群聚。** Cloudflare 的三個部件（doAlarms、d1、cron shell）共享同一組依賴與發版節奏，所以同包。Redis、SQLite 各自依賴不同 client，各自成包。
2. **包內每個部件是獨立 subpath export**（`@datafridge/cloudflare/do`、`/d1`、`/cron`）- 想用哪個拿哪個。
3. **任何包不得依賴兄弟包；所有部件只認 core 的 interface。** `PollerDO` 接受任何 `ResultStore`，所以跨包混搭（DO scheduler + Redis results）就是裝兩個包，永遠合法。
4. 純 JS、零平台依賴的部件住 core，不進平台包。
5. Driver 天生平台味（Cloudflare 的 scheduled handler、node 的 timer、K8s 的 HTTP endpoint 形狀各不同），按平台組織是貼合現實。
