---
'@datafridge/core': major
'@datafridge/cloudflare': minor
---

Variant lists can live in a database: arrays are static, functions are dynamic, and `dimensions` composes them.

```ts
defineParameterizedQuery({
  name: 'course-analytics',
  every: '15m',
  dimensions: {
    preset: ['7d', '30d', '90d'],
    courseId: ({ signal }) => listCourseAnalyticsIds(db, { signal }),
  },
  fetch: ({ params, signal }) => ...,
})
```

An array expands once at construction, exactly as before. A function - `variants` itself, or any single dimension - is now resolved at every tick and may be async, so a list that changes at runtime needs no shadow tables or hand-rolled reconciliation: the reconcile that already creates and deletes variant rows simply runs against the current list. A resolution that throws deletes nothing - the base keeps everything it has, and the failure lands in that tick's `RunReport`. A resolver receives `{ signal }` exactly as `fetch` does and is bound by the base's own `timeout`, so a list that hangs is aborted and counted as a failed resolution rather than stalling the tick; bases resolve concurrently. Reads stay cheap: a stored result is served without consulting the list, and only a miss resolves it, to fetch a member or reject a non-member.

`dimensions` is the cartesian product of its entries, one param field per dimension, so a preset axis no longer has to be flattened into query names by hand.

This changes what a function-valued `variants` means: it used to be expanded once when `defineQueries` ran. Returning a fresh registry from a `FridgeDO` `queries` getter to pick up list changes is no longer needed.

`@datafridge/cloudflare`: the Durable Object's next alarm now comes from its schedule rows, which is what lets dynamic variants - rows with no static registry entry - keep the alarm chain alive, including retrying a base whose resolution keeps failing on its own cadence.
