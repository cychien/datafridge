---
'@datafridge/core': minor
---

A read with nothing stored waits for the first result, and a reader can hold the query registry.

```ts
const reader = createReader({ store: d1(env.DB), queries })
await reader.read('weekly-summary')
```

Until now the first reader after a deploy got `null` and had nothing to show. With a Durable Object that lasts about a second, because ignition schedules an immediate alarm; under a Cron Trigger it can last until the next minute. Now that read waits for the first result instead, for as long as the query's own `timeout` allows. There is nothing to configure: one query, one answer to how long it may take. Only a miss ever waits - an existing result, stale or not, still returns immediately, so the hot path is untouched.

However many readers miss at once, the lease keeps it to a single upstream call: the fridge fetches when nobody holds the lease and waits for whoever does, and across isolates the store's version-checked claim settles it. The same lease that keeps two scheduled ticks from overlapping now keeps a cold start from becoming a stampede. A query between backoff attempts answers `null` at once rather than waiting for something that is not coming, and when the timeout is reached the fetch is aborted and counted as a failure exactly as on a scheduled tick.

`queries` on `createReader` is optional and decides two things: a name outside the registry throws instead of reading as `null`, and a miss waits rather than answering `null`, since the registry is where that timeout lives. Without it a reader still needs nothing but a store.

`read` takes params positionally on both sides: `read(name, params?)`. `fridge.read`'s `params` option is gone.
