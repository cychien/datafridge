# datafridge - Design Doc

> 名稱已定案：`datafridge`（2026-08-06 確認 npm 上 `datafridge` 與 `data-fridge` 均可註冊，發布時兩個都佔）。
> 比喻即產品：資料的冰箱 - 定期補貨（scheduled polling）、開門即拿（read() 即回）、食物貼著有效期限（fetchedAt/freshUntil）、超市倒了冰箱裡還有存糧（stale-if-error）。
> Status: draft v2.1（2026-08-06）
> Scope: 通用架構 + 第一波 Cloudflare 實作（DO alarms scheduler + D1 store）

**架構首要原則**：core 只依賴 contract，不假設任何平台特性。DO、D1、Redis、cron、node timer 全部只是 adapter；某些後端因先天特性（如 DO 的單線程）讓 adapter 實作特別簡單，但那是該 adapter 的幸運，不是 core 的假設。

## 1. 定位與動機

**一句話**：把慢或不穩定的 API 變成永遠秒回、永遠有資料的本地讀取，並且明確告訴你資料是什麼時候的。

現有工具的缺口：

- bentocache / cachified / stale-while-revalidate-cache 都是 **request-triggered SWR** - 沒有人來讀，cache 就不保鮮；冷啟動的第一個請求要吞下慢查詢。
- Airbyte / Fivetran 是重量級 connector 生意，不是隨插即用的 library。
- cron + Redis 自幹版每個專案重寫一次，而且 lease、backoff、staleness 語意每次都做不全。

datafridge 的差異點：**proactive scheduled refresh**（資料永遠是熱的）+ **per-source rate limiting** + **serve-stale-on-error**（上游掛掉對 application 無感），做成模組完全正交、可替換的 TypeScript library。

### Non-goals

- 不做任何 API connector（fetcher 一律 BYO closure）。
- 不做 dashboard、不做 config DSL（config 就是 code）。
- 不做 transparent proxy - 只服務事先註冊的 named queries。
- v1 不做精確分散式配額記帳（見 §9）。

## 2. 語意契約

這些語意是產品的靈魂，所有實作都不得違反：

1. **讀取永遠即回**：`read()` 只碰 result store，永遠不等上游。
2. **讀取永遠附帶時間**：每個結果帶 `fetchedAt`，caller 永遠知道資料多舊。
3. **stale-if-error**：上游失敗時保留 last-known-good 結果並標記 `isStale`，application 無感。
4. **at-least-once refresh**：執行中的實例暴斃，租約過期後自動重撿，不需要清理程序。
5. **寫回一致性**：併發或 zombie 執行者的過期寫回會被拒絕，store 永遠一致。
6. **fail at config time**：非法設定（timeout >= lease、無合法 schedule plane、重複 name）在建構時報錯，不留到 runtime。

## 3. 架構總覽

```
┌──────────────────────────────────────────────┐
│  Driver（誰來踢、多久踢一次）                     │
│  wave1: DO Alarms / Cron Triggers             │
│  未來: nodeTimer / QStash / external           │
├──────────────────────────────────────────────┤
│  Core（純邏輯、零依賴、不碰 IO、時鐘注入）          │
│  registry、due 計算、priority、budget、          │
│  backoff、lease 語意、staleness 語意             │
├──────────────────────────────────────────────┤
│  Store（結果與排程狀態放哪）                       │
│  wave1: D1                                    │
│  未來: Redis / SQLite / Postgres / KV(僅結果)    │
└──────────────────────────────────────────────┘
```

三軸正交：**store 決定狀態在哪、driver 決定誰來踢、fetcher 跟著 poller 實例跑在哪都行**。

Core 的唯一入口是冪等的 `runDue(now)`。Core 永遠不擁有 event loop、不自己排程、不持有跨呼叫的記憶體狀態 - 全部狀態從 store 讀、算、寫回。這是它能同時活在 Node 常駐進程、每次冷啟的 Worker、多實例併發環境的原因。

## 4. 資料模型：兩個 plane

每個 query 有兩類狀態，一致性需求完全不同，因此分屬兩個 plane：

```ts
// Result plane - 產品本體，使用者讀的東西；可放在任何便宜、讀取快的儲存
interface Envelope<T> {
  data: T
  fetchedAt: number            // epoch ms
  freshUntil: number           // fetchedAt + every；之後 isStale = true
  lastError?: { at: number; message: string; count: number }
}

// Schedule plane - 協調用的簿記；小、但必須支援原子操作或被序列化保護
interface ScheduleRow {
  name: string
  nextRunAt: number
  failCount: number
  leaseUntil: number | null
  version: number              // CAS 用；serialized execution 下可退化
}
```

