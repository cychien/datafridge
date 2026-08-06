# Cloudflare 設定與營運

[English](../cloudflare.md) | 繁體中文

這份文件是 Cloudflare 各 module 的設定與營運指南：`FridgeDO` 與 `ensureStarted` 負責 alarm 排程、`cronDriver` 與 `cronFridge` 負責 Cron Triggers、`d1` 負責儲存。每個 module 各自填哪個位置，見 [README 的 module 清單](../../README.zh-TW.md#接上-scheduler-與-store)。以下每一種組法都把 result envelope 存在 D1，並遵守[六點語意契約](./concepts.md#語意契約)。

## 安裝與初始化

```sh
pnpm add @datafridge/core @datafridge/cloudflare
pnpm exec datafridge init --scheduler durable-object --store d1
# 或：--scheduler cron --store d1
```

你指定 scheduler 和 store，CLI 只會 idempotently 加入那個組合需要的東西：Durable Object binding 加它的 SQLite class migration，或是 `[triggers]` 的 cron，再加上 D1 binding。不會寫出任何需要你事後刪掉的東西。其他 TOML file 可使用 `--config <path>`。它會保留既有 declarations、列出需要手動放置的設定，並拒絕在既有 `wrangler.json` 或 `wrangler.jsonc` 旁建立 TOML（這時它會把 declarations 印出來讓你自己放）。

使用 Durable Object scheduler 時，`class_name` 必須與你的 Worker 匯出的 `FridgeDO` subclass 名稱一致。

`database_id` 是 CLI 唯一填不了的欄位，它會寫成 `TODO`。執行 `pnpm exec wrangler d1 create datafridge`，或選一個既有的 database，把它印出來的 ID 貼進去。

設定到這裡就結束了。`d1()` 會在第一次寫入前自己建表，所以空的 database 直接就能用。如果你希望 schema 由自己的 pipeline 宣告，package 內附的 migration 是一模一樣的語句（有測試盯著兩邊不漂移），先套用它就會讓自動建表變成 no-op：

```sh
pnpm exec wrangler d1 execute YOUR_DATABASE --remote \
  --file node_modules/@datafridge/cloudflare/migrations/0001_datafridge_init.sql
```

上游 credential 必須使用 Worker secret。不要把 credential 放入 query name、parameter object、log 或 `wrangler.toml`：

```sh
pnpm exec wrangler secret put UPSTREAM_API_TOKEN
```

## Durable Object alarms：`FridgeDO`

這條路的 scheduler 就是你匯出的那個 class：`wrangler` 依 `class_name` 實例化它，它的 alarm 迴圈推動每一個 tick。`FridgeDO` 是 serialized driver，而且自帶排程簿記，所以它只需要一個地方放 envelope。需要精確 due timestamp 的 alarm、可動態調整的 backoff，或 serialized schedule coordination 時，用它。

```ts
import { createReader, defineQueries } from '@datafridge/core'
import type { RunReport } from '@datafridge/core'
import { d1, ensureStarted, FridgeDO } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
  UPSTREAM_API_TOKEN: string
}

export class Poller extends FridgeDO<Env> {
  queries = defineQueries([
    {
      name: 'weekly-summary',
      every: '10m',
      timeout: '30s',
      source: 'analytics',
      fetch: async ({ signal }) => {
        const response = await fetch('https://api.example.com/weekly-summary', {
          signal,
          headers: { authorization: `Bearer ${this.env.UPSTREAM_API_TOKEN}` },
        })
        if (!response.ok) throw new Error(`upstream status ${response.status}`)
        return response.json()
      },
    },
  ])

  store(env: Env) {
    return d1(env.DB)
  }

  protected override onRunReport(report: RunReport) {
    console.log({
      ran: report.ran.length,
      skippedLeased: report.skippedLeased.length,
      throttled: report.throttled.length,
      failed: report.failed.length,
    })
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

Durable Object 只在自己的 SQLite 儲存 schedule rows。Fetcher 在 object 中執行、envelope 寫入 D1，read path 則直接查詢 D1。

### Alarm lifecycle

`ensureStarted(namespace, instanceName?)` 會喚醒 object；目前 registry 還沒有 alarm 時，排定 immediate alarm。預設 instance name 是 `datafridge`。每次 read 都呼叫是安全的，部署後也能重新啟動 alarm chain。若想讓 request path 完全不碰它，就別 await，改交給 handler 的 `ExecutionContext`：`ctx.waitUntil(ensureStarted(env.POLLER))`，或改在部署後的 hook 呼叫。

每次 alarm 會：

1. 解析並驗證 registry。
2. Reconcile schedule rows 與 envelopes。
3. 透過 core engine 執行 due queries。
4. 呼叫 `onRunReport(report)`。
5. 在 `finally` 排定下一個 alarm，即使 reconcile、storage 或 report hook 失敗也一樣。

Variant 清單會在執行期改變時，把它宣告成函式 - 每次 alarm 都會重新解析，而且可以是 async。新增 variant 會建立 row；移除 variant 會刪除 row 與 envelope。詳見 [parameterized API](./api.md#parameterized-queries)。

`onRunReport` 用於 operational evidence，不是 payload logging。建議只記錄 category count 或 allowlisted identity。Error message 來自 application fetcher，可能含有 sensitive data，寫 log 前必須 sanitize。

## Cron Triggers：`cronFridge`

這條路的 scheduler 就是你匯出的那個 handler：Cloudflare 的 cron trigger 會呼叫 `scheduled`，所以沒有東西需要自己點火，也沒有 `ensureStarted`。`cronDriver` 不是 serialized 的，所以它需要 atomic claim，而 `d1` 正好提供。可接受 scheduler 最低 1 分鐘，而且希望 D1 是唯一 stateful platform component 時，用這個配對。

```ts
import { defineQueries } from '@datafridge/core'
import { cronFridge, d1 } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
  UPSTREAM_API_TOKEN: string
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
  scheduled: cronFridge<Env>({
    queries,
    store: (env) => d1(env.DB),
    sources: { analytics: { limit: { requests: 100, per: '1m', reserve: 10 } } },
  }),
}
```

```toml
[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "datafridge"
database_id = "..."
```

Cron invocation 可能重疊，因此 `cronFridge` 使用 non-serialized driver，並要求 atomic schedule store。`d1` 以 version-checked D1 update claim。只有 `results` 的非法設定會在 `cronFridge` 建構時失敗。

想觀察每個 tick 就傳 `onRunReport`，它與 `FridgeDO` 的 hook 同一份「寫 log 前先 sanitize」契約。若 handler 需要對 `RunReport` 做的事超過觀察，可直接搭配 `createFridge` 使用 `cronDriver(ctx)`：

```ts
const fridge = createFridge({
  queries,
  driver: cronDriver(ctx),
  store: d1(env.DB),
})
const report = await fridge.runDue()
ctx.waitUntil(writeSanitizedOperations(report))
```

## 選擇 scheduler

| | `FridgeDO` | `cronFridge` |
|---|---|---|
| Driver | Durable Object alarms | Cron Triggers |
| Schedule plane | Durable Object SQLite | D1 |
| Claims | Serialized actor | D1 compare-and-swap |
| Result plane | D1 | D1 |
| Scheduler 粒度 | 精確的 alarm timestamp，最低 1 秒 | 最低 1 分鐘 |
| Dynamic due time | Alarm 移到下一筆 due row | Cron 固定，due check 維持動態 |
| 平台元件 | Durable Object + D1 | 只有 D1 |
| 何時選它 | 你要精確的到期時間與動態 backoff | 你不想多管一個 Durable Object |

這兩組是 Cloudflare 上已完整出貨的組法，不是唯一合法的組法：只要 schedule plane 解析得出來，任何組合都成立。Cron Triggers 單獨搭一個只有 result 的 store 不成立 - 它沒有 schedule plane，建構時會直接拒絕，而不是默默重複 fetch。

## 建構時驗證

- `defineQueries` 驗證 names、durations、fetchers、duplicate variants、`timeout < lease` 與 `retain > every`。
- `FridgeDO` 在啟動與每次 alarm 前驗證 registry、source policies 與 Cloudflare wall-clock ceiling。
- `cronFridge` 在建構時驗證 registry、store-factory shape、schedule-plane resolution 與 wall-clock ceiling。
- Cloudflare query timeout 必須短於 15 分鐘。
- Source policy 必須宣告 `limit`、`maxConcurrent` 或兩者；`limit.requests`、`limit.per` 與 `maxConcurrent` 必須為正，`limit.reserve` 必須小於 `limit.requests`。

## Cloudflare 上的 on-demand entries

`retain` query 在這裡比宣告過的 query 多需要兩件事。

讀取路徑是 reader，所以記錄讀取的也是 reader - 而沒有人記錄讀取的 entry 就是會被清掉的 entry。給它 `d1(env.DB)`（它有 `touchResult`），並把該次 invocation 的 `waitUntil` 交給它，否則 Worker 可能在時間戳寫完前就被收掉：

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const reader = createReader({
      store: d1(env.DB),
      queries,
      defer: (promise) => ctx.waitUntil(promise),
    })
    return Response.json(await reader.read('course-funnel', { courseId: 'course-a' }))
  },
}
```

另外，schedule plane 必須能列出自己的 row，因為沒有人宣告過的 entry 只能靠列舉已存的東西找回來。兩個已出貨的 plane 都可以 - `FridgeDO` 的 SQLite 與 `d1` 的排程那一半 - 所以這一條只會咬到自己手寫的實作。

## 失敗與復原

| 情況 | Schedule 行為 | Read 行為 |
|---|---|---|
| 上游錯誤或 timeout | 增加 failure count，以 capped exponential backoff 重試 | 保留最後成功 envelope，顯示 stale 與 `lastError` |
| Live lease | Identity 放入 `skippedLeased`，不重複 fetch | 立即回傳目前 envelope |
| Executor 死亡 | Lease 過期後 reclaim | 立即回傳目前 envelope |
| Zombie 遲到寫回 | Version mismatch 時拒絕 | 保持不變 |
| Per-source 額度用完 | 保持 due 且更過期，留待後續 tick | 立即回傳目前 envelope；miss 時為 `status: 'throttled'` |
| 尚未成功 refresh | 繼續 scheduled attempts | 回傳 `null` |
| Alarm-level error | 在 `finally` 排定下一個 alarm | 既有 D1 envelopes 仍可讀 |

Backoff 為 `min(every, 1m * 2^(failCount - 1))` 加 jitter。成功後 failure count 歸零。正常 interval 採用從 fetch 完成時間起算的 fixed-delay semantics。

## 營運 checklist

1. 可選：套用內附的 D1 migration；不套的話第一次寫入就會建表。
2. 把上游 credential 放入 Worker secrets。
3. Query params 保持非機密且數量有限。
4. 部署 Worker。以 `FridgeDO` 當 scheduler 時，需呼叫一次會執行 `ensureStarted` 的 route。
5. 確認 result rows 出現，read 回傳 `{ data, fetchedAt, isStale, age }`。
6. 記錄 sanitized `RunReport` categories、alarm continuity，以及 observation 開始時間與結束條件。
7. 使用已授權且受控的上游條件測試 failure handling。確認舊 envelope 保留，後續 report 顯示失敗與恢復，且 log 不含 payload。
8. 監控 D1 row size。超過 2,000,000 bytes 的 envelope 會被拒絕，舊 envelope 保留。

D1 是 single-region，remote PoP reader 可能產生跨區 latency。Result-plane replica 不在已發布範圍內。

單一 `FridgeDO` instance 負責協調整個 registry。依 source 分片是刻意不做的；重新評估它的觸發條件，是單次 `runDue` 逼近 Durable Object invocation 的 wall-clock 上限，而數十個 query 的 registry 距離那個門檻還很遠。

## Subpath imports

```ts
import { FridgeDO, ensureStarted } from '@datafridge/cloudflare/do'
import { d1 } from '@datafridge/cloudflare/d1'
import { cronDriver, cronFridge } from '@datafridge/cloudflare/cron'
```

Package root 也會 re-export 以上 API。
