<h1 align="center">datafridge</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@datafridge/core"
    ><img
      alt="@datafridge/core on npm"
      src="https://img.shields.io/npm/v/%40datafridge%2Fcore?style=flat-square&label=%40datafridge%2Fcore"
  /></a>
  <a href="https://www.npmjs.com/package/@datafridge/cloudflare"
    ><img
      alt="@datafridge/cloudflare on npm"
      src="https://img.shields.io/npm/v/%40datafridge%2Fcloudflare?style=flat-square&label=%40datafridge%2Fcloudflare"
  /></a>
  <a href="https://github.com/cychien/datafridge/actions/workflows/ci.yml"
    ><img
      alt="CI"
      src="https://img.shields.io/github/actions/workflow/status/cychien/datafridge/ci.yml?branch=main&style=flat-square&label=ci"
  /></a>
</p>

<h3 align="center">A fridge for your API data. Always stocked, always dated.</h3>

<p align="center"><strong>English</strong> · <a href="./README.zh-TW.md">繁體中文</a></p>

You have a page that calls a third-party analytics API. It takes four seconds on a good day, the vendor rate-limits you, and you cannot call it once per visitor. So you cache it - and now the first visitor after every expiry eats the four seconds. Then the vendor has an outage, and a page whose numbers barely move in an hour renders an error.

datafridge turns that around. You register a query once, with a name and an interval. A scheduler refreshes it in the background and writes the result into your own database. Your request handler does one local read, which costs the same whether the upstream is fast, slow, throttled, or gone. Cache libraries like `bentocache` or `cachified` are request-triggered: nothing refreshes until somebody asks, so somebody always pays. datafridge refreshes on a schedule, so nobody does.

- **Reads never wait on upstream.** `read()` touches your result store and nothing else. There is no cold-start request that pays the latency for everyone else.
- **Every read is dated.** `fetchedAt`, `age`, and `isStale` come back with the data, so you decide what "too old" means instead of guessing.
- **The vendor's outage is not your outage.** A failed refresh keeps the last good value and records the error next to it. The page keeps rendering.
- **The rate limit is a config field.** Group queries by `source`, cap how many run per tick, and that ceiling holds no matter how many queries you register.
- **Bad config throws at construction, not at 3 a.m.** A timeout longer than its lease, a duplicate name, a scheduler with nowhere safe to keep its bookkeeping: all of it fails when you build the poller.

```
   scheduler tick (Durable Object alarm, or cron)
        │
        ▼
   ┌──────────────┐   fetch   ┌──────────────┐
   │ your fetcher │ ────────► │ upstream API │   slow · throttled · flaky
   └──────┬───────┘           └──────────────┘
          │ { data, fetchedAt }        on failure: keep the last good value,
          ▼                            record the error, retry with backoff
   ┌─────────────────────────────────────────────┐
   │ your store (D1)                             │
   └──────┬──────────────────────────────────────┘
          │ read() - one local query, never waits on upstream
          ▼
   { data, fetchedAt, isStale, age }
```

`@datafridge/core` is the engine: pure logic, an injected clock, and zero runtime dependencies. `@datafridge/cloudflare` is the adapter package that runs it on Durable Object alarms, Cron Triggers, and D1. Fetchers are always your code - datafridge never talks to a vendor on your behalf.

## Install

```sh
pnpm add @datafridge/core @datafridge/cloudflare
# or: npm install @datafridge/core @datafridge/cloudflare
```

Both packages are ESM-only and need Node.js 20 or newer for tooling. Worker code runs on Cloudflare's Workers runtime.

## Configuration is one array

A query is a name, an interval, and a function that fetches. That is the entire configuration surface:

```ts
import { defineQueries } from '@datafridge/core'

const queries = defineQueries([
  {
    name: 'weekly-summary',
    every: '10m',
    fetch: async ({ signal }) => {
      const response = await fetch('https://api.example.com/weekly-summary', { signal })
      if (!response.ok) throw new Error(`upstream status ${response.status}`)
      return response.json()
    },
  },
])
```

`every` accepts `'30s'`, `'10m'`, `'1h'`, `'1d'`, or a millisecond number. `signal` aborts at the timeout (30 seconds by default), so a hung upstream cannot hold a slot forever. Throw from `fetch` and stale-if-error takes over.

Optional per query: `timeout`, `lease`, and `source`. Everything from here on is wiring that array to a scheduler and a store.

## Quick start on Cloudflare

Three steps: declare the infrastructure, apply the schema, write the Worker.

**1. Scaffold the wrangler declarations.**

```sh
pnpm exec datafridge init cloudflare
# npm: npx --no-install datafridge init cloudflare
```

