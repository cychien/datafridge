# Cloudflare 設定與營運

[English](../cloudflare.md) | 繁體中文

Cloudflare Wave 1 提供兩套完整組合。兩者都使用 D1 儲存 result envelopes，並遵守[六點語意契約](../../README.zh-TW.md#語意契約)。

## 安裝與初始化

```sh
pnpm add @datafridge/core @datafridge/cloudflare
pnpm exec datafridge init cloudflare
```

Init CLI 會 idempotently 把兩種組合的 declarations 加到 `wrangler.toml`。其他 TOML file 可使用 `--config <path>`。它會保留既有 declarations、列出需要手動放置的設定，並拒絕在既有 `wrangler.json` 或 `wrangler.jsonc` 旁建立 TOML。

檢查輸出後，保留一種 scheduling 組合並刪除未使用的 declarations。建立或選擇 D1 database、替換產生的 `database_id`，再套用 package schema：

```sh
pnpm exec wrangler d1 execute YOUR_DATABASE --remote \
  --file node_modules/@datafridge/cloudflare/migrations/0001_datafridge_init.sql
```

上游 credential 必須使用 Worker secret。不要把 credential 放入 query name、parameter object、log 或 `wrangler.toml`：

```sh
pnpm exec wrangler secret put UPSTREAM_API_TOKEN
```

## 組合 A：Durable Object alarms + D1 results

需要精確 due timestamp 的 alarm、可動態調整的 backoff，或 serialized schedule coordination 時，使用組合 A。

```ts
import { createReader, defineQueries } from '@datafridge/core'
import type { RunReport } from '@datafridge/core'
import { d1Results, ensureStarted, PollerDO } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
  UPSTREAM_API_TOKEN: string
}

export class Poller extends PollerDO<Env> {
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

  results(env: Env) {
    return d1Results(env.DB)
  }

  protected override onRunReport(report: RunReport) {
    console.log({
      ran: report.ran.length,
      skippedLeased: report.skippedLeased.length,
      deferredBudget: report.deferredBudget.length,
      failed: report.failed.length,
    })
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

`ensureStarted(namespace, instanceName?)` 會喚醒 object；目前 registry 還沒有 alarm 時，排定 immediate alarm。預設 instance name 是 `datafridge-poller`。每次 read 都呼叫是安全的，部署後也能重新啟動 alarm chain。

每次 alarm 會：

1. 解析並驗證 registry。
2. Reconcile schedule rows 與 envelopes。
3. 透過 core engine 執行 due queries。
4. 呼叫 `onRunReport(report)`。
5. 在 `finally` 排定下一個 alarm，即使 reconcile、storage 或 report hook 失敗也一樣。

有限 parameter variants 改變時，從 `queries` getter 回傳重新建構的 registry。新增 variant 會建立 row；移除 variant 會刪除 row 與 envelope。詳見 [parameterized API](./api.md#parameterized-queries)。

`onRunReport` 用於 operational evidence，不是 payload logging。建議只記錄 category count 或 allowlisted identity。Error message 來自 application fetcher，可能含有 sensitive data，寫 log 前必須 sanitize。

## 組合 B：Cron Triggers + D1 full store

可接受 scheduler 最低 1 分鐘，而且希望 D1 是唯一 stateful platform component 時，使用組合 B。

```ts
import { defineQueries } from '@datafridge/core'
import { cronPoller, d1Store } from '@datafridge/cloudflare'

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
  scheduled: cronPoller<Env>({
    queries,
    store: (env) => d1Store(env.DB),
    sources: { analytics: { maxPerTick: 2 } },
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

Cron invocation 可能重疊，因此 `cronPoller` 使用 non-serialized driver，並要求 atomic schedule store。`d1Store` 以 version-checked D1 update claim。只有 `results` 的非法設定會在 `cronPoller` 建構時失敗。

Scheduled handler 需要取得 `RunReport` 時，可直接搭配 `createPoller` 使用 `cronDriver(ctx)`：

```ts
const poller = createPoller({
  queries,
  driver: cronDriver(ctx),
  store: d1Store(env.DB),
})
const report = await poller.runDue()
ctx.waitUntil(writeSanitizedOperations(report))
```

## 選擇組合

| | 組合 A | 組合 B |
|---|---|---|
| Scheduler | Durable Object alarms | Cron Triggers |
| Schedule state | Durable Object SQLite | D1 |
| Claims | Serialized actor | D1 compare-and-swap |
| Result state | D1 | D1 |
| Scheduler floor | 1 秒 safety floor | 1 分鐘 |
| Dynamic due time | Alarm 移到下一筆 due row | Cron 固定，due check 維持動態 |

不要把 Cron Triggers 與 `d1Results` 單獨組合。它沒有 schedule plane，建構時會拒絕此設定。

## 建構時驗證

- `defineQueries` 驗證 names、durations、fetchers、duplicate variants 與 `timeout < lease`。
- `PollerDO` 在啟動與每次 alarm 前驗證 registry、source budgets 與 Cloudflare wall-clock ceiling。
- `cronPoller` 在建構時驗證 registry、store-factory shape、schedule-plane resolution 與 wall-clock ceiling。
- Cloudflare query timeout 必須短於 15 分鐘。
- Source budget 必須是正整數。

## 失敗與復原

| 情況 | Schedule 行為 | Read 行為 |
|---|---|---|
| 上游錯誤或 timeout | 增加 failure count，以 capped exponential backoff 重試 | 保留最後成功 envelope，顯示 stale 與 `lastError` |
| Live lease | Identity 放入 `skippedLeased`，不重複 fetch | 立即回傳目前 envelope |
| Executor 死亡 | Lease 過期後 reclaim | 立即回傳目前 envelope |
| Zombie 遲到寫回 | Version mismatch 時拒絕 | 保持不變 |
| Per-source budget 用完 | 保持 due，留待後續 tick | 立即回傳目前 envelope |
| 尚未成功 refresh | 繼續 scheduled attempts | 回傳 `null` |
| Alarm-level error | 在 `finally` 排定下一個 alarm | 既有 D1 envelopes 仍可讀 |

Backoff 為 `min(every, 1m * 2^(failCount - 1))` 加 jitter。成功後 failure count 歸零。正常 interval 採用從 fetch 完成時間起算的 fixed-delay semantics。

## 營運 checklist

1. 第一次 invocation 前套用 D1 schema。
2. 把上游 credential 放入 Worker secrets。
3. Query params 保持非機密且數量有限。
4. 部署 Worker。組合 A 需呼叫一次會執行 `ensureStarted` 的 route。
5. 確認 result rows 出現，read 回傳 `{ data, fetchedAt, isStale, age }`。
6. 記錄 sanitized `RunReport` categories、alarm continuity，以及 observation 開始時間與結束條件。
7. 使用已授權且受控的上游條件測試 failure handling。確認舊 envelope 保留，後續 report 顯示失敗與恢復，且 log 不含 payload。
8. 監控 D1 row size。超過 2,000,000 bytes 的 envelope 會被拒絕，舊 envelope 保留。

D1 是 single-region，remote PoP reader 可能產生跨區 latency。Result-plane replica 不在已發布範圍內。

## Subpath imports

```ts
import { PollerDO, ensureStarted } from '@datafridge/cloudflare/do'
import { d1Results, d1Store } from '@datafridge/cloudflare/d1'
import { cronDriver, cronPoller } from '@datafridge/cloudflare/cron'
```

Package root 也會 re-export 以上 API。