**Schedule plane 是協調狀態，它有兩個合法的家**（§5 的 resolution 規則正式化這件事）：

1. 一個具備原子條件寫入（CAS）能力的 store - 適用任何併發環境（cron 多實例、多機部署）。
2. 一個有狀態且 serialized 的 driver 內部 - driver 自己保證單寫者，簿記存哪裡是它的實作細節（DO alarms 存自己的 SQLite、node timer 存進程記憶體 + 任意持久化）。

Envelope 以純 JSON 序列化 - 任何語言的 consumer 只要能讀底層 result store 就能用，不需要跑 TS。

## 5. 介面定義

### Query 定義

```ts
interface QueryDef<T = unknown> {
  name: string                 // 唯一，是 store key 的一部分
  every: Duration              // '5m' | '1h' | ms number
  timeout?: Duration           // 預設 30s；必須 < lease、< 平台上限
  source?: string              // rate-limit 分組，預設 'default'
  fetch: (ctx: FetchCtx) => Promise<T>
}

interface FetchCtx {
  signal: AbortSignal          // timeout 到會 abort
  now: number
  attempt: number              // 1-based，backoff 重試遞增
}

const queries = defineQueries([...])   // 建構時驗證，fail at config time
```

### Store contract：兩個獨立插槽

```ts
interface ResultStore {
  readResult(name: string): Promise<Envelope | null>
  writeResult(name: string, env: Envelope): Promise<void>
  deleteResult(name: string): Promise<void>        // registry reconcile 用
}

interface ScheduleStore {
  readSchedule(name: string): Promise<ScheduleRow | null>
  writeSchedule(row: ScheduleRow): Promise<void>
  deleteSchedule(name: string): Promise<void>
  // 原子性 claim：version 相符且租約已過期才成功
  claim(name: string, expectedVersion: number, leaseUntil: number, now: number): Promise<boolean>
  // 可選能力：SQL 後端一發查詢取回所有到期項；沒有就由 core 逐筆 read
  listDue?(now: number, limit: number): Promise<ScheduleRow[]>
  capabilities: { atomicClaim: boolean; listDue: boolean }
}
```

介面刻意極小：registry 是 code 裡宣告的有限集合（幾個到幾十個），所以逐筆 `readSchedule` 完全可行，`listDue` 只是優化。**這是「任何後端半天寫完一個 adapter」的保證。**

### Schedule plane 的 resolution 規則（fail at config time）

```
createPoller({ results, schedule?, driver, queries })
createPoller({ store, driver, queries })          // store = full Store，同時填兩個 plane

schedule plane 依序解析：
1. 明確傳入的 schedule store        → 用它（非 serialized driver 要求 atomicClaim）
2. driver 自帶 schedule（stateful serialized driver，如 DO alarms） → 用 driver 的
3. store / results 同時實作 ScheduleStore 且 atomicClaim → 用它（單一後端包辦，如 D1/Redis）
4. 都沒有 → 建構時報錯，絕不默默降級
```

三種典型寫法：

```ts
createPoller({ store: d1Store(env.DB), driver: cronShell(), queries })            // full store 包辦
createPoller({ results: d1Results(env.DB), driver: doAlarms(), queries })         // driver 自帶簿記
createPoller({ results: redisResults(c), schedule: d1Schedule(env.DB),            // 全明確，極致混搭
               driver: cronShell(), queries })
```

反例：`{ results: d1Results(...), driver: cronShell() }` - 只有 ResultStore 子集、cron 非 serialized、無明確 schedule → 規則 4，建構時報錯。

### 後端能力矩陣

`claim()` 是通用契約，每個後端用自己的原子原語實作；一個後端能不能承擔 schedule plane，取決於它有沒有原子條件寫入：

| 後端 | atomic claim 實作 | result plane | schedule plane |
|---|---|---|---|
| Redis | `SET NX PX` / Lua script | ✓ | ✓ |
| D1 / Postgres / SQLite | `UPDATE ... WHERE version = ?` 檢查 changes | ✓ | ✓ |
| DO storage | 單線程 actor，天生序列化（claim 免 CAS） | ✓ | ✓（作為 doAlarms driver 的內部簿記） |
| Cloudflare KV | 做不到 - 無條件寫入原語、最終一致、LWW | ✓（僅此而已） | ✗ |
| memoryStore | 單進程內同步 | ✓ | ✓ |

