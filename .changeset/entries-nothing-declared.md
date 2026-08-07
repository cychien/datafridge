---
'@datafridge/core': major
'@datafridge/cloudflare': major
---

Open parameter spaces, without pretending they are entries.

```ts
defineParameterizedQuery({
  name: 'course-funnel',
  anyParams: true,
  timeout: '20s',
  source: 'posthog',
  fetch: ({ params, signal }) => fetchFunnel(params, { signal }),
})
```

Until now every variant had to be enumerable, which pushed open-ended parameter spaces - a funnel per course, an entry per custom date range - back into application code as a ladder of `if`s and a hard ceiling on how many could be declared. `anyParams` names no list at all: any params are accepted, and reading them is answered by one fresh call.

**Being an entry is what the registry decides, never what somebody happened to ask for.** Params the registry names - in `variants`, through `dimensions`, or from a dynamic list - are persistent scheduled entries with a row, a lease, backoff and a stored result. Params it does not name are not entries: nothing is stored, nothing is scheduled, and nothing keeps polling on their behalf. The alternative - letting a read mint a scheduled entry - means any caller can hand the scheduler work it then owns forever, and a store that grows with your URL space.

The call still leaves through the same dispatcher everything else does, so it spends the same source window (reserve included), obeys `maxConcurrent`, is bounded by the base's own `timeout` and honours `RateLimitError`. What it does not get is a lease, because there is no entry for it to be the current value of. An open base declares no `every`, `lease`, `validUntil` or `codec` - it is never scheduled and never stored - and all four are rejected at construction.

`createReader` is now the whole read path, not half of it. Given a full store it builds the same dispatcher a tick uses: a cold registry entry is filled by the reader itself, coalesced behind the same lease, and `anyParams` params are answered by that one fresh call. Given a results-only store it serves and waits exactly as before. That is what makes a Worker's request path complete on its own - and a registry with an `anyParams` base over a results-only store now fails at construction rather than at read time. Because a reader can be rate limited now, `Reader.read` can return `status: 'throttled'`.

`ScheduleRow` keeps `params`, so a variant row says what it is without the registry having to be consulted.
