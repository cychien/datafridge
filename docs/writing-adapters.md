# Writing adapters

English | [繁體中文](./zh-TW/writing-adapters.md)

datafridge's core only depends on contracts; it assumes nothing about any platform. Durable Objects, D1, Redis, cron, and node timers are all just adapters. Some backends make an adapter unusually easy to implement (a DO's single-threaded execution, for example) - that is the adapter's luck, never a core assumption.

The interfaces are deliberately tiny. The query registry is a finite set declared in code (a handful to a few dozen queries), so per-name `readSchedule` calls are entirely viable and `listDue` is only an optimization. This is the guarantee behind "any backend gets an adapter in half a day".

## Store contract: one store, both halves

```ts
interface Store {
  // result plane - what readers see
  readResult(name: string): Promise<Envelope | null>
  writeResult(name: string, env: Envelope): Promise<void>
  deleteResult(name: string): Promise<void>        // used by registry reconcile
  // `retain`: record that something was read, and drop what has gone cold
  touchResult(name: string, at: number): Promise<void>
  evictIdleResults(keyPrefix: string, idleBefore: number): Promise<string[]>

  // schedule plane - coordination bookkeeping
  readSchedule(name: string): Promise<ScheduleRow | null>
  writeSchedule(row: ScheduleRow): Promise<void>
  deleteSchedule(name: string): Promise<void>
  // atomic claim: succeeds only if version matches and the lease has expired
  claim(name: string, expectedVersion: number, leaseUntil: number, now: number): Promise<boolean>
  // source rate limiting: count one call in the fixed window containing `now`,
  // and answer whether it fit under `limit`
  takeQuota(source: string, limit: number, windowMs: number, now: number): Promise<boolean>
  // hand a counted call back when it never happened, to the window it was taken in
  releaseQuota(source: string, windowMs: number, takenAt: number): Promise<void>
  // optional capability: SQL backends can fetch all due rows in one query;
  // without it, core reads row by row
  listDue?(now: number, limit: number): Promise<ScheduleRow[]>
  capabilities: { atomicClaim: boolean; listDue: boolean }
}
```

A store holds both halves. Applications only ever meet this one interface.

`touchResult` is reached from the read path, so like the two reads it must never apply schema: with nothing stored there is nothing to record. `evictIdleResults` deletes results and names them, and deliberately does not touch schedule rows - the schedule half may live in a different object entirely, so removing those is the caller's job. A fresh `writeResult` counts as read at its `fetchedAt`, or an entry created by a cold read would be evictable before anybody could record reading it; a later `writeResult` leaves the stamp where the reader put it, because a refresh is not a read.

**A store creates the storage it needs.** Before its first write it must apply its own tables, keys, or collections, so no adapter ever ships a migration the user has to remember. Applying an equivalent schema by hand must stay a no-op, a backend whose storage disappears under a warm process must be repaired and retried rather than failing until that process recycles, and both reads - `readResult` and `readSchedule` - must stay plain reads: storage that does not exist yet reads as `null`, exactly like an empty one, because a read-only consumer's read path reaches both and must never apply schema. `@datafridge/cloudflare`'s `test/schema.test.ts` is the reference test to copy - the contract suite cannot enforce this, because the suite's factory is what prepares the backend.

This is what keeps `datafridge init <target>` the same size on every platform.

The two halves still have different consistency needs, and one shipped case proves it: a stateful serialized driver can keep the schedule bookkeeping itself, and then only the store's result half is used. Such a driver implements `SchedulePlane`, the schedule half alone. `FridgeDO` is exactly that - its bookkeeping lives in the Durable Object's own SQLite while envelopes go to the store you hand it. `SchedulePlane` is adapter-level: implement it only if you are writing that kind of driver.

## Capability matrix

`claim()` is the universal contract; each backend implements it with its own atomic primitive. Whether a backend can host the schedule half comes down to one question: does it have atomic conditional writes?

| Backend | Atomic claim implementation |
|---|---|
| Redis | `SET NX PX` / Lua script |
| D1 / Postgres / SQLite | `UPDATE ... WHERE version = ?`, check changed rows |
| DO storage | single-threaded actor, inherently serialized (claim needs no CAS); used as the alarm driver's own `SchedulePlane` |
| memoryStore | synchronous within one process |

