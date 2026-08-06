# API reference

English | [繁體中文](./zh-TW/api.md)

This document describes the shipped Wave 1 API. The six guarantees in [DESIGN.md section 2](../DESIGN.md#2-語意契約) are authoritative.

## `@datafridge/core`

### Query registry

```ts
const queries = defineQueries([
  {
    name: 'analytics-7d',
    every: '10m',
    timeout: '30s',
    lease: '1m',
    source: 'analytics',
    fetch: async ({ signal, now, attempt }) => fetchValue({ signal, now, attempt }),
  },
])
```

`defineQueries(definitions)` returns a `Queries` registry. Durations accept positive millisecond numbers or strings ending in `ms`, `s`, `m`, `h`, or `d`. Defaults are `timeout: '30s'`, `lease: timeout + 30s`, and `source: 'default'`.

Construction throws `ConfigError` for a non-array registry, an empty or duplicate name, a missing fetcher, an invalid duration, or `timeout >= lease`. Fetchers receive:

- `signal`: aborted at the configured timeout
- `now`: the tick timestamp in epoch milliseconds
- `attempt`: one plus the current consecutive failure count

### Parameterized queries

The accepted Wave 2 slice supports finite runtime variants without generating definitions manually:

```ts
const analytics = defineParameterizedQuery({
  name: 'course-analytics',
  every: '10m',
  variants: () => courseIds.flatMap((courseId) =>
    ['7d', '30d'].map((window) => ({ courseId, window })),
  ),
  fetch: ({ params, signal }) => fetchAnalytics(params, { signal }),
})

const queries = defineQueries([analytics])
```

`variants` is an array or a synchronous function returning an array. It is evaluated whenever `defineQueries` constructs a registry. A `PollerDO` can return a newly constructed registry from its `queries` getter when its finite runtime set changes. Every variant gets an independent schedule row, lease, failure count, backoff, and result envelope. Normal registry reconciliation creates added variants and deletes removed variants and their envelopes.

Params must be JSON values containing finite numbers, strings, booleans, nulls, arrays, and plain objects. Object keys are sorted before hashing. Cycles, class instances, `undefined`, and non-finite numbers fail during registry construction. Duplicate canonical params fail as duplicate variants.

`queryKey(name, params?)` is the stable storage identity function. Fixed names remain unchanged. Variant identities use the reserved `@df/v1/` namespace, the encoded public base name, and SHA-256 of canonical params. Raw params are absent from schedule rows, D1 keys, and `RunReport`. Do not put credentials, tokens, or private payloads in params: bindings and fetcher closures are the correct homes for secrets.

Arbitrary on-demand variants outside the finite registry remain excluded.

### Poller

```ts
const poller = createPoller({
  queries,
  driver,
  store,
  sources: { analytics: { maxPerTick: 2 } },
})

const report = await poller.runDue()
const value = await poller.read<Result>('analytics-7d')
```

`createPoller(config)` requires:

- `queries`: a `Queries` registry or raw query definitions
- `driver`: `{ serialized, defer(promise), schedule? }`
- either `store`, or `results` with a resolvable schedule plane

Optional fields are `schedule`, `sources`, `clock`, and `random`. `clock` and `random` exist for deterministic adapters and tests. See [schedule plane resolution](./writing-adapters.md#schedule-plane-resolution-rules-fail-at-config-time).

Construction rejects a missing or malformed driver, conflicting `store` and `results`, an invalid source budget, an unresolved schedule plane, or a non-atomic schedule store under a non-serialized driver.

`runDue(now?)` reconciles the registry, selects due work, applies per-source budgets, claims leases, runs fetchers concurrently, and returns:

```ts
interface RunReport {
  ran: string[]
  skippedLeased: string[]
  deferredBudget: string[]
  failed: Array<{ name: string; message: string }>
}
```

A successful refresh schedules the next run from completion time. A failure preserves the prior envelope and retries with jittered exponential backoff capped at `every`.

`poller.read(name)` reads only the result store. It throws for a name or parameter variant outside the registry. Pass params and the optional SWR fallback through the options object:

```ts
await poller.read('course-analytics', {
  params: { courseId: 'course-a', window: '7d' },
  swrRefresh: (refresh) => driver.defer(refresh),
})
```

### Reader

A reader has no fetchers or schedule plane:

```ts
const reader = createReader({ results })
const fixed = await reader.read<Result>('analytics-7d')
const variant = await reader.read<Result>('course-analytics', {
  courseId: 'course-a',
  window: '7d',
})
```

The result is:

```ts
interface ReadResult<T> {
  data: T
  fetchedAt: number
  isStale: boolean
  age: number
  lastError?: { at: number; message: string; count: number }
}
```

`read()` returns `null` only before the first successful refresh. It never invokes upstream code.

### Stores and test utilities

- `memoryStore()` returns the reference full `Store` implementation.
- `storeContractSuite(label, factory)` is exported from `@datafridge/core/contract-tests` for Vitest adapter compatibility tests.
- `FakeClock` and `flushMicrotasks` support deterministic tests.
- `parseDuration`, `queryKey`, `systemClock`, `ConfigError`, and `TimeoutError` are public utilities.
- Store and engine interfaces are exported as TypeScript types from the package root.

Importing `@datafridge/core` has zero runtime dependencies. The optional `vitest` peer is only needed when importing `@datafridge/core/contract-tests`.

## `@datafridge/cloudflare`

All runtime exports are available from the package root. Independent subpaths are also available:

| Export | Subpath | Purpose |
|---|---|---|
| `PollerDO`, `ensureStarted` | `@datafridge/cloudflare/do` | Durable Object alarm scheduler |
| `d1Results`, `d1Store` | `@datafridge/cloudflare/d1` | Result-only and full D1 stores |
| `cronDriver`, `cronPoller` | `@datafridge/cloudflare/cron` | Cron Trigger integration |
| `INVOCATION_WALL_CLOCK_LIMIT_MS` | package root | Cloudflare timeout ceiling |

### Durable Object alarms

Subclass `PollerDO<Env>`, provide `queries` and `results(env)`, and optionally provide `sources`. The schedule plane lives in the Durable Object's SQLite storage.

```ts
class Poller extends PollerDO<Env> {
  queries = queries
  sources = { analytics: { maxPerTick: 2 } }

  results(env: Env) {
    return d1Results(env.DB)
  }

  protected override onRunReport(report: RunReport) {
    logSanitized(report)
  }
}
```

`onRunReport(report)` is an optional operational hook after each alarm tick. Do not log query payloads, credentials, or sensitive error details. Hook failures are absorbed by the alarm loop, and the next alarm is still scheduled.

`ensureStarted(namespace, instanceName?)` idempotently ignites one named `PollerDO` instance. The default instance name is `datafridge-poller`.

The registry, source budgets, and Cloudflare timeout ceiling are validated when the object is ignited and before every alarm run. `timeout` must be shorter than 15 minutes, and every `maxPerTick` must be a positive integer.

### D1 stores

- `d1Results(db)` implements `ResultStore` for Combo A.
- `d1Store(db)` implements the full atomic `Store` for Combo B.

Both require the packaged migration at `@datafridge/cloudflare/migrations/0001_datafridge_init.sql`. Writes larger than D1's 2,000,000-byte row limit are rejected while the previous envelope remains intact.

### Cron Triggers

`cronPoller(config)` performs environment-dependent store construction inside each invocation and returns a scheduled handler:

```ts
export default {
  scheduled: cronPoller<Env>({
    queries,
    store: (env) => d1Store(env.DB),
    sources: { analytics: { maxPerTick: 2 } },
  }),
}
```

It validates the query registry, timeout ceiling, and schedule-plane shape at module construction. `cronDriver(ctx)` is the lower-level non-serialized driver for applications that need to call `createPoller` directly and consume its `RunReport`.

### Init CLI

The package installs a `datafridge` binary:

```sh
pnpm exec datafridge init cloudflare [--config wrangler.toml]
```

It adds the Durable Object binding and migration, a one-minute Cron Trigger, and a D1 binding. Existing declarations are preserved. The CLI only edits TOML and refuses to create a conflicting TOML file beside `wrangler.json` or `wrangler.jsonc`.

See [Cloudflare setup and operations](./cloudflare.md) for the full deployment sequence.
