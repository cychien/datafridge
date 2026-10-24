# API reference

English | [繁體中文](./zh-TW/api.md)

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

`defineQueries(definitions)` returns a `Queries` registry. Each fixed query supports:

| Field | Required/default | Meaning and configuration |
|---|---|---|
| `name` | Required | The public query identifier used by `read(name)`. It must be unique and non-empty within the registry, and must not start with the reserved `@df/v1/` prefix. |
| `every` | Required | The target interval before the next scheduled refresh after a successful fetch. It also determines when a result reports `isStale: true`. This is not an exact cron interval: rate limits, backoff, or platform delays may make the actual refresh later. |
| `timeout` | `'30s'` | The maximum duration of one fetch. Its `signal` is aborted when time runs out, and a cold read waits for at most this duration. |
| `lease` | `timeout + 30s` | How long a claim prevents another executor from duplicating the work. If an executor dies, the work can be claimed again after the lease expires. It must exceed `timeout`; the default is usually appropriate. |
| `source` | `'default'` | The upstream quota group. Queries that share one provider quota should use the same source name. |
| `fetch` | Required | The async function that calls upstream. Its return value is written to the Store. It should throw on failure and pass `signal` to clients that support cancellation. |
| `codec` | Optional | `{ encode(value), decode(raw) }`. Encodes non-JSON-native data before storage and decodes it when read by a reader holding the registry. |
| `validUntil` | Optional | `(ctx: { params?, now }) => number`. Returns the epoch-millisecond time when the data itself becomes invalid. The data is still returned after that point, but its `status` is `'invalid'`. |

Durations accept positive millisecond numbers or strings ending in `ms`, `s`, `m`, `h`, or `d`, such as `5000`, `'30s'`, or `'10m'`.

`fetch` context:

| Field | Meaning |
|---|---|
| `signal` | An `AbortSignal` aborted when `timeout` expires. |
| `now` | Epoch milliseconds when this upstream call started. |
| `attempt` | `1` on the first attempt, incremented after each consecutive failure, and reset after success. |

### Parameterized queries

```ts
const analytics = defineParameterizedQuery({
  name: 'course-analytics',
  every: '10m',
  variants: [
    { courseId: 'course-a', window: '7d' },
    { courseId: 'course-a', window: '30d' },
  ],
  fetch: ({ params, signal }) => fetchAnalytics(params, { signal }),
})

const queries = defineQueries([analytics])
```

A parameterized query supports the fixed-query fields plus:

| Field | Required/default | Meaning |
|---|---|---|
| `variants` | Choose one of three | An array of params, or a function that receives `{ signal }` and returns an array of params. An array expands once; a function may be async and is resolved on every tick. |
| `dimensions` | Choose one of three | Candidate values for each params field. datafridge expands their cartesian product. Each value may be an array or a function receiving `{ signal }`. |
| `anyParams` | Choose one of three | Set to `true` to accept any params. See the next section. |
| `fetch.params` | Provided automatically | The current variant's params snapshot. |

Set exactly one of `variants`, `dimensions`, or `anyParams`. Every listed variant has its own result, schedule, lease, and backoff. Dynamic lists automatically reconcile params as they are added or removed.

Params must contain finite numbers, strings, booleans, `null`, arrays, or plain objects, and must not contain credentials. Use `queryKey(name, params)` to get the stable storage identity.

### Open parameter spaces

```ts
const funnel = defineParameterizedQuery({
  name: 'course-funnel',
  anyParams: true,
  timeout: '20s',
  source: 'posthog',
  fetch: ({ params, signal }) => fetchFunnel(params, { signal }),
})
```

| Field | Required/default | Meaning |
|---|---|---|
| `name` | Required | The query base name. |
| `anyParams` | Must be `true` | Accepts any valid `QueryParams`. |
| `timeout` | `'30s'` | The deadline for each upstream call triggered by a read. |
| `source` | `'default'` | The rate-limit group. |
| `fetch` | Required | Runs on each read and receives `params` in its context. |

`anyParams` does not accept `every`, `lease`, `validUntil`, or `codec`. Every read makes a new unstored call; concurrent reads for the same params still coalesce. The reader must use a full Store.

### Fridge

```ts
const fridge = createFridge({ queries, driver, store, sources })

const report = await fridge.runDue()
const value = await fridge.read<Result>('analytics-7d')
```

`createFridge(config)`:

| Field | Required/default | Meaning |
|---|---|---|
| `queries` | Required | A `Queries` registry or query definitions. |
| `store` | Required | A full `Store` that provides both result and schedule capabilities. |
| `driver` | Required | The scheduler integration, configured in the next table. |
| `sources` | No limit | Rate-limit and concurrency policies for each source. |
| `clock` | `systemClock` | An injectable clock, primarily for adapters and tests. |
| `random` | System random | An injectable random function, primarily for adapters and tests. |

`driver`:

| Field | Required/default | Meaning |
|---|---|---|
| `serialized` | Required | Whether only one `runDue()` is guaranteed to run at a time. |
| `defer` | Required | Keeps a background promise alive, such as Workers' `ctx.waitUntil`. |
| `schedule` | Optional | A `SchedulePlane` owned by the driver. When omitted, the Store's schedule capabilities are used. |
| `budgetMs` | Optional | The wall-clock budget for one invocation. Queries that do not fit are deferred to the next run. |

`sources[source]`:

| Field | Required/default | Meaning |
|---|---|---|
| `limit.requests` | Required with `limit` | Calls allowed in each window. |
| `limit.per` | Required with `limit` | Duration of the fixed, epoch-aligned window. |
| `limit.reserve` | `0` | Capacity reserved for cold reads and unavailable to scheduled refreshes. It must be less than `requests`. |
| `maxConcurrent` | No limit | Maximum simultaneous upstream calls for the same source. |

Each source policy must set `limit`, `maxConcurrent`, or both.

`runDue(now?)` runs due work and returns:

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

`fridge.read(name, params?)` and `Reader.read()` use the same read semantics.

### Reader

```ts
const reader = createReader({ store, queries, sources, defer })
const result = await reader.read<Result>('analytics-7d')
```

`createReader(config)`:

| Field | Required/default | Meaning |
|---|---|---|
| `store` | Required | A results-only or full `Store`. A full Store with `queries` can fetch on a cold miss. |
| `queries` | Optional | Validates query names and provides the fetcher and `timeout` for cold misses. Without it, a miss immediately returns `null`. |
| `sources` | No limit | Source policies used when the reader fetches for itself. |
| `defer` | No-op | Keeps work alive beyond the response. Workers usually pass `ctx.waitUntil`. |
| `clock` | `systemClock` | An injectable clock. |
| `random` | System random | An injectable random function. |

- Stored data is returned immediately without calling upstream.
- A cold miss on a full Store fetches; a results-only Store only waits for another executor to write.
- When quota or concurrency is exhausted, it returns `{ status: 'throttled', retryAt }`.

```ts
interface ReadResult<T> {
  data: T
  fetchedAt: number
  isStale: boolean
  age: number
  status: 'ok' | 'invalid'
  validUntil?: number
  lastError?: { at: number; message: string; count: number }
}
```

It returns `null` when no successful result exists and none arrives within `timeout`.

### Stores and test utilities

| Export | Purpose |
|---|---|
| `memoryStore()` | The in-memory reference implementation of a full `Store`. |
| `storeContractSuite(label, factory)` | Imported from `@datafridge/core/contract-tests` to validate a Store adapter. |
| `FakeClock`, `flushMicrotasks` | Deterministic test utilities. |
| `parseDuration`, `queryKey`, `resolveSources`, `systemClock` | Public utilities. |
| `ConfigError`, `TimeoutError`, `RateLimitError` | Public error classes. |

Store, driver, query, and result interfaces are exported from the package root. `@datafridge/core` has no runtime dependencies; only the contract tests use the optional `vitest` peer.

## `@datafridge/cloudflare`

| Export | Subpath | Purpose |
|---|---|---|
| `FridgeDO`, `ensureStarted` | `@datafridge/cloudflare/do` | Durable Object alarm scheduler. |
| `d1` | `@datafridge/cloudflare/d1` | D1 Store. |
| `cronDriver`, `cronFridge` | `@datafridge/cloudflare/cron` | Cron Trigger integration. |
| `INVOCATION_WALL_CLOCK_LIMIT_MS` | Package root | Cloudflare invocation ceiling. |

### `FridgeDO`

```ts
export class Poller extends FridgeDO<Env> {
  queries = queries
  sources = sourcePolicies

  store(env: Env) {
    return d1(env.DB)
  }

  protected override onRunReport(report: RunReport) {
    logSanitized(report)
  }
}
```

| Member | Required/default | Meaning |
|---|---|---|
| `queries` | Required | A registry or query definitions. |
| `store(env)` | Required | Returns a full `Store`: `d1(env.DB)`, `postgresStore(...)`, or any other. Called at the start of every alarm. |
| `sources` | No limit | Source policies. |
| `onRunReport(report)` | No-op | A hook after each alarm. Do not log payloads or unsanitized error details. |

