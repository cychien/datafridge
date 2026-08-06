# Concepts

English | [繁體中文](./zh-TW/concepts.md)

datafridge turns slow or unreliable APIs into local reads that are always instant and always labeled with their age. After the first successful refresh, stale-if-error keeps them populated. This page explains the data model and the semantics behind that promise.

## The semantic contract

These six guarantees are the product. Every implementation must uphold them:

1. **A read never waits on a result that exists.** `read()` only touches the result store. With nothing stored yet it waits for the first one, bounded by that query's `timeout`; from then on every read is local and immediate.
2. **Reads always carry time.** Every result includes `fetchedAt`, so callers always know its age.
3. **Stale-if-error.** An upstream failure keeps the last-known-good result and marks it stale instead of replacing it with an error.
4. **At-least-once refresh.** If an executor dies mid-run, another executor picks up the work after its lease expires.
5. **Write-back consistency.** Version checks reject late writes from concurrent or zombie executors.
6. **Fail at config time.** Invalid durations, duplicate names, unsafe leases, unsupported platform timeouts, and a store that cannot claim safely throw during construction.

They are the specification, not a summary of one. The rest of this page explains the lease, version, backoff, and staleness model that implements them, and every store adapter has to pass the contract compatibility suite in `@datafridge/core/contract-tests` before it is considered correct.

## Architecture in one picture

```
┌──────────────────────────────────────────────┐
│  Driver - who ticks, and how often            │
│  wave 1: DO Alarms / Cron Triggers            │
├──────────────────────────────────────────────┤
│  Core - pure logic, zero deps, no IO,         │
│  injected clock: registry, due computation,   │
│  priority, budget, backoff, lease, staleness  │
├──────────────────────────────────────────────┤
│  Store - where results and schedule state live│
│  wave 1: D1                                   │
└──────────────────────────────────────────────┘
```

Three orthogonal axes: the **store** decides where state lives, the **driver** decides who ticks, and **fetchers** run wherever the poller instance runs.

Core's single entry point is the idempotent `runDue(now)`. Core never owns an event loop, never schedules itself, and holds no memory state across calls - everything is read from the store, computed, and written back. That is why the same core runs in a long-lived Node process, a cold-starting Worker, or a multi-instance concurrent environment.

## The two planes

Every query has two kinds of state with completely different consistency needs. One `Store` holds both; the distinction still matters because their consistency requirements differ, and because a stateful serialized driver may keep the schedule half itself.

### Result plane - the product itself

What users read. It can live in any cheap, fast-to-read storage.

```ts
interface Envelope<T> {
  data: T
  fetchedAt: number            // epoch ms
  freshUntil: number           // fetchedAt + every; after this, isStale = true
  validUntil?: number          // the data's own expiry; past it, status = 'invalid'
  lastError?: { at: number; message: string; count: number }
}
```

Envelopes serialize as plain JSON. A consumer in any language can use them by reading the underlying result store directly - no TypeScript runtime required.

### Schedule plane - coordination bookkeeping

Small, but it must support atomic operations or be protected by serialization.

```ts
interface ScheduleRow {
  name: string
  nextRunAt: number
  failCount: number
  leaseUntil: number | null
  version: number              // for CAS; can be relaxed under serialized execution
}
```

This half has exactly two legitimate homes:

1. The store, when it has atomic conditional writes (CAS) - works in any concurrent environment (multi-instance cron, multi-machine deployments).
2. Inside a stateful, serialized driver - the driver guarantees a single writer, and where it keeps the bookkeeping is its own implementation detail (DO alarms use their own SQLite; a node timer would use process memory plus any persistence). The store's schedule half then goes unused.

The formal rules are in [writing-adapters.md](./writing-adapters.md).

## Parameter variants and identity

A parameterized query expands a finite runtime list into ordinary scheduled identities. Every variant has its own `ScheduleRow`, lease, version, failure count, backoff, and `Envelope`. Registry reconcile therefore treats added and removed variants exactly like added and removed fixed queries.