This writes the Durable Object binding, the SQLite class migration, a one-minute Cron Trigger, and a D1 binding into `wrangler.toml`. It is idempotent, never rewrites declarations you already have, and refuses to create a TOML file next to an existing `wrangler.json` or `wrangler.jsonc` (it prints the declarations for you to place by hand instead). Use `--config path/to/wrangler.toml` for a different file. It scaffolds both scheduling combinations; keep the one you use and delete the other.

Combo A needs three of them, and they are short enough to write by hand:

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

`class_name` has to match the `PollerDO` subclass your Worker exports.

**2. Apply the packaged D1 schema.**

```sh
pnpm exec wrangler d1 execute YOUR_DATABASE --remote \
  --file node_modules/@datafridge/cloudflare/migrations/0001_datafridge_init.sql
```

**3. Write the Worker.**

```ts
import { createReader, defineQueries } from '@datafridge/core'
import { d1Results, ensureStarted, PollerDO } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
}

export class Poller extends PollerDO<Env> {
  queries = defineQueries([
    {
      name: 'weekly-summary',
      every: '10m',
      fetch: async ({ signal }) => {
        const response = await fetch('https://api.example.com/weekly-summary', { signal })
        if (!response.ok) throw new Error(`upstream status ${response.status}`)
        return response.json()
      },
    },
  ])

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

The Durable Object is the scheduler: it wakes itself with alarms, runs each tick's due queries without ever overlapping two ticks, and keeps its schedule bookkeeping in its own SQLite. Envelopes go to your D1. The read path goes straight to D1 and never touches the Durable Object, so datafridge has no moving parts on the request path at all.

`ensureStarted()` is a cheap idempotent RPC. It lights the alarm chain the first time and re-lights it after a deploy, so hanging it on a read route is fine. It also notices a changed registry: the next tick creates rows for queries you added and drops both the row and the envelope for queries you deleted.

The very first read returns `null`, because nothing has been fetched yet. Every read after the first successful refresh returns data.

[`examples/cloudflare-basic`](./examples/cloudflare-basic) is this setup as a runnable app, polling a deliberately slow fake API under `wrangler dev`.

## Reading a result

A reader needs nothing but a result store. It has no fetchers and no schedule, so you can put one in a different Worker, a different service, or no TypeScript at all - envelopes are plain JSON rows.

```ts
const result = await createReader({ results: d1Results(env.DB) }).read<Summary>('weekly-summary')
```

```ts
{ data: Summary, fetchedAt: number, isStale: boolean, age: number, lastError?: { at, message, count } } | null
```

- `fetchedAt` is when the data was actually fetched, in epoch milliseconds.
- `age` is how old it is right now, so you can apply your own threshold ("show a warning past two hours").
- `isStale` is `true` once `age` exceeds the query's `every`. It is a label, never a block: stale data is served immediately, exactly like fresh data.
- `null` means the first successful refresh has not landed yet. That is the only case where you get nothing.

If you already have a poller in the same process, use `poller.read(name, options)` instead - it reads the same store and additionally rejects names outside the registry.

## When the upstream fails

Nothing is thrown away. A failed refresh keeps the previous envelope, attaches `lastError` to it, and reschedules with jittered exponential backoff: `min(every, 1m * 2^(failCount - 1))`. The cap is `every`, because retrying slower than the normal interval helps nobody. One success clears the counter.

| What happened | What the scheduler does | What `read()` returns |
|---|---|---|
| Upstream error or timeout | Count the failure, back off, keep the old envelope | Old data, `isStale`, `lastError` |
| Executor died mid-fetch | Another tick re-claims it after the lease expires | Old data, `isStale` |
| A zombie writes back late | Version mismatch, write rejected | Unaffected |
| Squeezed out by a source budget | Stays due, rises in priority next tick | Old data, slightly older |
| Failing for hours | Backoff converges at `every`, last-known-good kept forever | Old data, `lastError` |
| Never fetched successfully | Keeps trying on schedule | `null` |

Three independent gates make this work: `nextRunAt` decides whether a query should run, the lease decides who is running it, and the version decides whose result counts. Slow fetches, crashed executors, and zombie writes each break through one gate and get caught by the next.

Each tick returns a `RunReport` of `{ ran, skippedLeased, deferredBudget, failed }`. Override `onRunReport(report)` on your `PollerDO` subclass to log it - counts and allowlisted names only, since error messages come from your fetchers and may carry upstream detail.

## Choosing a scheduler

Cloudflare ships in two complete combinations. Both store envelopes in D1 and both honour the full contract.

| | Combo A | Combo B |
|---|---|---|
| Scheduler | Durable Object alarms | Cron Triggers |
| Schedule state | Durable Object SQLite | D1, with atomic compare-and-swap claims |
| Result state | D1 | D1 |
| Granularity | Exact alarm timestamp, 1-second floor | 1-minute floor |
| Platform components | Durable Object + D1 | D1 only |
| Pick it when | You want exact due times and dynamic backoff | You would rather not run a Durable Object |

Combo A is the quick start above. Combo B is one export:

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

Scheduled invocations can overlap, so Combo B is not serialized and the schedule plane has to be atomic. `d1Store` claims with a version-checked `UPDATE`, which is why the pairing is safe and why `cronPoller` with `d1Results` alone throws at construction rather than quietly double-fetching.

Reads are identical in both combinations: `createReader({ results: d1Results(env.DB) })`.

## Preset variants of one query

When the same fetch applies to a finite, known-at-deploy-time set of dimensions - a course ID, a preset time window - declare it once instead of writing the loop yourself:

```ts
import { defineParameterizedQuery, defineQueries } from '@datafridge/core'

