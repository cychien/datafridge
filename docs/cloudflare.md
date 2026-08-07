# Cloudflare setup and operations

English | [繁體中文](./zh-TW/cloudflare.md)

This page is the setup and operations home for the Cloudflare modules: `FridgeDO` and `ensureStarted` for alarm-driven scheduling, `cronDriver` and `cronFridge` for Cron Triggers, and `d1` for storage. Which position each module fills is in the [README's module list](../README.md#wiring-a-scheduler-and-a-store). Every arrangement below stores result envelopes in D1 and preserves the [six-point semantic contract](./concepts.md#the-semantic-contract).

## Install and initialize

```sh
pnpm add @datafridge/core @datafridge/cloudflare
pnpm exec datafridge init --scheduler durable-object --store d1
# or: --scheduler cron --store d1
```

You name the scheduler and the store, and the CLI idempotently adds only what that combination needs: the Durable Object binding and its SQLite class migration, or the `[triggers]` cron, plus the D1 binding. Nothing is written for you to delete afterwards. Pass `--config <path>` for another TOML file. It preserves existing declarations, reports declarations that need manual placement, and refuses to create TOML beside an existing `wrangler.json` or `wrangler.jsonc` (it prints the declarations for you to place by hand instead).

With the Durable Object scheduler, `class_name` has to match the `FridgeDO` subclass your Worker exports.

The `database_id` is the one thing the CLI cannot fill in, so it writes `TODO` there. Run `pnpm exec wrangler d1 create datafridge`, or pick an existing database, and paste the ID it prints.

That is all the setup there is. `d1()` applies its own tables before its first write, so an empty database works. If you would rather declare the schema in your own pipeline, the packaged migration holds exactly the same statements - a test keeps the two from drifting - and applying it makes the automatic step a no-op:

```sh
pnpm exec wrangler d1 execute YOUR_DATABASE --remote \
  --file node_modules/@datafridge/cloudflare/migrations/0001_datafridge_init.sql
```

Use Worker secrets for upstream credentials. Never put a credential in a query name, parameter object, log, or `wrangler.toml`:

```sh
pnpm exec wrangler secret put UPSTREAM_API_TOKEN
```

## Durable Object alarms: `FridgeDO`

The scheduler here is the class you export: `wrangler` instantiates it by `class_name` and its alarm loop drives every tick. `FridgeDO` is a scheduler and nothing else - it keeps no dispatch state of its own, and works entirely against the Store you give it. Use it when you want alarms at exact due timestamps and dynamic backoff without fixed cron wakeups.

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

**D1 is the whole coordination plane.** Schedule rows, leases, versions, backoff, the quota ledger and result envelopes all live there; the object's own SQLite holds one row recording which registry it last ignited for, and nothing else. That is what lets a second scheduler, a cron trigger, or any number of request-path readers work against the same data without going through this object - and it is why the read path never does. Fetchers for scheduled refreshes execute in the object; reads are served wherever the request landed.

### Alarm lifecycle

`ensureStarted(namespace, instanceName?)` wakes the object and schedules an immediate alarm unless the current registry already has one. The default instance name is `datafridge`. Calling it on every read is safe and also re-ignites the chain after a deployment. To keep the request path clear of it, hand it to the handler's `ExecutionContext` with `ctx.waitUntil(ensureStarted(env.POLLER))` instead of awaiting it, or call it from a post-deploy hook.

Every alarm:

1. Resolves and validates the registry.
2. Reconciles schedule rows and envelopes.
3. Runs due queries through the core engine.
4. Calls `onRunReport(report)`.
5. Schedules the next alarm in `finally`, even if reconciliation, storage, or the report hook fails.

For a variant list that changes at runtime, declare it as a function - it is resolved at every alarm, and may be async. Added variants get new rows; removed variants lose both their row and envelope. See the [parameterized API](./api.md#parameterized-queries).

`onRunReport` is for operational evidence, not payload logging. Prefer category counts or allowlisted identities. Error messages originate in application fetchers and may be sensitive, so sanitize them before logging.

## Cron Triggers: `cronFridge`

The scheduler here is the handler you export: Cloudflare's cron trigger calls `scheduled`, so nothing has to ignite itself and there is no `ensureStarted`. `cronDriver` is not serialized, so it needs atomic claims - which `d1` provides. Use this pairing when a one-minute scheduler floor is acceptable and you prefer D1 as the only stateful platform component.

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

Cron invocations can overlap, so `cronFridge` uses a non-serialized driver and requires an atomic schedule store. `d1` claims with a version-checked D1 update. Invalid `results`-only configurations fail when `cronFridge` is constructed.

Pass `onRunReport` to observe each tick under the same sanitize-before-logging contract as the `FridgeDO` hook. Use `cronDriver(ctx)` with `createFridge` directly when the handler needs to do more with the `RunReport` than observe it:

```ts
const fridge = createFridge({
  queries,
  driver: cronDriver(ctx),
  store: d1(env.DB),
})
const report = await fridge.runDue()
ctx.waitUntil(writeSanitizedOperations(report))
```

## Choosing a scheduler

| | `FridgeDO` | `cronFridge` |
|---|---|---|
| Driver | Durable Object alarms | Cron Triggers |
| Schedule plane | D1 | D1 |
| Claims | Serialized actor | D1 compare-and-swap |
| Result plane | D1 | D1 |
| Scheduler floor | Exact alarm timestamp, 1-second safety floor | 1 minute |
| Dynamic due time | Alarm moves to the next due row | Cron stays fixed; due checks remain dynamic |
| Platform components | Durable Object + D1 | D1 only |
| Pick it when | You want exact due times and dynamic backoff | You would rather not run a Durable Object |

Those two are the arrangements that ship complete on Cloudflare, not the only legal ones: any composition works as long as the schedule plane resolves. Cron Triggers with a result-only store does not - it has no schedule plane, and construction rejects the configuration rather than quietly double-fetching.

## Construction-time validation

- `defineQueries` validates names, durations, fetchers, duplicate variants, `timeout < lease`, and that an `anyParams` base declares no list, `every`, `lease`, `validUntil` or `codec`.
- `FridgeDO` validates its registry, source policies, and the Cloudflare wall-clock ceiling during ignition and before alarms.
- `cronFridge` validates its registry, store-factory shape, schedule-plane resolution, and wall-clock ceiling when constructed.
- A Cloudflare query timeout must be shorter than 15 minutes.
- A source policy must declare a `limit`, a `maxConcurrent`, or both; `limit.requests`, `limit.per` and `maxConcurrent` must be positive, and `limit.reserve` must be smaller than `limit.requests`.

## The request path

Give the reader the whole `d1(env.DB)` store, the registry, the source policies, and `ctx.waitUntil` as `defer`, and it is a complete read path: it serves what is stored, fills a cold entry itself through the same dispatcher a tick uses, and answers `anyParams` params with one fresh call.

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(ensureStarted(env.POLLER))
    const reader = createReader({
      store: d1(env.DB),
      queries,
      sources,
      defer: (promise) => ctx.waitUntil(promise),
    })
    return Response.json(await reader.read('course-funnel', { courseId: 'course-a' }))
  },
}
```

Nothing here goes through the Durable Object. Reads scale with your Worker rather than queueing behind one singleton, and because every call still leaves through the dispatcher against the same D1, the source ceiling counts them alongside the scheduler's - the two coordinate through the store, which is the only place they meet.

Hand the reader a results-only store instead and it goes back to serving and waiting, which is the right shape for a consumer in another service that should never call upstream. A registry with an `anyParams` base then fails at construction rather than at read time.

## Failure and recovery

| Condition | Schedule behavior | Read behavior |
|---|---|---|
| Upstream error or timeout | Increment failure count and retry with capped exponential backoff | Keep last good envelope, expose stale state and `lastError` |
| Live lease | Put the identity in `skippedLeased`; no duplicate fetch | Return the current envelope immediately |
| Executor death | Reclaim after lease expiry | Return the current envelope immediately |
| Late zombie write | Reject on version mismatch | Remain unchanged |
| Per-source quota exhausted | Keep due for a later tick, more overdue | Return the current envelope; on a miss, `status: 'throttled'` |
| Past this invocation's capacity | Leave the row untouched and name it in `RunReport.deferred`; the alarm re-arms on the tick's own `nextRunAt` | Unaffected: a read never waits on a tick |
| No successful refresh yet | Continue scheduled attempts | Return `null` |
| Alarm-level error | Schedule the next alarm in `finally` | Existing D1 envelopes remain readable |

Backoff is `min(every, 1m * 2^(failCount - 1))` plus jitter. Success resets the failure count. The normal interval uses fixed-delay semantics from fetch completion.

## Operational checklist

1. Optionally apply the packaged D1 migration; otherwise the first write creates the tables.
2. Put upstream credentials in Worker secrets.
3. Keep query params non-secret and finite.
4. Deploy the Worker and, when `FridgeDO` is the scheduler, call a route that invokes `ensureStarted` once.
5. Confirm result rows appear and reads return `{ data, fetchedAt, isStale, age }`.
6. Record sanitized `RunReport` categories, alarm continuity, and an observation start and end condition.
7. Test failure handling with an authorized, controlled upstream condition. Verify the old envelope remains and subsequent reports show failure and recovery without logging payloads.
8. Monitor D1 row size. Envelopes above 2,000,000 bytes are rejected and the previous envelope remains.

D1 is single-region, so readers at remote PoPs can incur cross-region latency. Result-plane replicas are outside the shipped scope.

One `FridgeDO` instance drives the schedule for the entire registry, and reads never go through it. Sharding the scheduler by source is deliberately not implemented; the condition that would justify reconsidering it is a single `runDue` approaching the Durable Object invocation wall-clock limit, which [what one invocation will take on](./rate-limiting.md#the-capacity-what-one-invocation-will-take-on) is designed to prevent: a tick reads one bounded page, never begins a call whose timeout would outlast the invocation, and asks to be woken again immediately when it left work behind.

## Subpath imports

```ts
import { FridgeDO, ensureStarted } from '@datafridge/cloudflare/do'
import { d1 } from '@datafridge/cloudflare/d1'
import { cronDriver, cronFridge } from '@datafridge/cloudflare/cron'
```

The package root re-exports all of these APIs.
