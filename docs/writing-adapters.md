# Writing adapters

English | [繁體中文](./zh-TW/writing-adapters.md)

datafridge's core only depends on contracts; it assumes nothing about any platform. Durable Objects, D1, Redis, cron, and node timers are all just adapters. Some backends make an adapter unusually easy to implement (a DO's single-threaded execution, for example) - that is the adapter's luck, never a core assumption.

The interfaces are deliberately tiny. The query registry is a finite set declared in code (a handful to a few dozen queries), so per-name `readSchedule` calls are entirely viable and `listDue` is only an optimization. Every call core makes is bounded: `listDue` always carries a finite limit, and no method asks a backend to hand over everything it holds. This is the guarantee behind "any backend gets an adapter in half a day".

## Store contract: one store, both halves

```ts
interface Store {
  // result plane - what readers see
  readResult(name: string): Promise<Envelope | null>
  writeResult(name: string, env: Envelope): Promise<void>
  deleteResult(name: string): Promise<void>        // used by registry reconcile

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
  // maxConcurrent across every executor: take one of `limit` permits, give it
  // back when the call ends, and let it expire if the holder never does. A
  // refusal names the soonest one could free, unless the caller said it will
  // not act on the answer.
  acquirePermit(source, limit, holder, expiresAt, now, explainRefusal?): Promise<PermitGrant>
  releasePermit(source: string, holder: string): Promise<void>
  // transient flights: overlapping reads of the same key make one call, and the
  // answer is handed only to the generation that waited for it
  joinFlight(key: string, expiresAt: number, now: number): Promise<FlightTicket>
  readFlight(key: string, now: number): Promise<FlightState | null>
  settleFlight(key, generation, outcome, keepUntil): Promise<boolean>
  sweepFlights(before: number, limit: number): Promise<number>
  // optional capability: one bounded batch of rows by name, in the order asked
  readSchedules?(names: readonly string[]): Promise<Array<ScheduleRow | null>>
  // optional capability: SQL backends can fetch a page of the earliest rows in
  // one query; without it, core reads row by row. `limit` is always finite -
  // core never asks a store to enumerate itself
  listDue?(now: number, limit: number): Promise<ScheduleRow[]>
  capabilities: { atomicClaim: boolean; listDue: boolean }
}
```

A store holds both halves. Applications only ever meet this one interface.

**A store creates the storage it needs.** Before its first write it must apply its own tables, keys, or collections, so no adapter ever ships a migration the user has to remember. Applying an equivalent schema by hand must stay a no-op, a backend whose storage disappears under a warm process must be repaired and retried rather than failing until that process recycles, and both reads - `readResult` and `readSchedule` - must stay plain reads: storage that does not exist yet reads as `null`, exactly like an empty one, because a read-only consumer's read path reaches both and must never apply schema. `@datafridge/cloudflare`'s `test/schema.test.ts` is the reference test to copy - the contract suite cannot enforce this, because the suite's factory is what prepares the backend.

This is what keeps `datafridge init <target>` the same size on every platform.

The two halves still have different consistency needs, and a stateful serialized driver may keep the schedule bookkeeping itself; then only the store's result half is used. Such a driver implements `SchedulePlane`, the schedule half alone, and it is adapter-level: implement it only if you are writing that kind of driver.

**Nothing shipped does.** `FridgeDO` deliberately keeps no dispatch state of its own: rows, leases, quota and results all live in the Store it is given, so a Durable Object and a cron trigger over the same D1 coordinate through that store rather than through whichever object happens to be the singleton. A scheduler that owns the coordination plane is a scheduler you cannot add a second reader to.

## Capability matrix

`claim()` is the universal contract; each backend implements it with its own atomic primitive. Whether a backend can host the schedule half comes down to one question: does it have atomic conditional writes?

| Backend | Atomic claim implementation |
|---|---|
| Redis | `SET NX PX` / Lua script |
| D1 / Postgres / SQLite | `UPDATE ... WHERE version = ?`, check changed rows |
| DO storage | single-threaded actor, inherently serialized (claim needs no CAS) |
| memoryStore | synchronous within one process |

A backend with no conditional-write primitive cannot host the schedule half at all, and one that is only eventually consistent cannot host it correctly. Such a backend declares `atomicClaim: false`, which construction accepts only under a serialized driver.