const courseAnalytics = defineParameterizedQuery({
  name: 'course-analytics',
  every: '10m',
  source: 'posthog',
  variants: () =>
    courseIds.flatMap((courseId) => ['7d', '30d', '90d'].map((window) => ({ courseId, window }))),
  fetch: ({ params, signal }) => queryPostHogPreset(params, { signal }),
})

const queries = defineQueries([courseAnalytics])
const result = await reader.read('course-analytics', { courseId: 'course-a', window: '30d' })
```

Every variant becomes an ordinary independent registry entry with its own schedule, lease, backoff, failure count, and envelope. Adding or removing a variant reconciles exactly like adding or removing a named query.

Params are identity, not storage. They are snapshotted at construction, must be finite JSON (object key order does not matter), and are hashed into a `@df/v1/<base-name>/<sha256>` storage key - so raw parameter values never appear in D1 keys or in a `RunReport`. Never put a credential in one; bindings and fetcher closures are where secrets belong.

Only variants in the finite registry are scheduled and readable. Arbitrary on-demand variants are not created at read time.

## Rate limiting by source

Tag queries with a `source` and cap how many of that group run per tick:

```ts
export default {
  scheduled: cronPoller<Env>({
    queries,
    store: (env) => d1Store(env.DB),
    sources: { posthog: { maxPerTick: 2 } },
  }),
}
```

The same `sources` field works as a property on a `PollerDO` subclass. It is stateless, so it stays correct across concurrent executors, and it gives a hard ceiling: upstream calls can never exceed `maxPerTick × tick frequency`, however many queries you register. A query squeezed out by the budget stays due and rises in priority every tick it waits, since priority is the overdue *ratio* `(now - nextRunAt) / every` rather than absolute lateness. Nothing starves.

Jitter is the other half: first registration offsets each query's `nextRunAt` randomly, so `5m`, `10m`, and `1h` queries never permanently align on the same tick and stampede one source at once. The budget is the fuse; jitter keeps the fuse from blowing in normal operation.

## The semantic contract

These six guarantees are the product. Every implementation must uphold them:

1. **Reads always return immediately.** `read()` only touches the result store and never waits on upstream.
2. **Reads always carry time.** Every result includes `fetchedAt`, so callers always know its age.
3. **Stale-if-error.** An upstream failure keeps the last-known-good result and marks it stale instead of replacing it with an error.
4. **At-least-once refresh.** If an executor dies mid-run, another executor picks up the work after its lease expires.
5. **Write-back consistency.** Version checks reject late writes from concurrent or zombie executors.
6. **Fail at config time.** Invalid durations, duplicate names, unsafe leases, unsupported platform timeouts, and an unresolved schedule plane throw during construction.

They are the specification, not a summary of one. [docs/concepts.md](./docs/concepts.md) explains the lease, version, backoff, and staleness model that implements them, and every store adapter has to pass the contract compatibility suite in `@datafridge/core/contract-tests` before it is considered correct.

## What datafridge is not

- **Not an API connector.** Fetchers are your code, always. There are no vendor integrations to keep up to date.
- **Not a proxy.** Only queries you registered by name are served. Nothing is fetched because someone asked for it.
- **Not a dashboard or a config DSL.** The config is code, in your repo, typechecked.
- **Not request-triggered caching.** Refresh happens on schedule whether or not anybody reads.

Not in 1.0 (the docs call the shipped scope Wave 1):

- Node timer, Redis, SQLite, Postgres, KV, or Cache API adapters
- Unbounded, on-demand, or arbitrary custom-range variants outside the finite registry
- Precise shared quota-window accounting
- Metrics exporters and dashboards
- QStash or Inngest provisioning drivers
- A documentation website

## Documentation

- [API reference](./docs/api.md)
- [Concepts and failure semantics](./docs/concepts.md)
- [Cloudflare setup and operations](./docs/cloudflare.md)
- [Rate limiting](./docs/rate-limiting.md)
- [Writing adapters](./docs/writing-adapters.md)
- [Release process and package names](./docs/releasing.md)
- [Runnable Cloudflare example](./examples/cloudflare-basic)

## License

[MIT](./LICENSE)
