---
'@datafridge/core': major
'@datafridge/cloudflare': major
---

A source ceiling that actually counts, and that both kinds of call obey.

```ts
sources: {
  posthog: {
    limit: { requests: 100, per: '1m', reserve: 10 },
    maxConcurrent: 4,
  },
}
```

`maxPerTick` was a fuse, not a limit: it bounded scheduled refreshes per tick, knew nothing about how often ticks happen, and read misses walked straight past it. `limit` replaces it with real accounting. The store keeps one ledger row per source - the fixed, epoch-aligned window it is counting and how much of it is spent - and every upstream call increments it under the same version-checked CAS that claims a lease. Two Workers, a cron trigger and a Durable Object pointing at one D1 now share one count. `takeQuota` joins the store contract, with a chapter in the compatibility suite; `d1()` and `FridgeDO` grow a `datafridge_quota` table and apply it themselves, so there is still no migration to run.

`reserve` is what keeps a reader from losing to the scheduler. Scheduled refreshes see `requests - reserve`, a read miss sees the whole `requests` - because a tick landing on the window boundary would otherwise spend the whole minute in its first second, and the person waiting on a cold read would find nothing left. A refused refresh is turned away before it claims anything, so it stays exactly as due as it was and comes back more overdue; those names arrive in `RunReport.throttled`, which replaces `deferredBudget`.

A read that runs out of quota waits, inside its own `timeout`, for the window to roll - and if the window outlasts the reader it answers `status: 'throttled'` with a `retryAt`, not `null`. "Not your turn yet" is not "there is nothing", and a UI has to be able to tell them apart. `createReader` never produces it: a reader has no fetchers to limit.

`maxConcurrent` bounds in-flight calls to a source inside one instance, for vendors that tolerate the rate but not the burst. And `RateLimitError { retryAfterMs }` lets a fetcher hand a vendor's own `Retry-After` back, so the retry lands when the vendor said instead of on the generic backoff curve - still jittered, because everyone it turned away heard the same number.

Resolving a dynamic variant list is not counted. It is not a source query: it usually reaches your own database, not the vendor being limited.
