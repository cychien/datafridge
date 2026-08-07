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

<h3 align="center">Data always on hand, reliable even when the source is not</h3>

<p align="center"><strong>English</strong> · <a href="./README.zh-TW.md">繁體中文</a></p>

When our system depends on third-party data, an unstable source easily makes our own system look unreliable.

That instability comes as slow responses, data that is sometimes simply not there, rate limits you hit as soon as usage grows or calls get frequent. Once users run into that and our system has not handled it, we are the ones they complain to.

datafridge handles it for you. You register a query once and configure a scheduler, a result store, and metadata such as the refresh interval and rate limits. From then on the scheduler writes the latest third-party data into your own database in the background.

The whole library is one promise: **when your app wants data, it always has some.** Not necessarily current - but always there, and as current as the upstream will allow.

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
   │ your store                                  │
   └──────┬──────────────────────────────────────┘
          │ read() - one local query
          ▼
   { data, fetchedAt, isStale, age }
```

`@datafridge/core` is the engine: pure logic, zero runtime dependencies. `@datafridge/cloudflare` is the adapter package that lets it use Cloudflare infrastructure such as Durable Object alarms, Cron Triggers, or D1.

## Install

```sh
npm install @datafridge/core @datafridge/cloudflare
# or: pnpm add @datafridge/core @datafridge/cloudflare
```

Both packages are ESM-only and need Node.js 20 or newer for tooling.

## Defining queries

```ts
import { defineQueries } from '@datafridge/core'

const queries = defineQueries([
  {
    name: 'weekly-summary',
    timeout: '30s',            // optional, defaults to 30s; aborts the fetch when it runs out
    lease: '1m',               // optional, defaults to timeout + 30s
    source: 'default',         // optional, defaults to 'default'; the rate-limit group
    every: '10m',
    fetch: async ({ signal }) => {
      const response = await fetch('https://api.example.com/weekly-summary', { signal })
      if (!response.ok) throw new Error(`upstream status ${response.status}`)
      return response.json()
    },
  },
])
```

## Wiring a scheduler and a store

**scheduler**

- `FridgeDO` - a Cloudflare Durable Object as the scheduler, at exact due times.
- `cronFridge` - a Cloudflare Cron Trigger as the scheduler, one minute at the finest.

**store**

- `d1(env.DB)` - your D1.

Either side mixes freely with the other, and you can write your own adapters.

## Initialization

```sh
npx --no-install datafridge init --scheduler durable-object --store d1
# or: --scheduler cron --store d1
```

Schedulers: `durable-object`, `cron`. Stores: `d1`. Platform guides: [Cloudflare](./docs/cloudflare.md).

## A complete example

`FridgeDO` as the scheduler, `d1` as the store, and one route that reads:

```ts
import { createReader, defineQueries } from '@datafridge/core'
import { d1, ensureStarted, FridgeDO } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
}

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

export class Poller extends FridgeDO<Env> {
  queries = queries

