# Cloudflare setup and operations

English | [繁體中文](./zh-TW/cloudflare.md)

This page is the setup and operations home for the Cloudflare modules: `PollerDO` and `ensureStarted` for alarm-driven scheduling, `cronDriver` and `cronPoller` for Cron Triggers, and `d1` for storage. Which position each module fills is in the [README's module list](../README.md#wiring-a-scheduler-and-a-store). Every arrangement below stores result envelopes in D1 and preserves the [six-point semantic contract](./concepts.md#the-semantic-contract).

## Install and initialize

```sh
pnpm add @datafridge/core @datafridge/cloudflare
pnpm exec datafridge init --scheduler durable-object --store d1
# or: --scheduler cron --store d1
```

You name the scheduler and the store, and the CLI idempotently adds only what that combination needs: the Durable Object binding and its SQLite class migration, or the `[triggers]` cron, plus the D1 binding. Nothing is written for you to delete afterwards. Pass `--config <path>` for another TOML file. It preserves existing declarations, reports declarations that need manual placement, and refuses to create TOML beside an existing `wrangler.json` or `wrangler.jsonc` (it prints the declarations for you to place by hand instead).

With the Durable Object scheduler, `class_name` has to match the `PollerDO` subclass your Worker exports.

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

## Durable Object alarms: `PollerDO`

The scheduler here is the class you export: `wrangler` instantiates it by `class_name` and its alarm loop drives every tick. `PollerDO` is a serialized driver that carries its own schedule bookkeeping, so it only needs somewhere to put envelopes. Use it when you want alarms scheduled at exact due timestamps, dynamic backoff without fixed cron wakeups, or serialized schedule coordination.

```ts
import { createReader, defineQueries } from '@datafridge/core'
import type { RunReport } from '@datafridge/core'
import { d1, ensureStarted, PollerDO } from '@datafridge/cloudflare'

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

  store(env: Env) {
    return d1(env.DB)
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

The Durable Object stores only schedule rows in its own SQLite. Fetchers execute in the object, envelopes go to D1, and the read path goes directly to D1.

### Alarm lifecycle

`ensureStarted(namespace, instanceName?)` wakes the object and schedules an immediate alarm unless the current registry already has one. The default instance name is `datafridge-poller`. Calling it on every read is safe and also re-ignites the chain after a deployment. To keep the request path clear of it, hand it to the handler's `ExecutionContext` with `ctx.waitUntil(ensureStarted(env.POLLER))` instead of awaiting it, or call it from a post-deploy hook.

Every alarm:

1. Resolves and validates the registry.
2. Reconciles schedule rows and envelopes.
3. Runs due queries through the core engine.
4. Calls `onRunReport(report)`.
5. Schedules the next alarm in `finally`, even if reconciliation, storage, or the report hook fails.

For a variant list that changes at runtime, declare it as a function - it is resolved at every alarm, and may be async. Added variants get new rows; removed variants lose both their row and envelope. See the [parameterized API](./api.md#parameterized-queries).

`onRunReport` is for operational evidence, not payload logging. Prefer category counts or allowlisted identities. Error messages originate in application fetchers and may be sensitive, so sanitize them before logging.

## Cron Triggers: `cronPoller`

The scheduler here is the handler you export: Cloudflare's cron trigger calls `scheduled`, so nothing has to ignite itself and there is no `ensureStarted`. `cronDriver` is not serialized, so it needs atomic claims - which `d1` provides. Use this pairing when a one-minute scheduler floor is acceptable and you prefer D1 as the only stateful platform component.

```ts
import { defineQueries } from '@datafridge/core'
import { cronPoller, d1 } from '@datafridge/cloudflare'

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
    store: (env) => d1(env.DB),
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

Cron invocations can overlap, so `cronPoller` uses a non-serialized driver and requires an atomic schedule store. `d1` claims with a version-checked D1 update. Invalid `results`-only configurations fail when `cronPoller` is constructed.

Pass `onRunReport` to observe each tick under the same sanitize-before-logging contract as the `PollerDO` hook. Use `cronDriver(ctx)` with `createPoller` directly when the handler needs to do more with the `RunReport` than observe it:

```ts
const poller = createPoller({
  queries,
  driver: cronDriver(ctx),
  store: d1(env.DB),
})
const report = await poller.runDue()
ctx.waitUntil(writeSanitizedOperations(report))
```

## Choosing a scheduler

| | `PollerDO` | `cronPoller` |
|---|---|---|
| Driver | Durable Object alarms | Cron Triggers |
| Schedule plane | Durable Object SQLite | D1 |
| Claims | Serialized actor | D1 compare-and-swap |
| Result plane | D1 | D1 |
| Scheduler floor | Exact alarm timestamp, 1-second safety floor | 1 minute |
| Dynamic due time | Alarm moves to the next due row | Cron stays fixed; due checks remain dynamic |
| Platform components | Durable Object + D1 | D1 only |
| Pick it when | You want exact due times and dynamic backoff | You would rather not run a Durable Object |

Those two are the arrangements that ship complete on Cloudflare, not the only legal ones: any composition works as long as the schedule plane resolves. Cron Triggers with a result-only store does not - it has no schedule plane, and construction rejects the configuration rather than quietly double-fetching.

## Construction-time validation

- `defineQueries` validates names, durations, fetchers, duplicate variants, and `timeout < lease`.
- `PollerDO` validates its registry, source budgets, and the Cloudflare wall-clock ceiling during ignition and before alarms.
- `cronPoller` validates its registry, store-factory shape, schedule-plane resolution, and wall-clock ceiling when constructed.
- A Cloudflare query timeout must be shorter than 15 minutes.
- Source budgets must be positive integers.

## Failure and recovery

| Condition | Schedule behavior | Read behavior |
|---|---|---|
| Upstream error or timeout | Increment failure count and retry with capped exponential backoff | Keep last good envelope, expose stale state and `lastError` |
| Live lease | Put the identity in `skippedLeased`; no duplicate fetch | Return the current envelope immediately |
| Executor death | Reclaim after lease expiry | Return the current envelope immediately |
| Late zombie write | Reject on version mismatch | Remain unchanged |
| Per-source budget exhausted | Keep due for a later tick | Return the current envelope immediately |
| No successful refresh yet | Continue scheduled attempts | Return `null` |
| Alarm-level error | Schedule the next alarm in `finally` | Existing D1 envelopes remain readable |

Backoff is `min(every, 1m * 2^(failCount - 1))` plus jitter. Success resets the failure count. The normal interval uses fixed-delay semantics from fetch completion.

## Operational checklist

1. Optionally apply the packaged D1 migration; otherwise the first write creates the tables.
2. Put upstream credentials in Worker secrets.
3. Keep query params non-secret and finite.
4. Deploy the Worker and, when `PollerDO` is the scheduler, call a route that invokes `ensureStarted` once.
5. Confirm result rows appear and reads return `{ data, fetchedAt, isStale, age }`.
6. Record sanitized `RunReport` categories, alarm continuity, and an observation start and end condition.
7. Test failure handling with an authorized, controlled upstream condition. Verify the old envelope remains and subsequent reports show failure and recovery without logging payloads.
8. Monitor D1 row size. Envelopes above 2,000,000 bytes are rejected and the previous envelope remains.

D1 is single-region, so readers at remote PoPs can incur cross-region latency. Result-plane replicas are outside the shipped scope.

One `PollerDO` instance coordinates the entire registry. Sharding it by source is deliberately not implemented; the condition that would justify reconsidering it is a single `runDue` approaching the Durable Object invocation wall-clock limit, which a registry of a few dozen queries is nowhere near.

## Subpath imports

```ts
import { PollerDO, ensureStarted } from '@datafridge/cloudflare/do'
import { d1 } from '@datafridge/cloudflare/d1'
import { cronDriver, cronPoller } from '@datafridge/cloudflare/cron'
```

The package root re-exports all of these APIs.