`takeQuota` uses the same primitive. Windows are fixed and aligned to the epoch - the one containing `now` starts at `floor(now / windowMs) * windowMs` and opens with a usage of zero - and a window is never rewound, so an executor whose clock lags cannot reopen one its peers have closed. `limit` arrives per call and is never stored: callers pass a lower one for work nobody is waiting on. One row per source is enough, so there is nothing to garbage-collect. Putting it in the store is what makes a shared rate limit free: two services pointing at one backend share one ledger, with no separate limiter to run.

`releaseQuota` is its counterpart, and it is what keeps a ceiling a count of calls rather than of intentions: quota is taken before a lease is claimed, so a dispatch that loses the claim credits its slot back. It is a guarded decrement, not a CAS loop - only while `window_start` still matches the window `takenAt` fell in, and only while usage is above zero. Usage cannot move between windows, so a window that has already rolled is left alone; that leaves the previous one over-counting by one, which is the safe direction for a ceiling.

`acquirePermit` is `maxConcurrent` made real across executors. It grants at most `limit` live permits per source and never waits - waiting is the caller's business - and every permit carries an expiry, because the one thing a holder that died will never do is release it. On SQL that is a single conditional insert (`INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < ?`), so the count and the take cannot be split by a peer.

Two details make it safe to build on. A refusal reports **when it could stop being one** - the soonest live permit for that source expires - so a caller can wait for something rather than poll for nothing; a scheduler uses that as its next wake time instead of trying again every second. And a `holder` that already holds a **live** permit is **refused, never allowed to take a second or to overwrite the first**: holder ids come from the caller, `random` is injectable, and a store that treated a duplicate as the same call would quietly hand two callers one permit. That refusal reports `retryAt: now`, because the source has room and only the id was in the way; the caller mints another and takes the slot. An id whose own permit has *expired* is not that caller: the table no longer counts that permit, so the id may take one again like any other.

`explainRefusal` is the caller saying whether it will act on `retryAt`. A reader waiting out a saturated source polls until its timeout, and only the last of those refusals is ever reported; the rest mint a fresh id and look again regardless. Deciding a refusal is one statement, but explaining it is a couple more - a count, and whatever collecting expired rows costs - and paying that per poll per waiting reader loads the store hardest exactly when the source is already saturated. So a store may answer `retryAt: null` when `explainRefusal` is false. Granting and refusing are unaffected; only the reason is optional, and a store that finds the reason free (an in-memory one does) may always give it. What a store must never do is invent one: `null` is the way to say "I did not look".

`readSchedules` is the batched form of `readSchedule`, and it exists for one case: a registry larger than the page a tick reads has to establish, by name, whether the rows it did not reach exist. Without it core asks one at a time. `names` is always a bounded batch, so a single `WHERE name IN (...)` is the whole implementation.

`joinFlight` is how overlapping reads of a parameter combination the registry does not name become one call. The first caller is the leader; anyone arriving while it runs is a follower of that `generation`. `settleFlight` writes the answer for that generation and is refused once the generation has moved on, which is what keeps a late answer from being handed to the wrong cohort. A caller arriving after a flight settles starts a new generation - the answer belongs to the readers who waited for it, and reusing it would make the combination a cached entry, which is exactly what it is not. Flights are transient: they expire, and `sweepFlights` drops the settled ones in bounded batches. It also drops running ones past their expiry, and callers pass a `before` already well behind `now` for a reason - deleting a running flight lets the next caller restart at generation one, which is exactly the value a late leader would still be holding. The margin is what keeps generations climbing.

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

`FridgeDO` takes the first shape: a serialized driver with no `schedule` of its own, so the store's half is the one that is used. Counter-example: a store that reports `atomicClaim: false` under `cronDriver(ctx)` throws, because overlapping cron invocations could then double-fetch.

## Driver contract

A driver is the integration shell. Its obligations:

1. Call `fridge.runDue(now?)` on its own cadence.
2. Provide `defer(promise)` - the Workers version wires it to `ctx.waitUntil`; long-lived processes make it a no-op.
3. Declare `serialized: boolean` - a guarantee that `runDue` never executes concurrently (true for a single-threaded DO or a single node process; false for Cron Triggers).
4. Optionally carry its own `schedule: SchedulePlane` (internal bookkeeping of a stateful driver).
5. Optionally declare `budgetMs` - how long this invocation may run. A tick then admits a call only while that call's own `timeout` still fits in what is left, and defers the rest rather than being killed halfway through them. Platforms with a wall clock (Cloudflare's 15 minutes) should always declare it.

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
