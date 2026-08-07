---
'@datafridge/core': minor
---

Data that expires on its own clock: `validUntil` on the query, `status` on every read.

```ts
{
  name: 'traffic-today',
  every: '15m',
  validUntil: ({ now }) => endOfTodayUtc(now),
  fetch: ...,
}
```

Freshness by age was the only axis datafridge knew, but "today's traffic" also stops being today's at midnight, however recently it was fetched - so window bookkeeping grew in application code, up to apps rescheduling by writing datafridge's own schedule rows. `validUntil` returns that boundary; it is stored on the result, a read past it reports `status: 'invalid'` while still serving the data, and the scheduler re-fetches at the boundary rather than a full period later, so a Durable Object's alarm fires right at midnight. Stale-if-error composes: an upstream failure across the boundary serves the old window's data as `invalid` with `lastError` attached, and the read still answers from the store while the scheduler fetches the new window at the boundary.

Every `ReadResult` now carries `status: 'ok' | 'invalid'` (and `validUntil` when set); queries without `validUntil` always read `ok`.