Variant params are canonical JSON. The storage key is `@df/v1/<encoded-base-name>/<sha256-of-canonical-params>`, so raw IDs and preset values do not appear in D1 keys or `RunReport`. SHA-256 provides a stable collision-resistant identity across object key ordering. Params are identifiers, not secret storage: credentials and private payloads must remain in bindings or fetcher closures.

Only variants in the finite registry are scheduled and directly readable. Arbitrary on-demand variants are not created on read.

## Staleness semantics

- A result is **fresh** until `freshUntil` (`fetchedAt + every`). After that, `read()` reports `isStale: true`.
- `read()` also returns `age` (milliseconds since `fetchedAt`), so callers can apply their own thresholds.
- `read()` returns `null` only when the query has never fetched successfully (the first round has not completed). Callers should handle this case explicitly.
- Staleness is a label, never a block: stale data is served immediately, exactly like fresh data.

## The runDue pipeline

```
runDue(now):
1. Collect candidates   nextRunAt <= now (no record = first run = due now)
2. Prioritize           by overdue ratio (now - nextRunAt) / every, descending
                        (ratio, not absolute lateness: 4 minutes late is 0.8 of a
                        5m query's period but only 0.07 of a 60m query's)
3. Apply budget         group by source, take the top maxPerTick per group;
                        squeezed-out queries stay due and are picked up next tick
4. Claim lease          claim(name, version, now + timeout + margin);
                        losing the claim means someone else is on it - skip
5. Execute + write back concurrently (Promise.allSettled), each fetch wrapped
                        in an AbortSignal timeout
                        success: writeResult + nextRunAt = completion time + every,
                                 failCount = 0
                        failure: keep old envelope, failCount++,
                                 nextRunAt = now + backoff(failCount)
Returns RunReport { ran, skippedLeased, deferredBudget, failed }
```

Key decisions:

- **Fixed-delay semantics.** The next run is measured from completion time. Slow queries naturally slow themselves down and never queue up behind themselves.
- **Backoff.** `min(every, 1m * 2^(failCount - 1))` plus jitter, capped at `every` because retrying slower than the normal period is pointless.
- **Jitter.** First registration offsets `nextRunAt` randomly, so queries with integer-multiple periods never permanently align on the same tick and stampede one source's budget. The budget is the fuse; jitter keeps the fuse from blowing in normal operation.
- **Three lines of defense**, one gate each: `nextRunAt` decides "should this run", the lease decides "who is running it", the version decides "whose result counts". Slowness, crashes, and zombies each break through one gate; the next one catches them.

### A slow query, minute by minute

`every: 5m`, `timeout: 4m`, tick every minute:

```
12:00 tick    claim succeeds (lease until 12:04:30), fetch starts
12:01-12:04   nextRunAt is still 12:00 (updated only on completion), so the query
              looks due, but claim fails: silently skipped
              read() keeps returning the last good result instantly the whole time
Ending A      success: write back, nextRunAt = completion time + 5m
Ending B      timeout: abort, failCount = 1, backoff reschedule, old result kept
Ending C      executor dies: nothing written back; the 12:05 tick sees the expired
              lease and re-claims
Zombie write  version has moved on, write rejected; one upstream call wasted,
              store stays consistent
```

## Failure semantics

| Situation | Behavior | What read() sees |
|---|---|---|
| Upstream error / timeout | failCount++, backoff reschedule, old envelope kept | old data + `isStale` |
| Executor dies mid-run | re-claimed on the next tick after the lease expires (at-least-once) | old data + `isStale` |
| Zombie writes back late | version mismatch, write rejected | unaffected |
| First round not finished | - | `null` (callers should handle it) |
| Squeezed out by budget | stays due, prioritized next tick (overdue ratio grows) | old data, slightly older |
| Persistent failures | backoff converges at `every`, last-known-good kept forever | old data + `lastError` visible |
