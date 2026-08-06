# Cloudflare setup and operations

English | [繁體中文](./zh-TW/cloudflare.md)

Cloudflare Wave 1 provides two complete combinations. Both use D1 for result envelopes and preserve the [six-point semantic contract](../README.md#the-semantic-contract).

## Install and initialize

```sh
pnpm add @datafridge/core @datafridge/cloudflare
pnpm exec datafridge init cloudflare
```

The init CLI idempotently adds declarations for both combinations to `wrangler.toml`. Pass `--config <path>` for another TOML file. It preserves existing declarations, reports declarations that need manual placement, and refuses to create TOML beside an existing `wrangler.json` or `wrangler.jsonc`.

Review the output, keep one scheduling combination, and remove the unused declarations. Then create or select a D1 database, replace the generated `database_id`, and apply the packaged schema:

```sh
pnpm exec wrangler d1 execute YOUR_DATABASE --remote \
  --file node_modules/@datafridge/cloudflare/migrations/0001_datafridge_init.sql
```

Use Worker secrets for upstream credentials. Never put a credential in a query name, parameter object, log, or `wrangler.toml`:

```sh
pnpm exec wrangler secret put UPSTREAM_API_TOKEN
```

## Combo A: Durable Object alarms + D1 results

Use Combo A when you want alarms scheduled at exact due timestamps, dynamic backoff without fixed cron wakeups, or serialized schedule coordination.

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

The Durable Object stores only schedule rows in its own SQLite. Fetchers execute in the object, envelopes go to D1, and the read path goes directly to D1.

### Alarm lifecycle

`ensureStarted(namespace, instanceName?)` wakes the object and schedules an immediate alarm unless the current registry already has one. The default instance name is `datafridge-poller`. Calling it on every read is safe and also re-ignites the chain after a deployment.

Every alarm:

1. Resolves and validates the registry.
2. Reconciles schedule rows and envelopes.
3. Runs due queries through the core engine.
4. Calls `onRunReport(report)`.
5. Schedules the next alarm in `finally`, even if reconciliation, storage, or the report hook fails.

For changing finite parameter variants, return a newly constructed registry from a `queries` getter. Added variants get new rows; removed variants lose both their row and envelope. See the [parameterized API](./api.md#parameterized-queries).

`onRunReport` is for operational evidence, not payload logging. Prefer category counts or allowlisted identities. Error messages originate in application fetchers and may be sensitive, so sanitize them before logging.

## Combo B: Cron Triggers + D1 full store

Use Combo B when a one-minute scheduler floor is acceptable and you prefer D1 as the only stateful platform component.

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

Cron invocations can overlap, so `cronPoller` uses a non-serialized driver and requires an atomic schedule store. `d1Store` claims with a version-checked D1 update. Invalid `results`-only configurations fail when `cronPoller` is constructed.

Use `cronDriver(ctx)` with `createPoller` directly when the scheduled handler needs the returned `RunReport`:

```ts
const poller = createPoller({
  queries,
  driver: cronDriver(ctx),
  store: d1Store(env.DB),
})
const report = await poller.runDue()
ctx.waitUntil(writeSanitizedOperations(report))
```

## Choosing a combination

| | Combo A | Combo B |
|---|---|---|
| Scheduler | Durable Object alarms | Cron Triggers |
| Schedule state | Durable Object SQLite | D1 |
| Claims | Serialized actor | D1 compare-and-swap |
| Result state | D1 | D1 |
| Scheduler floor | 1 second safety floor | 1 minute |
| Dynamic due time | Alarm moves to the next due row | Cron stays fixed; due checks remain dynamic |

Do not combine Cron Triggers with `d1Results` alone. It has no schedule plane, and construction rejects the configuration.

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

1. Apply the D1 schema before the first invocation.
2. Put upstream credentials in Worker secrets.
3. Keep query params non-secret and finite.
4. Deploy the Worker and, for Combo A, call a route that invokes `ensureStarted` once.
5. Confirm result rows appear and reads return `{ data, fetchedAt, isStale, age }`.
6. Record sanitized `RunReport` categories, alarm continuity, and an observation start and end condition.
7. Test failure handling with an authorized, controlled upstream condition. Verify the old envelope remains and subsequent reports show failure and recovery without logging payloads.
8. Monitor D1 row size. Envelopes above 2,000,000 bytes are rejected and the previous envelope remains.

D1 is single-region, so readers at remote PoPs can incur cross-region latency. Result-plane replicas are outside the shipped scope.

## Subpath imports

```ts
import { PollerDO, ensureStarted } from '@datafridge/cloudflare/do'
import { d1Results, d1Store } from '@datafridge/cloudflare/d1'
import { cronDriver, cronPoller } from '@datafridge/cloudflare/cron'
```

The package root re-exports all of these APIs.