A backend with no conditional-write primitive cannot host the schedule half at all, and one that is only eventually consistent cannot host it correctly. Such a backend declares `atomicClaim: false`, which construction accepts only under a serialized driver.

`takeQuota` uses the same primitive. Windows are fixed and aligned to the epoch - the one containing `now` starts at `floor(now / windowMs) * windowMs` and opens with a usage of zero - and a window is never rewound, so an executor whose clock lags cannot reopen one its peers have closed. `limit` arrives per call and is never stored: callers pass a lower one for work nobody is waiting on. One row per source is enough, so there is nothing to garbage-collect. Putting it in the store is what makes a shared rate limit free: two services pointing at one backend share one ledger, with no separate limiter to run.

`releaseQuota` is its counterpart, and it is what keeps a ceiling a count of calls rather than of intentions: quota is taken before a lease is claimed, so a dispatch that loses the claim credits its slot back. It is a guarded decrement, not a CAS loop - only while `window_start` still matches the window `takenAt` fell in, and only while usage is above zero. Usage cannot move between windows, so a window that has already rolled is left alone; that leaves the previous one over-counting by one, which is the safe direction for a ceiling.

## Where the schedule half comes from (decided at config time)

```
createFridge({ store, driver, queries })

1. The driver carries its own bookkeeping   -> use the driver's
   (stateful serialized drivers, e.g. DO alarms; the store's schedule half goes unused)
2. Otherwise                                -> use the store's own schedule half

Either way, claiming must be safe: the chosen half needs atomicClaim, or the
driver must be serialized. Otherwise construction throws, never degrades silently.
```

Two typical configurations:

```ts
createFridge({ store: d1(env.DB), driver: cronDriver(ctx), queries })
createFridge({ store: d1(env.DB), driver: { serialized: true, defer, schedule }, queries })
```

`FridgeDO` constructs the second shape internally with its SQLite `SchedulePlane`. Counter-example: a store that reports `atomicClaim: false` under `cronDriver(ctx)` throws, because overlapping cron invocations could then double-fetch.

## Driver contract

A driver is the integration shell. Its obligations:

1. Call `fridge.runDue(now?)` on its own cadence.
2. Provide `defer(promise)` - the Workers version wires it to `ctx.waitUntil`; long-lived processes make it a no-op.
3. Declare `serialized: boolean` - a guarantee that `runDue` never executes concurrently (true for a single-threaded DO or a single node process; false for Cron Triggers).
4. Optionally carry its own `schedule: SchedulePlane` (internal bookkeeping of a stateful driver, like DO alarms).

A non-serialized driver combined with schedule bookkeeping lacking `atomicClaim` is a construction-time error.

## Acceptance bar: the contract compatibility test suite

`@datafridge/core` ships a Store contract compatibility test suite, first proven against the built-in `memoryStore` reference implementation. It encodes every timeline in [Concepts](./concepts.md) as a deterministic test (injected fake clock, zero sleeps): claim/lease behavior, expired-lease re-claim, zombie write rejection, concurrent `runDue` fetching each query exactly once, and so on.

An adapter is accepted when it passes this suite against its real backend - the Cloudflare `d1` store, for example, runs the full suite against a real D1 binding, including the concurrent CAS claim cases. No adapter rewrites its own correctness tests; the suite is the spec for the adapter ecosystem.

## Packaging rules

Packages are distribution units, not composition units - composition freedom is guaranteed by the core interfaces and has nothing to do with package boundaries.

1. **Cluster by shared runtime dependency.** The three Cloudflare parts (doAlarms, d1, cron shell) share one dependency set and release cadence, so they share one package. Redis and SQLite depend on different clients, so they each get their own.
2. **Each part is an independent subpath export** (`@datafridge/cloudflare/do`, `/d1`, `/cron`) - import only what you use.
3. **No package may depend on a sibling package; every part talks only to core's interfaces.** `FridgeDO` accepts any `Store`, so cross-package mixing (DO scheduler + a Redis store) is just installing two packages, and always legal.
4. Pure-JS, platform-free parts live in core, not in platform packages.
5. Drivers are inherently platform-shaped (Cloudflare's scheduled handler, node's timer, a K8s HTTP endpoint all look different), so organizing them by platform reflects reality.
