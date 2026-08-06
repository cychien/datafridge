# API reference

English | [繁體中文](./zh-TW/api.md)

This document describes the shipped Wave 1 API. The [six-guarantee semantic contract](./concepts.md#the-semantic-contract) is authoritative.

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

Two more optional fields shape what gets stored:

```ts
{
  name: 'lesson-engagement',
  every: '15m',
  codec: {
    encode: (v) => ({ rows: [...v.byPath] }),
    decode: (raw) => ({ byPath: new Map(raw.rows) }),
  },
  validUntil: ({ now }) => endOfTodayUtc(now),
  fetch: ...,
}
```

`codec` converts the fetched value to plain JSON on write and back on read, so a `Map`, `Set`, or `Date` needs no hand-rolled wrapper types. The stored row stays plain JSON - readable from any language - and only a reader holding the query registry decodes it; a bare reader sees the encoded form. An `encode` that throws counts as a fetch failure and keeps the previous result.

`validUntil` is for data that expires on its own clock: "today's traffic" stops being today's at midnight however recently it was fetched. It returns that boundary in epoch ms (it receives `params` and `now`); the boundary is stored on the result, reads past it report `status: 'invalid'` while still serving the data, and the scheduler re-fetches at the boundary instead of a full period later - `nextRunAt` becomes `min(completion + every, validUntil)`. Freshness by age (`isStale`) and validity of the window are independent axes.

### Parameterized queries

One definition covers a finite set of variants:

```ts
const analytics = defineParameterizedQuery({
  name: 'course-analytics',
  every: '10m',
  dimensions: {
    window: ['7d', '30d'],
    courseId: async () => listCourseIds(db),
  },
  fetch: ({ params, signal }) => fetchAnalytics(params, { signal }),
})

const queries = defineQueries([analytics])
```

`dimensions` expands to the cartesian product of its entries, one param field per dimension; `variants` names the param objects directly. Pass exactly one of the two. Either way, every variant gets an independent schedule row, lease, failure count, backoff, and result envelope.

**Arrays are static, functions are dynamic.** An array is expanded once at construction. A function - `variants` itself, or any single dimension - is resolved at every tick, may be async, and is where a list that lives in a database belongs. Reconciliation then creates rows for variants that appeared and deletes the row and result of variants that left. A resolution that throws removes nothing: the base keeps everything it already has, and the failure lands in that tick's `RunReport` under the base name.

A resolver receives `{ signal }` exactly as `fetch` does - `courseId: ({ signal }) => listCourseIds(db, { signal })` - and is bound by the base's own `timeout`, so a list that hangs is aborted and treated as a resolution that failed. Bases resolve concurrently, so one hung list does not delay the others. On a cold read that budget is shared with the wait: resolving membership and waiting for the first result cost one `timeout` between them, never two.

Reading a dynamic variant is asymmetric on purpose: a stored result is served without consulting the list, and only a miss resolves it - to fetch a member, or to reject params that are not one.

Params must be JSON values containing finite numbers, strings, booleans, nulls, arrays, and plain objects. Object keys are sorted before hashing. Cycles, class instances, `undefined`, and non-finite numbers are rejected when the variant is expanded. Duplicate canonical params fail as duplicate variants - at construction for static lists, as that tick's failure for dynamic ones.

`queryKey(name, params?)` is the stable storage identity function. Fixed names remain unchanged. Variant identities use the reserved `@df/v1/` namespace, the encoded public base name, and SHA-256 of canonical params. Raw params are absent from schedule rows, D1 keys, and `RunReport`. Do not put credentials, tokens, or private payloads in params: bindings and fetcher closures are the correct homes for secrets.

Arbitrary on-demand variants outside the finite registry remain excluded.

### Fridge

```ts
const fridge = createFridge({
  queries,
  driver,
  store,
  sources: { analytics: { maxPerTick: 2 } },
})

const report = await fridge.runDue()
const value = await fridge.read<Result>('analytics-7d')
```

`createFridge(config)` requires:

- `queries`: a `Queries` registry or raw query definitions
- `driver`: `{ serialized, defer(promise), schedule? }`
- `store`: one store holding both result envelopes and schedule rows

Optional fields are `sources`, `clock`, and `random`. `clock` and `random` exist for deterministic adapters and tests. See [where the schedule half comes from](./writing-adapters.md#where-the-schedule-half-comes-from-decided-at-config-time).

Construction rejects a missing or malformed driver, a store missing either half, an invalid source budget, or a store that cannot claim atomically under a non-serialized driver.

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

`fridge.read(name, params?)` reads the result store. It throws for a name or parameter variant outside the registry.

```ts
await fridge.read('course-analytics', { courseId: 'course-a', window: '7d' })
```

A read has exactly two behaviours, and no options that change them:

- **Something stored** - it returns at once, fresh, stale or `invalid` alike, and touches nothing upstream. Refreshing what is already there belongs to the scheduler, so reading a stale result can never add load to an upstream that is already struggling.
- **Nothing stored** - it fetches, waiting for as long as that query's `timeout` allows. There is nothing to configure: one query, one answer to how long it may take.

The fridge fetches when nobody else holds the lease and waits for whoever does, so however many readers arrive at once there is one upstream call - the same lease that keeps concurrent ticks to one. A query between backoff attempts answers `null` rather than waiting for something that is not coming, and when the timeout is reached the fetch is aborted and counted as a failure exactly as on a scheduled tick, leaving the read to answer `null`.

### Reader

A reader has no fetchers: `readResult` is all it needs to answer, and where the store offers `readSchedule` a miss reads the schedule row once, to tell a fetch that is about to land from a retry already scheduled for later:

```ts
const reader = createReader({ store, queries })
const fixed = await reader.read<Result>('analytics-7d')
const variant = await reader.read<Result>('course-analytics', {
  courseId: 'course-a',
  window: '7d',
})
```

`queries` is optional, and it decides two things. A name outside the registry throws instead of reading as `null`, and a miss waits for whichever executor is fetching - a reader cannot fetch, but it can wait, for as long as that query's `timeout` allows. Without the registry a reader needs nothing but a store, which is what lets it live in another Worker, another service, or another language; a miss then answers `null` at once, because nothing tells it how long a first result may take.

The result is:

```ts
interface ReadResult<T> {
  data: T
  fetchedAt: number
  isStale: boolean
  age: number
  status: 'ok' | 'invalid' // 'invalid' once the data's own window passed; data still served
  validUntil?: number
  lastError?: { at: number; message: string; count: number }
}
```

`read()` returns `null` only before the first successful refresh. It never invokes upstream code.

### Stores and test utilities

- `memoryStore()` returns the reference `Store` implementation.
- `storeContractSuite(label, factory)` is exported from `@datafridge/core/contract-tests` for Vitest adapter compatibility tests.
- `FakeClock` and `flushMicrotasks` support deterministic tests.
- `parseDuration`, `queryKey`, `systemClock`, `ConfigError`, and `TimeoutError` are public utilities.
- Store and engine interfaces are exported as TypeScript types from the package root.

Importing `@datafridge/core` has zero runtime dependencies. The optional `vitest` peer is only needed when importing `@datafridge/core/contract-tests`.

## `@datafridge/cloudflare`

All runtime exports are available from the package root. Independent subpaths are also available:

| Export | Subpath | Purpose |
|---|---|---|
| `FridgeDO`, `ensureStarted` | `@datafridge/cloudflare/do` | Durable Object alarm scheduler |
| `d1` | `@datafridge/cloudflare/d1` | The D1 store: result envelopes and atomic schedule claims |
| `cronDriver`, `cronFridge` | `@datafridge/cloudflare/cron` | Cron Trigger integration |
| `INVOCATION_WALL_CLOCK_LIMIT_MS` | package root | Cloudflare timeout ceiling |

### Durable Object alarms

Subclass `FridgeDO<Env>`, provide `queries` and `store(env)`, and optionally provide `sources`. The Durable Object keeps its own schedule bookkeeping in its SQLite storage, so only the store's result half is used.

```ts
class Poller extends FridgeDO<Env> {
  queries = queries
  sources = { analytics: { maxPerTick: 2 } }

  store(env: Env) {
    return d1(env.DB)
  }

  protected override onRunReport(report: RunReport) {
    logSanitized(report)
  }
}
```

`onRunReport(report)` is an optional operational hook after each alarm tick. Do not log query payloads, credentials, or sensitive error details. Hook failures are absorbed by the alarm loop, and the next alarm is still scheduled.

`ensureStarted(namespace, instanceName?)` idempotently ignites one named `FridgeDO` instance. The default instance name is `datafridge`.

The registry, source budgets, and Cloudflare timeout ceiling are validated when the object is ignited and before every alarm run. `timeout` must be shorter than 15 minutes, and every `maxPerTick` must be a positive integer.

### D1 stores

- `d1(db)` implements the full atomic `Store`: result envelopes plus schedule rows claimed with a version-checked `UPDATE`, so it stays safe under a non-serialized driver. `FridgeDO` carries its own schedule plane and simply leaves D1's unused.

It applies its own tables before the first write, so the packaged migration at `@datafridge/cloudflare/migrations/0001_datafridge_init.sql` is optional; a dropped table under a warm isolate is repaired and retried once. The read path never applies schema - a result table that does not exist yet reads as `null`. Writes larger than D1's 2,000,000-byte row limit are rejected while the previous envelope remains intact.

### Cron Triggers

`cronFridge(config)` performs environment-dependent store construction inside each invocation and returns a scheduled handler:

```ts
export default {
  scheduled: cronFridge<Env>({
    queries,
    store: (env) => d1(env.DB),
    sources: { analytics: { maxPerTick: 2 } },
    onRunReport: (report) => logSanitized(report),
  }),
}
```

`onRunReport` carries the same contract as the `FridgeDO` hook: sanitize before logging, and a throwing hook is absorbed so it cannot fail the tick. It validates the query registry, timeout ceiling, and store shape at module construction. `cronDriver(ctx)` is the lower-level non-serialized driver for applications that need to call `createFridge` directly and consume its `RunReport`.

### Init CLI

The package installs a `datafridge` binary:

```sh
pnpm exec datafridge init --scheduler <durable-object|cron> --store <d1> [--config wrangler.toml]
```

Both flags are required: there is no default pairing, and only the selected combination's declarations are written. Existing declarations are preserved. The CLI only edits TOML and refuses to create a conflicting TOML file beside `wrangler.json` or `wrangler.jsonc`.

See [Cloudflare setup and operations](./cloudflare.md) for the full deployment sequence.