  store(env: Env) {
    return d1(env.DB)
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    await ensureStarted(env.POLLER)
    const reader = createReader({ store: d1(env.DB), queries })
    return Response.json(await reader.read('weekly-summary'))
  },
}
```

`ensureStarted()` starts the scheduler, which only the durable-object scheduler needs - without that call nothing ever ticks. Reads go straight to D1.

[`examples/cloudflare-basic`](./examples/cloudflare-basic) is this as a runnable app, polling a deliberately slow fake API under `wrangler dev`.

## Reading a result

```ts
const reader = createReader({ store: d1(env.DB), queries })
const result = await reader.read<Summary>('weekly-summary')
```

`queries` is optional.

```ts
{ data: Summary, fetchedAt, isStale, age, status: 'ok' | 'invalid', validUntil?, lastError? } | null
```

- `fetchedAt` is when the data was actually fetched, in epoch milliseconds.
- `age` is how old it is right now, so you can apply your own threshold ("show a warning past two hours").
- `isStale` is `true` once `age` exceeds the query's `every`. It is a label, never a block: stale data is served immediately, exactly like fresh data.
- `null` means there is nothing stored and none arrived in time: the upstream failed, or it is between retries. Without `queries`, a cold read and a misspelled name both read as `null` too, because the reader has no registry to consult.

## When the upstream fails

Nothing is thrown away. A failed refresh keeps the previously cached result, attaches `lastError` to it, and reschedules with jittered exponential backoff: `min(every, 1m * 2^(failCount - 1))`.

| What happened | What the scheduler does | What `read()` returns |
|---|---|---|
| Upstream error or timeout | Count the failure, back off, keep the old result | Old data, `isStale`, `lastError` |
| Executor died mid-fetch | Another tick re-claims it after the lease expires | Old data, `isStale` |
| A zombie writes back late | Version mismatch, write rejected | Unaffected |
| Squeezed out by a source's rate limit | Stays due, rises in priority next tick | Old data, slightly older |
| Failing for hours | Backoff converges at `every`, last-known-good kept forever | Old data, `lastError` |
| Never fetched successfully | Keeps trying on schedule | `null` |

## Preset variants of one query

When the same fetch applies to a finite set of dimensions - a course ID, a preset time window - declare it once instead of writing the loop yourself. An array expands at construction; a function is re-resolved every tick and may be async, so the list can live in your database:

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

Every variant becomes an ordinary independent registry entry with its own schedule, lease, backoff, failure count, and stored result. Adding or removing a variant reconciles exactly like adding or removing a named query.

## Parameter spaces too large to list

When the space is open-ended - any custom date range, any course - `anyParams` replaces the list entirely:

```ts
const funnel = defineParameterizedQuery({
  name: 'course-funnel',
  anyParams: true,
  timeout: '20s',
  source: 'posthog',
  fetch: ({ params, signal }) => fetchFunnel(params, { signal }),
})
```

Being an entry is what the registry decides, never what somebody happened to ask for. Params the registry names are scheduled entries with a row, a lease and a stored result. Params it does not name are answered by one fresh call - through the same dispatcher, so the same source ceiling, reserve, concurrency and timeout apply - and nothing is stored: no result, no row, no polling you did not ask for.

That is the trade you are making. A declared variant is kept current for you; an open one is fetched when you ask, and costs a call each time. See [open parameter spaces](./docs/api.md#open-parameter-spaces).

## Rate limiting by source

Tag queries with a `source` and say what that source tolerates:

```ts
export default {
  scheduled: cronFridge<Env>({
    queries,
    store: (env) => d1(env.DB),
    sources: {
      posthog: {
        limit: { requests: 100, per: '1m', reserve: 10 },
        maxConcurrent: 4,
      },
    },
  }),
}
```

`limit` is a real count, not a heuristic: the store keeps one ledger row per source and every call increments it under the same version-checked CAS that claims a lease, so two Workers and a Durable Object pointing at one database share one budget. Every upstream call goes through it - a scheduled refresh and a read that found nothing stored draw on the same window.

`reserve` holds part of each window back from scheduled refreshes, because a tick landing on the window boundary would otherwise spend the whole minute in its first second and leave nothing for a reader with a person behind it. A query squeezed out stays due and rises in priority every tick it waits, since priority is the overdue *ratio* `(now - nextRunAt) / every` rather than absolute lateness. Nothing starves.

Jitter is the other half: first registration offsets each query's `nextRunAt` randomly, so `5m`, `10m`, and `1h` queries never permanently align on the same tick and stampede one source at once. The ledger is the fuse; jitter keeps the fuse from blowing in normal operation.

See [rate limiting](./docs/rate-limiting.md) for `maxConcurrent`, the `throttled` read status, and passing a vendor's own `Retry-After` back with `RateLimitError`.

## Documentation

- [API reference](./docs/api.md)
- [Concepts and failure semantics](./docs/concepts.md)
- [Cloudflare setup and operations](./docs/cloudflare.md)
- [Rate limiting](./docs/rate-limiting.md)
- [Writing adapters](./docs/writing-adapters.md)
- [Runnable Cloudflare example](./examples/cloudflare-basic)

## License

[MIT](./LICENSE)