KV 這類「只會讀寫 blob」的後端永遠只能當 result plane，且因最終一致性，wave 1 不採用，roadmap 中僅作為可選的 result-plane 讀取加速複本重新評估（result plane 語意本來就容忍 staleness）。

### Driver contract

Driver 是 integration shell，義務：

1. 在自己的節奏下呼叫 `poller.runDue(now?)`。
2. 提供 `defer(promise)` - Workers 版接 `ctx.waitUntil`，常駐進程版是 no-op。
3. 宣告 `serialized: boolean` - 保證 runDue 不會併發執行（DO 單線程、單一 node 進程都成立；cron triggers 不成立）。
4. 可選：自帶 `schedule: ScheduleStore`（stateful driver 的內部簿記，如 DO alarms）。

非 serialized driver + 無 atomicClaim 的 schedule store = 建構時報錯。

### 讀取 API

```ts
// 完整 poller（有 fetchers、能刷新）- 自帶 read()，poller 所在的家不需要 reader
const poller = createPoller({ results, schedule?, driver, queries })
const r1 = await poller.read<T>('posthog-weekly')

// 只讀 client - 給沒有 poller 的家（另一個 Worker / 服務 / 語言）用，
// 只需要 ResultStore；同一個 process 裡 adapter 實例建一次共用即可
const reader = createReader({ results })
const r = await reader.read<T>('posthog-weekly')
// r: { data: T, fetchedAt: number, isStale: boolean, age: number } | null
// null = 從未成功 fetch 過（首輪還沒跑完）
```

可選的 SWR 退化模式（沒有任何 driver 時的保底）：

```ts
const r = await poller.read('name', { swrRefresh: defer })
// 讀到過期 → 回 stale 結果，同時 defer 一次背景刷新
```

## 6. runDue pipeline 與併發模型

```
runDue(now):
1. 撈候選    nextRunAt <= now（無 record = 首跑 = 立即到期）
2. 排優先級  按過期比例 (now - nextRunAt) / every 降序
             （比例而非絕對時間：遲到 4 分鐘對 5m query 是 0.8 週期，對 60m 是 0.07）
3. 套預算    按 source 分組，每組取前 maxPerTick 個；被擠掉的保持到期，下個 tick 自然接手
4. 搶租約    claim(name, version, now + timeout + margin)；搶輸 = 別人在做，跳過
             （serialized driver 下 claim 由簿記層以單寫者身分直接滿足）
5. 執行寫回  併發執行（Promise.allSettled），每個 fetch 包 AbortSignal timeout
             成功 → writeResult + nextRunAt = 完成時間 + every、failCount = 0
             失敗 → 保留舊 envelope、failCount++、nextRunAt = now + backoff(failCount)
回傳 RunReport { ran, skippedLeased, deferredBudget, failed } 供 logging hook
```

關鍵決策：

- **fixed-delay 語意**：下一輪從完成時間起算。慢 query 自然自我放慢，永遠不會排在自己後面堆積。
- **backoff**：`min(every, 1m * 2^(failCount - 1))` + jitter。上限收在 `every`，因為比正常週期更慢地重試沒有意義。
- **jitter**：首次註冊時給 `nextRunAt` 加隨機偏移，避免整數倍週期的 queries 永遠同 tick 對齊、集體衝撞同 source 預算。預算是保險絲，jitter 讓保險絲平常不用燒。
- **三道防線各守一關**：`nextRunAt` 管「該不該做」、lease 管「誰在做」、version 管「誰的結果算數」。慢速、崩潰、zombie 任何一關打穿，下一關接住。

### 慢 query 時間軸（不變量的具體化）

`every: 5m`、`timeout: 4m`、tick 每分鐘：

```
12:00 tick   claim 成功（lease 到 12:04:30）→ 開始 fetch
12:01-12:04  nextRunAt 仍是 12:00（完成才更新）→ 看似到期，但 claim 失敗 → 靜默跳過
             全程 read() 照常秒回上次的好結果
結局 A 成功   寫回 → nextRunAt = 完成時間 + 5m
結局 B 超時   abort → failCount=1 → backoff 重排，舊結果保留
結局 C 暴斃   無人寫回 → 12:05 tick 發現租約過期 → 重新 claim 重跑
zombie 寫回   version 已被推進 → 寫入被拒 → 只浪費一次上游呼叫，store 一致
```

