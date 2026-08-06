# datafridge

English | [繁體中文](./README.zh-TW.md)

## The semantic contract

These six guarantees are the product. Every implementation must uphold them:

1. **Reads always return immediately.** `read()` only touches the result store and never waits on upstream.
2. **Reads always carry time.** Every result includes `fetchedAt`, so callers always know its age.
3. **Stale-if-error.** An upstream failure keeps the last-known-good result and marks it stale instead of replacing it with an error.
4. **At-least-once refresh.** If an executor dies mid-run, another executor picks up the work after its lease expires.
5. **Write-back consistency.** Version checks reject late writes from concurrent or zombie executors.
6. **Fail at config time.** Invalid durations, duplicate names, unsafe leases, unsupported platform timeouts, and an unresolved schedule plane throw during construction.

A fridge for your API data. datafridge refreshes named queries proactively, so request-time reads never wait on a slow or unreliable upstream. Every read is labeled with its age, and stale-if-error preserves the last good value.

Wave 1 supports Cloudflare in two combinations: Durable Object alarms with D1 results, or Cron Triggers with a full D1 store. The accepted parameterized-query slice adds finite runtime variants for dimensions such as resource IDs and preset windows. Fetchers remain application code. datafridge is not an API connector, proxy, dashboard, or configuration DSL.

## Install

```sh
pnpm add @datafridge/core @datafridge/cloudflare
# or: npm install @datafridge/core @datafridge/cloudflare
```

Both packages are ESM-only and require Node.js 20 or newer for development tooling. Worker code runs on Cloudflare's Workers runtime.

## Parameterized preset queries

Use one parameterized definition when the same fetch applies to a finite set of runtime variants:

```ts
import { defineParameterizedQuery, defineQueries } from '@datafridge/core'

const courseAnalytics = defineParameterizedQuery({
  name: 'course-analytics',
  every: '10m',
  source: 'posthog',
  variants: () => courseIds.flatMap((courseId) =>
    ['7d', '30d', '90d'].map((window) => ({ courseId, window })),
  ),
  fetch: ({ params, signal }) => queryPostHogPreset(params, { signal }),
})

const queries = defineQueries([courseAnalytics])
const result = await reader.read('course-analytics', { courseId: 'course-a', window: '30d' })
```

Each variant gets its own schedule, lease, backoff, and envelope. Added and removed variants reconcile like named queries. Storage and `RunReport` identities contain the public base name plus a canonical SHA-256 digest, never raw parameter values. Parameters must still contain only non-secret JSON dimensions. Credentials belong in bindings or fetcher closures.

## Cloudflare quick start

Apply the packaged D1 schema before deploying either combination:

```sh
pnpm exec wrangler d1 execute YOUR_DATABASE --remote \
  --file node_modules/@datafridge/cloudflare/migrations/0001_datafridge_init.sql
```

### Combo A: Durable Object alarms + D1 results

The Durable Object owns serialized schedule bookkeeping in its SQLite storage. Results land in D1, and readers query D1 directly.

```ts
import { createReader, defineQueries } from '@datafridge/core'
import { d1Results, ensureStarted, PollerDO } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
}

const queries = defineQueries([
  {
    name: 'weekly-summary',
    every: '10m',
    timeout: '30s',
    source: 'analytics',
    fetch: ({ signal }) => fetchWeeklySummary({ signal }),
  },
])

export class Poller extends PollerDO<Env> {
  queries = queries

  results(env: Env) {
    return d1Results(env.DB)
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

[[d1_databases]]
binding = "DB"
database_name = "datafridge"
database_id = "..."

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Poller"]
```

`ensureStarted()` is idempotent. It ignites the alarm chain on first use and reconciles changed query registries after deploys.

### Combo B: Cron Triggers + D1 full store

D1 stores both results and schedule rows. Atomic compare-and-swap claims make overlapping scheduled invocations safe.

```ts
import { defineQueries } from '@datafridge/core'
import { cronPoller, d1Store } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
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
  }),
}
```

```toml
[triggers]
crons = ["* * * * *"]
```

| | Combo A | Combo B |
|---|---|---|
| Scheduler | Durable Object alarms | Cron Triggers |
| Schedule state | Durable Object SQLite | D1 with atomic claims |
| Result state | D1 | D1 |
| Granularity | Exact alarm timestamp | 1-minute floor |
| Best fit | Dynamic backoff and minimal claim overhead | Fewer platform components |

## Init CLI

After installing `@datafridge/cloudflare`, scaffold both supported combinations into a TOML config:

```sh
pnpm exec datafridge init cloudflare
# npm: npx --no-install datafridge init cloudflare
```

Use `--config path/to/wrangler.toml` when needed. The command is idempotent, preserves existing declarations, refuses to conflict with `wrangler.json` or `wrangler.jsonc`, and prints any declaration it cannot safely add. Keep one combination and remove the unused declarations.

## Read and failure behavior

```ts
const result = await createReader({ results: d1Results(env.DB) }).read<Summary>(
  'weekly-summary',
)
// { data, fetchedAt, isStale, age, lastError? } | null
```

`null` means the first successful refresh has not completed. Upstream errors and timeouts preserve the previous envelope, increment failure state, and retry with jittered exponential backoff capped at the normal interval. `runDue()` returns `{ ran, skippedLeased, deferredBudget, failed }`. Combo A subclasses can override `onRunReport(report)` for sanitized operational logging.

See [DESIGN.md section 2](./DESIGN.md#2-語意契約) for the authoritative contract and [docs/concepts.md](./docs/concepts.md) for the lease, version, backoff, and staleness model.

## Documentation

- [API reference](./docs/api.md)
- [Cloudflare setup and operations](./docs/cloudflare.md)
- [Concepts and failure semantics](./docs/concepts.md)
- [Rate limiting](./docs/rate-limiting.md)
- [Writing adapters](./docs/writing-adapters.md)
- [Release process and package names](./docs/releasing.md)
- [Runnable Cloudflare example](./examples/cloudflare-basic)

## Wave 2 exclusions

Not available in Wave 1:

- Node timer, Redis, SQLite, Postgres, KV, or Cache API adapters
- Unbounded, on-demand, or arbitrary custom-range variants outside the finite registry
- Precise shared quota-window accounting
- Metrics exporters and dashboards
- QStash or Inngest provisioning drivers
- A documentation website

## License

[MIT](./LICENSE)