`store(env)` runs once per alarm, so it should return a cheap wrapper over a connection the object keeps: a Durable Object may reuse its connections across its own requests and alarms, so hold a Postgres pool on the instance and return `postgresStore(this.pool)`, rather than opening a pool per alarm.

`ensureStarted(namespace, instanceName?)` starts the alarm chain. `instanceName` defaults to `'datafridge'`, and repeated calls are safe. Cloudflare query `timeout` values must be shorter than 15 minutes.

### `d1`

`d1(db)` wraps a `D1Database` as a full `Store` with atomic claims.

- Tables are created automatically before the first write; the included migration is optional.
- Reads do not create schema, and a missing table is treated as an empty Store.
- Results exceeding D1's 2,000,000-byte row limit are rejected while the previous result is preserved.

### `cronFridge`

```ts
export default {
  scheduled: cronFridge<Env>({
    queries,
    store: (env) => d1(env.DB),
    sources,
    onRunReport,
  }),
}
```

| Field | Required/default | Meaning |
|---|---|---|
| `queries` | Required | A registry or query definitions. |
| `store(env)` | Required | Creates a full Store for each invocation. A plain Worker cannot reuse a connection across invocations, so give it a store that holds none open between statements, such as `postgresStore(neon(url, { fullResults: true }))`. |
| `sources` | No limit | Source policies. |
| `onRunReport(report)` | No-op | A hook after each tick. |

`cronDriver(ctx)` is the lower-level non-serialized driver for integrations that need to use `createFridge` or `RunReport` directly.

### Init CLI

```sh
pnpm exec datafridge init --scheduler <durable-object|cron> --store d1 [--config wrangler.toml]
```

| Flag | Required/default | Meaning |
|---|---|---|
| `--scheduler` | Required | `durable-object` or `cron`. |
| `--store` | Required | Currently `d1`. |
| `--config` | `wrangler.toml` | The TOML file to update. |

The CLI preserves existing declarations and adds only the bindings, migration, or cron trigger needed by the selected combination. See [Cloudflare setup](./cloudflare.md) for the full deployment sequence.

## `@datafridge/postgres`

| Export | Purpose |
|---|---|
| `postgresStore(db)` | Postgres Store with atomic claims and `listDue`. |
| `ensureSchema(db)` | Creates the tables and indexes the store owns, if missing. |
| `POSTGRES_SCHEMA` | The same DDL as single statements, for your own migration pipeline. |
| `PostgresQueryable`, `PostgresClient` | The client shapes `db` may take. |

```ts
import { createReader } from '@datafridge/core'
import { ensureSchema, postgresStore } from '@datafridge/postgres'

const store = postgresStore(pool)
await ensureSchema(pool) // optional: the first write does it otherwise
const reader = createReader({ store, queries, sources })
```

`db` is the client your app already holds; the store never opens a connection of its own and has no runtime dependencies. It accepts anything with `query(text, params) => Promise<{ rows }>` - a node-postgres `Pool`, `Client` or `PoolClient`, PGlite, Neon's `Pool` and `Client`, or `neon(url, { fullResults: true })` - and a Drizzle database over node-postgres or PGlite, whose `$client` it reads again for every statement, so a database that hands out connections per request or per Durable Object keeps working. A node-postgres `Client` serves one statement at a time; prefer a `Pool` wherever several reads or ticks share it.

- **One statement per operation, no transactions.** Atomicity comes from Postgres row locks: a claim is an `UPDATE ... WHERE version = $n`, which re-checks its condition on the newest row once it holds the lock; the quota ledger and the concurrency permits are single `INSERT ... ON CONFLICT DO UPDATE` statements over one row per source; flights are leased the same way, and the sweep skips rows a peer has locked. A pool is therefore safe to pass as is, under `READ COMMITTED`.
- **Tables.** `datafridge_results`, `datafridge_schedule`, `datafridge_quota`, `datafridge_permit` and `datafridge_flight`, unqualified, so they land in the first schema on the connection's `search_path`. The packaged `migrations/0001_datafridge_init.sql` holds the same statements as `POSTGRES_SCHEMA`.
- **Schema.** Applied before the first write, once per client, in one statement that checks each object before creating it: several processes starting at once all succeed, and a role without `CREATE` on the schema runs against tables someone else migrated. Reads never create anything; a missing table reads as empty. A table dropped under a running process is re-created on the next write. If a schema tool manages the same database and drops tables it does not know, exclude `datafridge_*` from it.
- **Fidelity.** Envelopes are stored as JSON text, so key order and every string survive exactly; timestamps are `DOUBLE PRECISION`, exact for any JavaScript number.
