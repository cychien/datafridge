# datafridge

English | [繁體中文](./README.zh-TW.md)

A fridge for your API data. datafridge restocks it on a schedule (proactive polling), so opening the door is always instant (`read()` never waits on upstream), every item carries a freshness label (`fetchedAt` / `freshUntil` / `isStale`), and when the supermarket burns down there is still food in the fridge (stale-if-error).

> **Status: pre-release.** The API described here follows [DESIGN.md](./DESIGN.md) and may change before the first npm publish. Wave 1 targets Cloudflare only (Durable Object alarms + D1, or Cron Triggers + D1). Everything listed under [Roadmap](#roadmap-wave-2) does not exist yet. See [PLAN.md](./PLAN.md) for milestone status.

## The semantic contract

These six guarantees are the product. Every implementation must uphold them:

1. **Reads always return immediately.** `read()` only touches the result store. It never waits on upstream.
2. **Reads always carry time.** Every result includes `fetchedAt`, so the caller always knows how old the data is.
3. **Stale-if-error.** When upstream fails, the last-known-good result is kept and marked `isStale`. The application never notices.
4. **At-least-once refresh.** If an executor dies mid-run, the work is picked up again after its lease expires. No cleanup process needed.
5. **Write-back consistency.** Expired write-backs from concurrent or zombie executors are rejected. The store is always consistent.
6. **Fail at config time.** Invalid configuration (timeout >= lease, no valid schedule plane, duplicate names) throws at construction, never at runtime.

## Why

- **Request-triggered SWR libraries** (bentocache, cachified, stale-while-revalidate-cache) only refresh when someone reads. No traffic means no freshness, and a cold start swallows the slow query on the first request. datafridge refreshes proactively, so data is always warm.
- **Heavy ETL platforms** (Airbyte, Fivetran) are connector businesses, not plug-and-play libraries you drop into a TypeScript project.
- **Hand-rolled cron + Redis** gets rewritten in every project, and lease handling, backoff, and staleness semantics are never fully done.

datafridge is the combination of **proactive scheduled refresh**, **per-source rate limiting**, and **serve-stale-on-error**, as a TypeScript library with fully orthogonal, swappable modules: the store decides where state lives, the driver decides who ticks, and fetchers run wherever the poller runs.

Non-goals: no API connectors (fetchers are always your own closures), no dashboard, no config DSL (config is code), no transparent proxy (only pre-registered named queries).

## Quick start (Cloudflare)

Wave 1 ships two complete setups on Cloudflare. Both use your own D1 database as the result store.

### Combo A (recommended): Durable Object alarms + D1 results

A Durable Object acts purely as the scheduler: its alarm wakes itself, runs due queries single-threaded, and keeps schedule bookkeeping in its own SQLite (an internal driver detail). Results land in your D1, and readers query D1 directly without touching the DO.

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
    await ensureStarted(env.POLLER) // idempotent; ignites the alarm chain
    const r = await createReader({ results: d1Results(env.DB) }).read('posthog-weekly')
    return Response.json(r)
    // r: { data, fetchedAt, isStale, age } | null (null = first fetch not done yet)
  },
}
```

```toml
# wrangler.toml
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

### Combo B: Cron Triggers + D1 full store

No Durable Object at all. D1 carries both planes: results, and the schedule bookkeeping protected by a compare-and-swap claim (`UPDATE ... WHERE version = ?`), so concurrent cron invocations are safe. Scheduling granularity is capped at 1 minute.

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

### Which one?

| | Combo A (doAlarms) | Combo B (cron + D1 CAS) |
|---|---|---|
| Scheduling granularity | any timestamp | 1-minute floor |
| Dynamic rescheduling | yes (backoff, runtime frequency changes) | tick is fixed; due checks stay dynamic |
| Concurrency protection | driver is serialized, zero cost | D1 CAS claim |
| Moving parts | DO + D1 | D1 only |

See [docs/cloudflare.md](./docs/cloudflare.md) for lifecycle details (alarm chain ignition, registry reconcile) and platform limits.

## Reading from anywhere

Results are plain JSON envelopes in the result store. Any process that can reach the store can read, with no poller present:

```ts
import { createReader } from '@datafridge/core'

const reader = createReader({ results: d1Results(env.DB) })
const r = await reader.read<WeeklyReport>('posthog-weekly')
```

A full poller also exposes `poller.read()` directly, so the home that runs the poller does not need a separate reader. Consumers in other languages only need to read the underlying store; the envelope format is plain JSON.

## Documentation

- [docs/concepts.md](./docs/concepts.md) - the two planes, envelope and schedule row, staleness and failure semantics
- [docs/cloudflare.md](./docs/cloudflare.md) - both combos in detail, lifecycle, platform limits
- [docs/writing-adapters.md](./docs/writing-adapters.md) - ResultStore / ScheduleStore / Driver contracts and how adapters are accepted
- [docs/rate-limiting.md](./docs/rate-limiting.md) - per-tick budgets, jitter, and when precise quota accounting is worth it

## Roadmap (wave 2+)

Planned, not available today:

- `@datafridge/node` (setInterval driver), `@datafridge/sqlite`, `@datafridge/redis`
- Result-plane read replicas (KV / Cache API; eventual consistency is acceptable on the result plane)
- Precise per-source quota accounting (see [docs/rate-limiting.md](./docs/rate-limiting.md))
- Parameterized queries (`variants: () => params[]`)
- Metrics hook (the `RunReport` interface is already reserved for it)
- QStash / Inngest provisioning drivers
- `npx datafridge init cloudflare` scaffolding CLI (wave 1, milestone M3)