## 7. Wave 1：Cloudflare 實作

兩個 driver × 一個 store，組成兩套都完整可用的接法，同時證明模組正交性：

### 組合 A（推薦）：doAlarms driver + D1 result store

DO 在這裡的身分是 **scheduler**：alarm 自我喚醒、單線程執行 runDue、排程簿記存在自己的 SQLite（driver 內部細節，外界不可見）。產品的 store 是使用者自己的 D1。

```
      setAlarm(min(nextRunAt))
      ┌──────────────────────────────┐
      │ PollerDO - doAlarms driver    │
      │  簿記（ScheduleRows）: 自己的   │
      │  SQLite，serialized，免 CAS    │
      │  alarm() → runDue(now)        │
      │  fetchers 在此執行              │
      └───────────┬──────────────────┘
                  │ writeResult(envelope)
                  ▼
      ┌──────────────────────────────┐
      │ D1（result plane，使用者的 DB）  │
      └───────────┬──────────────────┘
                  │ SELECT 直讀，不經過 DO
                  ▼
        任意 Worker / createReader
```

讀取端直讀 D1，不經過 DO - 讀路徑上沒有任何 datafridge 的運行元件。

```ts
// poller.ts
import { PollerDO, defineQueries, d1Results } from 'datafridge/cloudflare'

const queries = defineQueries([
  { name: 'posthog-weekly', every: '10m', source: 'posthog',
    fetch: ({ signal }) => posthogQuery(..., { signal }) },
])

export class Poller extends PollerDO {
  queries = queries
  results(env: Env) { return d1Results(env.DB) }
}

// worker.ts（讀取端，同一個 Worker 或完全不同的 Worker 都行）
export default {
  async fetch(req, env) {
    await ensureStarted(env.POLLER)   // 冪等，見下
    const r = await createReader({ results: d1Results(env.DB) }).read('posthog-weekly')
    return Response.json(r)
  },
}
```

```toml
# wrangler.toml - 使用者唯一要碰的 infra 宣告
[[durable_objects.bindings]]
name = "POLLER"
class_name = "Poller"
[[d1_databases]]
binding = "DB"
database_id = "..."
[[migrations]]
tag = "v1"
new_sqlite_classes = ["Poller"]
```

alarm loop：

```
alarm():
  try {
    report = core.runDue(now)
  } finally {
    next = min(nextRunAt of all rows)
    setAlarm(max(next, now + 1s))    // finally 保證鬧鐘鏈永不斷
  }
```

per-query 錯誤全部收進 failCount，alarm handler 本身幾乎不 throw（throw 觸發 DO 的 alarm 重試，那是最後一層保底而非常規路徑）。

兩個生命週期細節：

1. **鬧鐘鏈點火**：DO 要被喚醒過一次才有 alarm。`ensureStarted()` 是冪等 RPC - 已有 alarm 就直接返回。掛在讀取端或 init CLI 的部署後 curl 都可以。
2. **registry reconcile**：使用者改 queries 重新部署後，`ensureStarted()` 與每次 alarm 開頭比對 registry 與簿記 rows - 新 query 建 row（帶 jitter）、消失的刪 row 與 envelope、`every` 變更重算 `nextRunAt`。

### 組合 B：cron trigger driver + D1 full store

完全不用 DO 的接法 - schedule plane 走 resolution 規則第 3 條，落在 D1 自己身上（`UPDATE ... WHERE version = ?` 的 CAS）。cron 多實例併發由 claim 保護。

```ts
export default {
  scheduled: (event, env, ctx) =>
    ctx.waitUntil(createPoller({ store: d1Store(env.DB), queries }).runDue()),
}
```

```toml
[triggers]
crons = ["* * * * *"]   # 粒度下限 1 分鐘
```

適合不想管 DO、接受 1 分鐘粒度的人。fetchers 在 Worker 的 scheduled invocation 裡執行。

### 選擇指引

| | 組合 A（doAlarms） | 組合 B（cron + D1 CAS） |
|---|---|---|
| 排程粒度 | 任意 timestamp | 1 分鐘下限 |
| 排程可動態調整 | ✓（backoff、runtime 改頻率） | tick 固定，due 判斷仍動態 |
| 併發保護 | driver 序列化，零成本 | D1 CAS claim |
| 元件 | DO + D1 | 只有 D1 |

