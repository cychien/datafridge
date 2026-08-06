# Writing adapters

[English](../writing-adapters.md) | 繁體中文

datafridge 的 core 只依賴 contract，不假設任何平台特性。Durable Object、D1、Redis、cron、node timer 全部只是 adapter。某些後端讓 adapter 特別好寫（例如 DO 的單線程執行）- 那是該 adapter 的幸運，永遠不是 core 的假設。

介面刻意極小。Query registry 是 code 裡宣告的有限集合（幾個到幾十個 queries），所以逐筆 `readSchedule` 完全可行，`listDue` 只是優化。這就是「任何後端半天寫完一個 adapter」的保證。

## Store contract：一個 store，兩個半邊

```ts
interface Store {
  // result plane - 讀取端看到的東西
  readResult(name: string): Promise<Envelope | null>
  writeResult(name: string, env: Envelope): Promise<void>
  deleteResult(name: string): Promise<void>        // used by registry reconcile

  // schedule plane - 協調用的簿記
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

一個 store 同時持有兩個半邊。應用程式只會遇到這一個 interface。

**store 必須自己建立它需要的儲存空間。** 在第一次寫入前，它得自己套用需要的 table、key 或 collection，這樣任何 adapter 都不會丟一個「使用者要記得跑」的 migration 出來。使用者手動套用等價 schema 時必須是 no-op；儲存空間在暖 process 底下消失時，必須重建並重試，而不是一路失敗到那個 process 被回收；而 `readResult` 必須維持單純讀取：還不存在的儲存空間讀起來就是 `null`，和空的完全一樣。`@datafridge/cloudflare` 的 `test/schema.test.ts` 是可以照抄的參考測試 - 契約套件無法強制這一點，因為準備後端的正是套件的 factory。

這條義務就是 `datafridge init <平台>` 在每個平台上都一樣小的原因。

兩個半邊的一致性需求仍然不同，而且已出貨的程式碼裡就有一個例子證明這點：有狀態的 serialized driver 可以自己保管排程簿記，這時 store 只有 result 那一半會被用到。這種 driver 實作的是 `SchedulePlane`，也就是單獨的排程那一半。`PollerDO` 正是如此 - 它的簿記放在 Durable Object 自己的 SQLite，envelope 則寫進你交給它的 store。`SchedulePlane` 屬於 adapter 層級：只有在你要寫這種 driver 時才需要實作它。

## 能力矩陣

`claim()` 是通用契約，每個後端用自己的原子原語實作。一個後端能不能承擔排程那一半，取決於一個問題：它有沒有原子條件寫入？

| 後端 | atomic claim 實作 |
|---|---|
| Redis | `SET NX PX` / Lua script |
| D1 / Postgres / SQLite | `UPDATE ... WHERE version = ?`，檢查 changed rows |
| DO storage | 單線程 actor，天生序列化（claim 免 CAS）；作為 alarm driver 自己的 `SchedulePlane` |
| memoryStore | 單 process 內同步 |

沒有條件寫入原語的後端根本無法承擔排程那一半；只有最終一致性的後端則無法正確承擔。這種後端會宣告 `atomicClaim: false`，而建構只在 serialized driver 之下才接受它。

## 排程那一半從哪來（建構時就決定）

```
createPoller({ store, driver, queries })

1. driver 自帶簿記        -> 用 driver 的
   （有狀態的 serialized driver，例如 DO alarms；store 的排程那一半就閒置）
2. 否則                   -> 用 store 自己的排程那一半

無論走哪一條，claim 都必須安全：被選中的那一半要有 atomicClaim，或者 driver 是
serialized 的。否則建構直接拋錯，絕不默默降級。
```

兩種典型寫法：

```ts
createPoller({ store: d1(env.DB), driver: cronDriver(ctx), queries })
createPoller({ store: d1(env.DB), driver: { serialized: true, defer, schedule }, queries })
```

`PollerDO` 會在內部用自己的 SQLite `SchedulePlane` 建構第二種 shape。反例：一個回報 `atomicClaim: false` 的 store 搭配 `cronDriver(ctx)` 會拋錯，因為重疊的 cron invocation 會導致重複 fetch。

## Driver contract

Driver 是 integration shell，它的義務：

1. 在自己的節奏下呼叫 `poller.runDue(now?)`。
2. 提供 `defer(promise)` - Workers 版接到 `ctx.waitUntil`；常駐 process 版是 no-op。
3. 宣告 `serialized: boolean` - 保證 `runDue` 永遠不會併發執行（單線程的 DO 或單一 node process 成立；Cron Triggers 不成立）。
4. 可選：自帶 `schedule: SchedulePlane`（有狀態 driver 的內部簿記，如 DO alarms）。

非 serialized 的 driver 搭配沒有 `atomicClaim` 的排程簿記，是建構時錯誤。

## 驗收標準：contract compatibility test suite

`@datafridge/core` 附帶一份 Store contract compatibility test suite，首先由內建的 `memoryStore` 參考實作驗證通過。它把[概念](./concepts.md)中的每一條語意時間軸都編成確定性的測試（注入假時鐘、零 sleep）：claim/lease 行為、租約過期重撿、zombie 寫回被拒、兩個併發 `runDue` 對每個 query 恰好 fetch 一次，等等。

一個 adapter 通過這份套件對真實後端的完整執行，即為驗收 - 例如 Cloudflare 的 `d1` store 對真的 D1 binding 跑完整套件，含併發 CAS claim 案例。任何 adapter 都不重寫自己的正確性測試；這份套件就是 adapter 生態的規格書。

## 分包原則

Package 是配銷單位，不是組合單位 - 組合自由由 core interface 保證，與包邊界無關。

1. **按共享 runtime 依賴群聚。** Cloudflare 的三個部件（doAlarms、d1、cron shell）共享同一組依賴與發版節奏，所以同包。Redis、SQLite 各自依賴不同 client，各自成包。
2. **包內每個部件是獨立 subpath export**（`@datafridge/cloudflare/do`、`/d1`、`/cron`）- 想用哪個拿哪個。
3. **任何包不得依賴兄弟包；所有部件只認 core 的 interface。** `PollerDO` 接受任何 `Store`，所以跨包混搭（DO scheduler + Redis store）就是裝兩個包，永遠合法。
4. 純 JS、零平台依賴的部件住 core，不進平台包。
5. Driver 天生平台味（Cloudflare 的 scheduled handler、node 的 timer、K8s 的 HTTP endpoint 形狀各不同），按平台組織是貼合現實。
