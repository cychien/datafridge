# Writing adapters

English | [繁體中文](./zh-TW/writing-adapters.md)

datafridge's core only depends on contracts; it assumes nothing about any platform. Durable Objects, D1, Redis, cron, and node timers are all just adapters. Some backends make an adapter unusually easy to implement (a DO's single-threaded execution, for example) - that is the adapter's luck, never a core assumption.

The interfaces are deliberately tiny. The query registry is a finite set declared in code (a handful to a few dozen queries), so per-name `readSchedule` calls are entirely viable and `listDue` is only an optimization. This is the guarantee behind "any backend gets an adapter in half a day".

## Store contract: two independent slots

```ts
interface ResultStore {
  readResult(name: string): Promise<Envelope | null>
  writeResult(name: string, env: Envelope): Promise<void>
  deleteResult(name: string): Promise<void>        // used by registry reconcile
}

interface ScheduleStore {
  readSchedule(name: string): Promise<ScheduleRow | null>
  writeSchedule(row: ScheduleRow): Promise<void>
  deleteSchedule(name: string): Promise<void>
  // atomic claim: succeeds only if version matches and the lease has expired
  claim(name: string, expectedVersion: number, leaseUntil: number, now: number): Promise<boolean>
  // optional capability: SQL backends can fetch all due rows in one query;
  // without it, core reads row by row
  listDue?(now: number, limit: number): Promise<ScheduleRow[]>
  capabilities: { atomicClaim: boolean; listDue: boolean }
}
```

A "full Store" implements both. A result-only backend (a blob store like Cloudflare KV) implements just `ResultStore`.

## Capability matrix

`claim()` is the universal contract; each backend implements it with its own atomic primitive. Whether a backend can carry the schedule plane comes down to one question: does it have atomic conditional writes?

| Backend | Atomic claim implementation | Result plane | Schedule plane |
|---|---|---|---|
| Redis | `SET NX PX` / Lua script | yes | yes |
| D1 / Postgres / SQLite | `UPDATE ... WHERE version = ?`, check changed rows | yes | yes |
| DO storage | single-threaded actor, inherently serialized (claim needs no CAS) | yes | yes (as the doAlarms driver's internal bookkeeping) |
| Cloudflare KV | impossible - no conditional write primitive, eventually consistent, last-writer-wins | yes (and nothing more) | no |
| memoryStore | synchronous within one process | yes | yes |

Blob-only backends like KV can never carry the schedule plane. Because of eventual consistency, KV is not used in wave 1 at all; the roadmap only reconsiders it as an optional result-plane read replica (result-plane semantics already tolerate staleness).

## Schedule plane resolution rules (fail at config time)

```
createPoller({ results, schedule?, driver, queries })
createPoller({ store, driver, queries })          // store = full Store, fills both planes

The schedule plane resolves in order:
1. An explicitly passed schedule store          -> use it (non-serialized drivers require atomicClaim)
2. The driver carries its own schedule          -> use the driver's
   (stateful serialized drivers, e.g. DO alarms)
3. store / results also implements ScheduleStore
   with atomicClaim                             -> use it (one backend does both, e.g. D1/Redis)
4. None of the above                            -> throw at construction, never degrade silently
```

Three typical configurations:

```ts
createPoller({ store: d1Store(env.DB), driver: cronDriver(ctx), queries })
createPoller({ results, driver: { serialized: true, defer, schedule }, queries })
createPoller({ results: customResults, schedule: customAtomicSchedule,
               driver: cronDriver(ctx), queries })
```

`PollerDO` constructs the second shape internally with its SQLite schedule store. Counter-example: `{ results: d1Results(...), driver: cronDriver(ctx) }` has only the ResultStore subset, cron is not serialized, and no explicit schedule store. Rule 4 applies, so construction throws.

## Driver contract

A driver is the integration shell. Its obligations:

1. Call `poller.runDue(now?)` on its own cadence.
2. Provide `defer(promise)` - the Workers version wires it to `ctx.waitUntil`; long-lived processes make it a no-op.
3. Declare `serialized: boolean` - a guarantee that `runDue` never executes concurrently (true for a single-threaded DO or a single node process; false for Cron Triggers).
4. Optionally carry its own `schedule: ScheduleStore` (internal bookkeeping of a stateful driver, like DO alarms).

A non-serialized driver combined with a schedule store lacking `atomicClaim` is a construction-time error.

## Acceptance bar: the contract compatibility test suite

`@datafridge/core` ships a Store contract compatibility test suite, first proven against the built-in `memoryStore` reference implementation. It encodes every timeline in [Concepts](./concepts.md) as a deterministic test (injected fake clock, zero sleeps): claim/lease behavior, expired-lease re-claim, zombie write rejection, concurrent `runDue` fetching each query exactly once, and so on.

An adapter is accepted when it passes this suite against its real backend - the Cloudflare `d1Store`, for example, runs the full suite against a real D1 binding, including the concurrent CAS claim cases. No adapter rewrites its own correctness tests; the suite is the spec for the adapter ecosystem.

## Packaging rules

Packages are distribution units, not composition units - composition freedom is guaranteed by the core interfaces and has nothing to do with package boundaries.

1. **Cluster by shared runtime dependency.** The three Cloudflare parts (doAlarms, d1, cron shell) share one dependency set and release cadence, so they share one package. Redis and SQLite depend on different clients, so they each get their own.
2. **Each part is an independent subpath export** (`@datafridge/cloudflare/do`, `/d1`, `/cron`) - import only what you use.
3. **No package may depend on a sibling package; every part talks only to core's interfaces.** `PollerDO` accepts any `ResultStore`, so cross-package mixing (DO scheduler + Redis results) is just installing two packages, and always legal.
4. Pure-JS, platform-free parts live in core, not in platform packages.
5. Drivers are inherently platform-shaped (Cloudflare's scheduled handler, node's timer, a K8s HTTP endpoint all look different), so organizing them by platform reflects reality.