計劃提供 `npx datafridge init cloudflare` 自動寫入兩種組合的 wrangler 宣告。

### 平台限制備忘

- fetch `timeout` 上限受 invocation 時長限制，`defineQueries` 建構時驗證。
- D1 單區域：遠端 PoP 的讀有跨區延遲；對本產品語意可接受，文件標明。大流量讀取的加速複本見 roadmap。
- envelope 大小受 D1 單 row 上限約束，實作時以當前官方文件為準並在 `writeResult` 防呆。

## 8. 失敗語意總表

| 情況 | 行為 | read() 看到什麼 |
|---|---|---|
| 上游回錯 / timeout | failCount++，backoff 重排，保留舊 envelope | 舊資料 + isStale |
| 執行者中途暴斃 | 租約過期後下個 tick 重撿（at-least-once） | 舊資料 + isStale |
| zombie 遲到寫回 | version 不符，寫入被拒 | 不受影響 |
| 首輪尚未完成 | - | null（文件建議 caller 處理） |
| 預算擠掉 | 保持到期，下個 tick 優先（過期比例升高） | 舊資料，稍舊一點 |
| 連續失敗 | backoff 收斂在 every，永久保留 last-known-good | 舊資料 + lastError 可見 |

## 9. Rate limiting

v1：**per-tick budget**（`sources: { posthog: { maxPerTick: 2 } }`）+ jitter 錯峰。無狀態、分散式安全，速率上限 = maxPerTick × tick 頻率。

v2（可選功能）：per-source window counter 放進 schedule plane（CAS 更新），給「多程式共用同一份供應商硬配額、無法拆 key、額度會用滿」的場景。判斷準則：三條件不同時成立就不需要，先建議拆 API key。

## 10. 套件佈局

```
packages/
  core/          @datafridge/core - 零 runtime 依賴
                 types、defineQueries、planner、runDue engine、
                 memoryStore（測試 + 零設定試用）、backoff/jitter/duration utils
  cloudflare/    @datafridge/cloudflare - peer-dep core
                 PollerDO（doAlarms driver 含內部簿記）、d1Results、d1Store、
                 cron shell、init CLI
```

monorepo（pnpm workspaces）。未來每個依賴群聚一包：`@datafridge/redis`、`@datafridge/sqlite`、`@datafridge/node`（timer driver）。

### 分包原則

**Package 是配銷單位，不是組合單位** - 組合自由由 core interface 保證，與包邊界無關。

1. **按共享 runtime 依賴群聚**：`@datafridge/cloudflare` 的三個部件（doAlarms、d1、cron shell）綁定同一組依賴（workers-types、workerd、vitest-pool-workers）與發版節奏，所以同包。Redis、SQLite 各自依賴不同 client，各自成包。
2. **包內每個部件是獨立 subpath export**（`@datafridge/cloudflare/do`、`/d1`、`/cron`），想用哪個拿哪個。
3. **任何包不得依賴兄弟包，所有部件只認 core 的 interface**。PollerDO 接受任何 ResultStore，跨包混搭（DO scheduler + Redis results）就是裝兩個包，永遠合法。
4. 純 JS、零平台依賴的部件住 core，不進平台包。
5. Driver 天生平台味（CF 的 scheduled handler、node 的 timer、K8s 的 HTTP endpoint 形狀各不同），按平台長是貼合現實而非偷懶。

## 11. Roadmap（wave 2+）

- `@datafridge/node`（setInterval driver，serialized、簿記可全放 results store 或記憶體）+ `@datafridge/sqlite` + `@datafridge/redis`
- result-plane 讀取加速複本（KV / Cache API；最終一致在 result plane 可接受）
- 精確配額記帳（§9 v2）
- 參數化 queries（`variants: () => params[]`，展開成 name + paramsHash 的子項）
- metrics hook（RunReport 已預留介面）
- QStash / Inngest provisioning driver

## 12. Open questions

- ~~正式名稱與 npm scope~~：已定案 `datafridge`，scope `@datafridge/*`；發布時同時佔 `datafridge` 與 `data-fridge` 本名。
- `read()` 對 null（首輪未完成）要不要提供 `waitForFirst()` 便利方法。
- doAlarms 分片：單 coordinator DO 在幾百個 queries 之後是否需要按 source 分片（v1 明確不做，記錄觸發條件：單次 runDue 逼近 DO 執行時長限制時）。
- envelope 是否提供壓縮選項。
