# Rate limiting

English | [繁體中文](./zh-TW/rate-limiting.md)

datafridge groups queries by `source` (the `source` field on a query definition, defaulting to `'default'`) and limits how hard each source gets hit. Every upstream call leaves through one dispatcher, so the ceiling below is a ceiling on *all* of them - a scheduled refresh and a read that found nothing stored draw on the same window.

```ts
createFridge({
  driver: cronDriver(ctx),
  store: d1(env.DB),
  queries,
  sources: {
    posthog: {
      limit: { requests: 100, per: '1m', reserve: 10 },
      maxConcurrent: 4,
    },
  },
})
```

## The ceiling: `limit`

`limit` is exact accounting, not a heuristic. The store keeps one ledger row per source - the window it is counting and how many calls that window has taken - and every call increments it under the same version-checked CAS that claims a lease. Two Workers, a cron trigger and a Durable Object all pointing at one D1 share one count.

It counts calls, not intentions. Quota is taken before a lease is claimed, so that a call with nowhere to go never takes a lease it would hand straight back - and a dispatch that then loses the claim to a peer credits its slot back to the window it took it from, because that call never happened.

Windows are **fixed and aligned to the epoch**: with `per: '1m'`, the window containing 12:34:56.789 runs from 12:34:00.000 and opens at zero. A sliding window would be more precise at the boundary, at the cost of storing a timestamp per call; a fixed window plus `reserve` and `maxConcurrent` covers the same ground with one row.

A scheduled refresh that cannot get a call **stays due**. It is refused before it claims a lease, so nothing is written, and the next tick sees it as it was - only more overdue. Because priority is the overdue *ratio* `(now - nextRunAt) / every`, a query squeezed out climbs every tick it waits, and nothing starves. Those names come back in `RunReport.throttled`.

## The reserve: who gets the last call in a window

Scheduled work does not care *when* in a window it runs; a reader does, because there is a person behind it. Without a reserve, a tick landing on the window boundary can spend the whole minute's quota in its first second, and every read for the next 59 seconds finds nothing left.

`reserve` is the fix, and it is the only pacing knob: scheduled refreshes see `requests - reserve`, a read miss sees the full `requests`. It defaults to 0, which is the right value when a source has no cold reads to protect - and the wrong one as soon as it does.

A read that has run out of quota does not answer `null`, which would mean "there is nothing". It answers a third status:

```ts
const result = await fridge.read('course-funnel', { courseId })
if (result?.status === 'throttled') {
  // Nothing is wrong and nothing is missing: it is not this reader's turn yet.
  return retryAfter(result.retryAt)
}
```

Before giving up it waits, inside its own `timeout`, for the window to roll - so a query whose timeout outlasts the window fetches on the far side of the boundary instead of failing. It does not hold a lease while it waits: the quota comes first, and only a call that has one goes on to claim.

## The smoothing: `maxConcurrent`

`maxConcurrent` bounds how many calls to a source are in flight at once - across every executor sharing the store, not per process. It bounds concurrency, not volume: a hundred due queries behind `maxConcurrent: 4` still make a hundred calls, four at a time. Use it when a vendor tolerates the rate but not the burst, and keep in mind that a tick then lasts as long as its slowest chain of four (see the [Cloudflare invocation limits](./cloudflare.md#limits-and-ceilings)).

It is a permit in the store, taken for the length of the call and given back when it ends. A holder that dies never gives its permit back, so a permit also expires; until then it counts, and after it does not. That is what makes the number mean the same thing to a Durable Object, a cron trigger and fifty concurrent Worker invocations - the alternative is a limit each, which is not a limit.

In flight means in flight: a reader waiting out a quota window holds no permit, so a call that is doing nothing cannot sit on the budget that exists to bound calls that are.

The two kinds of caller wait differently, for the same reason they do at the quota window. A **read** queues for a permit inside its own `timeout`, and if the deadline arrives first it answers `status: 'throttled'` with the `retryAt` of the soonest permit that could free - never `null`, because nothing reached upstream and nothing is missing. A **scheduled refresh** does not queue at all: it stays due, comes back more overdue, and arrives in `RunReport.deferred`. Either way the quota that call reserved is handed straight back, because no call happened.

## The capacity: what one invocation will take on

Capacity is not a rate limit and does not belong to a source, and it is not a number you set. A tick bounds itself from things you already declared:

- It reads **one bounded page** of the earliest rows. Page size is an implementation detail; what matters is that no registry size can make a tick read more storage than that.
- It admits a call only while that call's own **`timeout`** still fits in the invocation's remaining wall clock, which the driver reports as `budgetMs`. Work that could not have finished is never begun.
- It stops asking a source that has **already refused this tick**, whether the window is spent or its permits are all out. One answer is how it learns; the rest of that source's work is deferred without paying a round trip to be told the same thing.
- It **waits for the refusal to mean something**. A ceiling names the moment it could give way - the window boundary, or the soonest permit expiry - so the next wake is then, not a second later and not three hundred times over. Running out of wall clock names nothing, and only that asks to be followed immediately.
- It removes at most a **bounded number of departed rows** per tick, because a list that dropped ten thousand variants at once is a deployment, not an emergency.

What does not fit is not touched: no lease, no store write, nothing asked of upstream. Those names come back in `RunReport.deferred`, and because priority is the overdue ratio they are the most overdue thing the next tick sees. The tick also reports `nextRunAt`, so a `FridgeDO` re-arms straight away when there is a backlog and drains it at the one-second alarm floor rather than in one invocation that risks the wall clock.

## Jitter

On first registration each query's `nextRunAt` gets a random offset, so queries with integer-multiple periods (`5m`, `10m`, `1h`) never permanently align on the same tick and collectively slam one source. Failures back off exponentially with jitter for the same reason. The ledger is the fuse; jitter keeps the fuse from blowing in normal operation.

## When upstream says no: `RateLimitError`

A fetcher that gets a 429 can say so, and pass along what the vendor asked for:

```ts
import { RateLimitError } from '@datafridge/core'

fetch: async ({ signal }) => {
  const response = await fetch(url, { signal })
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') ?? 0)
    throw new RateLimitError('posthog rate limited', { retryAfterMs: retryAfter * 1_000 })
  }
  return response.json()
}
```

The retry is then scheduled for when the vendor said rather than on the generic backoff curve - still jittered, because every executor it turned away heard the same number. Without `retryAfterMs` it is an ordinary failure with an ordinary backoff.

## What is not counted

Resolving a dynamic variant list is not a call against the source. It is not a source query: it usually reaches your own database or config service, not the vendor being limited. It is still bounded by the base's `timeout`, cancelled through its `signal`, and backed off in a schedule row of its own when it fails.

## Sharing a limit across services

`takeQuota` is part of the store contract, so a source's ledger lives wherever the store does. Two services that point at the same D1 - or, later, the same Redis - share one count with no further coordination. That is the whole mechanism: there is no separate rate-limiter to run.
