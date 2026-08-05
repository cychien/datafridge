# Cloudflare（wave 1）

[English](../cloudflare.md) | 繁體中文

Wave 1 提供兩個 driver 與一個 store，組成兩套完整的接法。兩者各自完全可用，合起來則證明模組真的正交。

## 組合 A（推薦）：doAlarms driver + D1 result store

Durable Object 在這裡的身分是 **scheduler**：alarm 自我喚醒、`runDue` 單線程執行、排程簿記存在 DO 自己的 SQLite（driver 內部細節，外界不可見）。產品的 store 是你自己的 D1。

```
      setAlarm(min(nextRunAt))
      ┌──────────────────────────────┐
      │ PollerDO - doAlarms driver    │
      │  bookkeeping (ScheduleRows):  │
      │  own SQLite, serialized,      │
      │  no CAS needed                │
      │  alarm() -> runDue(now)       │
      │  fetchers execute here        │
      └───────────┬──────────────────┘
                  │ writeResult(envelope)
                  ▼
      ┌──────────────────────────────┐
      │ D1 (result plane, your DB)    │
      └───────────┬──────────────────┘
                  │ direct SELECT, no DO involved
                  ▼
        any Worker / createReader
```

讀取端直讀 D1，永遠不碰 DO - 讀路徑上沒有任何運行中的 datafridge 元件。

```ts
// poller.ts
import { defineQueries } from '@datafridge/core'
import { PollerDO, d1Results } from '@datafridge/cloudflare'

const queries = defineQueries([
  {
    name: 'posthog-weekly',
    every: '10m',
    source: 'posthog',
    fetch: ({ signal }) => posthogQuery(weeklyReportSql, { signal }),
  },
])

export class Poller extends PollerDO {
  queries = queries
  results(env: Env) {
    return d1Results(env.DB)
  }
}
```

```ts
// worker.ts - the read side; same Worker or a completely different one
import { createReader } from '@datafridge/core'
import { d1Results, ensureStarted } from '@datafridge/cloudflare'

export default {
  async fetch(req, env) {
    await ensureStarted(env.POLLER)
    const r = await createReader({ results: d1Results(env.DB) }).read('posthog-weekly')
    return Response.json(r)
  },
}
```

```toml
# wrangler.toml - the only infra declaration you touch
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

### Alarm loop

```
alarm():
  try {
    report = core.runDue(now)
  } finally {
    next = min(nextRunAt of all rows)
    setAlarm(max(next, now + 1s))    // the finally guarantees the alarm chain never breaks
  }
```

Per-query 錯誤全部收進 `failCount`；alarm handler 本身幾乎不 throw。throw 會觸發 DO 平台自己的 alarm 重試，那是最後一層保底，不是常規路徑。

### 生命週期細節

1. **Alarm 鏈點火。** DO 要被喚醒過至少一次才有 alarm。`ensureStarted()` 是冪等 RPC - 已有 alarm 就直接返回。掛在讀取路徑上（如上例），或掛在 init script 的部署後 curl，都可以。
2. **Registry reconcile。** 你改了 `queries` 重新部署後，`ensureStarted()` 與每次 alarm 的開頭會比對 registry 與簿記 rows：新 query 建 row（帶 jitter）、消失的 query 刪除其 row 與 envelope、`every` 變更則重算 `nextRunAt`。

## 組合 B：Cron Triggers + D1 full store

完全不用 Durable Object。Schedule plane 走 [resolution 規則](./writing-adapters.md#schedule-plane-的-resolution-規則fail-at-config-time)第 3 條，落在 D1 自己身上（`UPDATE ... WHERE version = ?` 作為 CAS）。併發的 cron invocation 由 claim 保護。

```ts
import { defineQueries, createPoller } from '@datafridge/core'
import { d1Store } from '@datafridge/cloudflare'

const queries = defineQueries([
  {
    name: 'posthog-weekly',
    every: '10m',
    source: 'posthog',
    fetch: ({ signal }) => posthogQuery(weeklyReportSql, { signal }),
  },
])

export default {
  scheduled: (event, env, ctx) =>
    ctx.waitUntil(createPoller({ store: d1Store(env.DB), queries }).runDue()),
}
```

```toml
# wrangler.toml
[triggers]
crons = ["* * * * *"] # minimum granularity: 1 minute
```

適合不想管 DO、能接受 1 分鐘粒度的人。Fetcher 在 Worker 的 scheduled invocation 裡執行。

## 怎麼選

| | 組合 A（doAlarms） | 組合 B（cron + D1 CAS） |
|---|---|---|
| 排程粒度 | 任意 timestamp | 1 分鐘下限 |
| 排程可動態調整 | 可（backoff、runtime 改頻率） | tick 固定，due 判斷仍動態 |
| 併發保護 | driver 序列化，零成本 | D1 CAS claim |
| 元件 | DO + D1 | 只有 D1 |

`npx datafridge init cloudflare` 會自動寫入兩種組合的 wrangler 宣告，已列入計劃（里程碑 M3），但目前還不存在。

## 平台限制

- fetch 的 `timeout` 上限受 invocation 時長限制；`defineQueries` 在建構時驗證。
- D1 是單區域：遠端 PoP 的讀取有跨區延遲。對本產品的語意而言可接受，但值得知道。大流量讀取的加速複本在 roadmap 上。
- Envelope 大小受 D1 單 row 上限約束；實作以當前官方文件為準，並在 `writeResult` 防呆。
