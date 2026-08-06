---
'@datafridge/core': major
'@datafridge/cloudflare': major
---

Entries for sets too large to list, kept alive by being read.

```ts
defineParameterizedQuery({
  name: 'course-funnel',
  every: '15m',
  retain: '2h',
  source: 'posthog',
  fetch: ({ params, signal }) => fetchFunnel(params, { signal }),
})
```

Until now every variant had to be enumerable, which pushed open-ended sets - a funnel per course, an entry per custom date range - back into application code as a ladder of `if`s and a hard ceiling on how many could be declared. `retain` names no list at all: any params become an entry the first time somebody reads them. Between then and eviction it is an ordinary entry with its own schedule row, lease, backoff and result, refreshed on `every` and metered by its `source` - the read that creates it goes through the same dispatcher a tick does, so it is coalesced and rate limited like everything else.

What keeps an entry alive is a read, never a refresh; polling cannot vote for itself. An entry idle for longer than `retain` loses its result and its row, and with them its place in the tick - eviction is what stops the refreshing, there is no second switch. A cold read whose very first fetch fails leaves a backoff row and no result, so a reader hammering a broken key cannot hammer upstream with it, and once that backoff expires the row is dropped: one read is not evidence of ongoing demand.

Two contract changes carry it. `ScheduleRow` gains `params`, because a key is a hash and an entry nothing declared cannot be rebuilt from its name alone; the row is now enough to run the work by itself. `Store` gains `touchResult` and `evictIdleResults`, and `d1()` grows a `last_read_at` column - applied by the store as always, so there is still no migration to run.

`createReader` takes `defer` and uses the store's `touchResult` when it has one. This matters: on Cloudflare the read path is a reader, so a reader that cannot record reads is a reader whose on-demand entries all go cold. `retain` must be longer than `every`, and the schedule plane must be able to list its rows; both are checked at construction.
