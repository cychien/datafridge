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

### Open parameter spaces

Some parameter spaces are too large or too open-ended to enumerate. `anyParams` names no list at all: any params are accepted, and reading them is answered by one fresh call.

```ts
const funnel = defineParameterizedQuery({
  name: 'course-funnel',
  anyParams: true,
  timeout: '20s',
  source: 'posthog',
  fetch: ({ params, signal }) => fetchFunnel(params, { signal }),
})
```

Pass exactly one of `variants`, `dimensions`, or `anyParams`.

**Being an entry is what the registry decides, never what somebody happened to ask for.** A parameter combination the registry names - declared in `variants`, produced by `dimensions`, or returned by a dynamic list - is a persistent scheduled entry with its own row, lease, backoff and stored result. A combination the registry does not name is not an entry, and reading it stores nothing: no result, no schedule row, no membership. It is a call, and it is answered as one.

That call still leaves through the same dispatcher everything else does, so it draws on the source's window (with the reserve a waiting reader is entitled to), obeys `maxConcurrent`, is bounded by the base's own `timeout`, and honours `RateLimitError`.

**Reads that overlap still coalesce.** The first reader of a given `queryKey` makes the call; every reader that arrives while it is running joins that flight and takes its answer. A cohort of a hundred concurrent requests is one upstream call and one quota slot, however many Workers they landed in - the flight is coordinated in the store, not in one process's memory. A read that arrives *after* that flight settles is a new flight and a new call: an answer belongs to the readers who waited for it, and handing it to whoever asks next would be a cache, which is exactly what an unnamed combination does not get.

- **It is never scheduled.** An open base contributes nothing to a tick, so it declares no `every`, no `lease` and no `validUntil`. Nothing is stored, so it takes no `codec` either; all four are rejected at construction.
- **The flight is transient.** It holds no result, expires on its own, and is swept by the next tick. A leader that dies is taken over by the next reader once its deadline passes, and a settled answer stops being handed out shortly after the cohort has had it.
- **A read must pass params.** An open base with no params names no combination at all.
- **The reader has to be able to make the call.** `createReader` needs the whole store - one that can claim and meter, like `d1(env.DB)` - not a results-only one. That is checked when the reader is constructed, not when somebody reads.
- **A failed call answers `null`**, and leaves no backoff behind, because there is nothing for a backoff to be attached to. Reach for a declared variant when you want failure to be remembered.

### Fridge

```ts
const fridge = createFridge({
  queries,
  driver,
  store,
  sources: { analytics: { limit: { requests: 100, per: '1m', reserve: 10 } } },
})

const report = await fridge.runDue()
const value = await fridge.read<Result>('analytics-7d')
```

`createFridge(config)` requires:

- `queries`: a `Queries` registry or raw query definitions
- `driver`: `{ serialized, defer(promise), schedule?, budgetMs? }`
- `store`: one store holding both result envelopes and schedule rows

