# Cloudflare (wave 1)

English | [繁體中文](./zh-TW/cloudflare.md)

Wave 1 ships two drivers and one store, composing into two complete setups. Both are fully usable on their own, and together they demonstrate that the modules really are orthogonal.

## Combo A (recommended): doAlarms driver + D1 result store

The Durable Object's role here is **scheduler**: its alarm wakes itself up, `runDue` executes single-threaded, and the schedule bookkeeping lives in the DO's own SQLite (a driver-internal detail, invisible from outside). The product's store is your own D1.

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

Readers hit D1 directly, never the DO - the read path contains no running datafridge component at all.

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

### The alarm loop

```
alarm():
  try {
    report = core.runDue(now)
  } finally {
    next = min(nextRunAt of all rows)
    setAlarm(max(next, now + 1s))    // the finally guarantees the alarm chain never breaks
  }
```

Per-query errors are all absorbed into `failCount`; the alarm handler itself almost never throws. A throw would trigger the DO platform's own alarm retry, which is the last-resort safety net, not a regular path.

### Lifecycle details

1. **Alarm chain ignition.** A DO has no alarm until it has been woken at least once. `ensureStarted()` is an idempotent RPC - if an alarm already exists, it returns immediately. Hook it into the read path (as above) or into a post-deploy curl from your init script; either works.
2. **Registry reconcile.** After you change `queries` and redeploy, `ensureStarted()` and the start of every alarm compare the registry against the bookkeeping rows: new queries get a row (with jitter), removed queries have their row and envelope deleted, and a changed `every` recomputes `nextRunAt`.

## Combo B: Cron Triggers + D1 full store

No Durable Object at all. The schedule plane resolves via rule 3 of the [resolution rules](./writing-adapters.md#schedule-plane-resolution-rules-fail-at-config-time) onto D1 itself (`UPDATE ... WHERE version = ?` as the CAS). Concurrent cron invocations are protected by the claim.

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

Right for people who do not want to manage a DO and can accept 1-minute granularity. Fetchers execute inside the Worker's scheduled invocation.

## Choosing between them

| | Combo A (doAlarms) | Combo B (cron + D1 CAS) |
|---|---|---|
| Scheduling granularity | any timestamp | 1-minute floor |
| Dynamic rescheduling | yes (backoff, runtime frequency changes) | tick is fixed; due checks stay dynamic |
| Concurrency protection | driver is serialized, zero cost | D1 CAS claim |
| Moving parts | DO + D1 | D1 only |

An `npx datafridge init cloudflare` command that writes the wrangler declarations for both combos is planned (milestone M3), but does not exist yet.

## Platform limits

- The fetch `timeout` ceiling is bounded by invocation duration limits; `defineQueries` validates this at construction time.
- D1 is single-region: reads from remote PoPs pay cross-region latency. That is acceptable for this product's semantics, but worth knowing. Read replicas for high-traffic reads are on the roadmap.
- Envelope size is bounded by D1's single-row limit; the implementation follows the current official documentation and guards in `writeResult`.