Optional fields are `sources`, `clock`, and `random`. `clock` and `random` exist for deterministic adapters and tests. See [where the schedule half comes from](./writing-adapters.md#where-the-schedule-half-comes-from-decided-at-config-time).

There is no knob for how much work one tick does. A tick reads one bounded page of rows, takes the most overdue of them first, admits a call only while its own `timeout` still fits the invocation's `budgetMs` and while its source has not already refused this tick, and leaves the rest exactly as it found them. Page sizes are an implementation detail and deliberately not configurable; what bounds a tick is the things you already declared - `every`, `timeout`, `limit`, `reserve`, `maxConcurrent` - plus the wall clock the driver reports.

Construction rejects a missing or malformed driver, a store missing either half, an invalid source policy, or a store that cannot claim atomically under a non-serialized driver.

`sources` declares what each source will tolerate. `limit` is a hard ceiling counted in the store's quota ledger and shared by every executor; `reserve` holds part of each window back from scheduled refreshes so a waiting reader still gets through; `maxConcurrent` bounds in-flight calls across every executor sharing the store. See [rate limiting](./rate-limiting.md).

`runDue(now?)` reconciles the registry, selects due work most-overdue first, meters each source against its ledger, claims leases, runs fetchers concurrently, and returns:

```ts
interface RunReport {
  ran: string[]
  skippedLeased: string[]
  throttled: string[]
  deferred: string[]
  failed: Array<{ name: string; message: string }>
  nextRunAt: number | null
}
```

`throttled` is the source's window and `deferred` is everything else this invocation could not take on - its remaining wall clock, or the source's concurrency ceiling. Both leave the row exactly as it was, so both come back more overdue rather than lost, and both feed `nextRunAt`: a ceiling names when it could give way, while running out of wall clock asks for the next invocation. `nextRunAt` is when this fridge next has work, computed from the rows the tick already held - a driver that schedules its own wake-ups uses it instead of asking storage again, and `null` means there is nothing scheduled at all.

A successful refresh schedules the next run from completion time. A failure preserves the prior envelope and retries with jittered exponential backoff capped at `every`.

`fridge.read(name, params?)` reads the result store. It throws for a name or parameter variant outside the registry.

```ts
await fridge.read('course-analytics', { courseId: 'course-a', window: '7d' })
```

A read has exactly two behaviours, and no options that change them:

- **Something stored** - it returns at once, fresh, stale or `invalid` alike, and touches nothing upstream. Refreshing what is already there belongs to the scheduler, so reading a stale result can never add load to an upstream that is already struggling.
- **Nothing stored** - it fetches, waiting for as long as that query's `timeout` allows. There is nothing to configure: one query, one answer to how long it may take.

The fridge fetches when nobody else holds the lease and waits for whoever does, so however many readers arrive at once there is one upstream call - the same lease that keeps concurrent ticks to one. A query between backoff attempts answers `null` rather than waiting for something that is not coming, and when the timeout is reached the fetch is aborted and counted as a failure exactly as on a scheduled tick, leaving the read to answer `null`.

A miss on a source that has run out of quota - or whose calls are all already in flight - answers a third status rather than `null`, because "not your turn yet" is not "there is nothing":

```ts
const result = await fridge.read<Result>('analytics-7d')
if (result?.status === 'throttled') return retryAfter(result.retryAt)
```

A reader over the whole store answers this the same way, because it is the same read path.

### Reader

```ts
const reader = createReader({ store, queries, sources, defer })
const fixed = await reader.read<Result>('analytics-7d')
const variant = await reader.read<Result>('course-analytics', {
  courseId: 'course-a',
  window: '7d',
})
```

`store` decides what a reader is allowed to do, and there are two kinds.

**A results-only store** - anything with `readResult`, plus `readSchedule` if it has one - makes a reader that serves and waits. A hit is answered at once; a miss waits for whichever executor is fetching, and where `readSchedule` exists it tells a fetch about to land from a retry already scheduled for later, so it does not wait out a backoff. This is the reader that lives in another Worker, another service, or another language.

**The whole store** - one that can claim and meter, like `d1(env.DB)` - makes a reader that can also fetch, through the same dispatcher a tick uses. A miss coalesces behind the same lease, spends the same source window, and leaves the same ordinary entry behind; `anyParams` reads are answered by one fresh call. This is what makes a request path complete on its own, with no scheduler in the loop and no singleton to queue behind. Because it can now be rate limited, its reads can answer `status: 'throttled'` too.

`queries` is optional, and it decides two things: a name outside the registry throws instead of reading as `null`, and a miss knows how long it may take. Without it a reader needs nothing but a store, and a miss answers `null` at once because nothing tells it how long a first result may take. `sources` declares the ceilings for calls this reader makes itself, and `defer` (`ctx.waitUntil` on Workers) is where a fetch that outlives the answer goes to finish.

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
- `parseDuration`, `queryKey`, `systemClock`, `resolveSources`, `ConfigError`, `TimeoutError`, and `RateLimitError` are public utilities. Adapters call `resolveSources` to reject a bad source policy at their own construction time.
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
  sources = { analytics: { limit: { requests: 100, per: '1m', reserve: 10 } } }

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

The registry, source policies, and Cloudflare timeout ceiling are validated when the object is ignited and before every alarm run. `timeout` must be shorter than 15 minutes.

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
    sources: { analytics: { limit: { requests: 100, per: '1m', reserve: 10 } } },
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
