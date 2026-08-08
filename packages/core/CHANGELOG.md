# @datafridge/core

## 1.1.0

### Minor Changes

- 165744f: A source ceiling that actually counts, and that both kinds of call obey.

  ```ts
  sources: {
    posthog: {
      limit: { requests: 100, per: '1m', reserve: 10 },
      maxConcurrent: 4,
    },
  }
  ```

  A per-source `maxPerTick` was a fuse, not a limit: it bounded scheduled refreshes per tick, knew nothing about how often ticks happen, and read misses walked straight past it. `limit` replaces it with real accounting. The store keeps one ledger row per source - the fixed, epoch-aligned window it is counting and how much of it is spent - and every upstream call increments it under the same version-checked CAS that claims a lease. Two Workers, a cron trigger and a Durable Object pointing at one D1 now share one count. `takeQuota` and `releaseQuota` join the store contract, with a chapter in the compatibility suite; `d1()` and `FridgeDO` grow a `datafridge_quota` table and apply it themselves, so there is still no migration to run.

  It counts calls, not intentions. Quota is taken before a lease is claimed, so a call with nowhere to go never takes a lease it would hand straight back; a dispatch that then loses the claim to a peer credits its slot back to the window it took it from, which is what `releaseQuota` is for.

  `reserve` is what keeps a reader from losing to the scheduler. Scheduled refreshes see `requests - reserve`, a read miss sees the whole `requests` - because a tick landing on the window boundary would otherwise spend the whole minute in its first second, and the person waiting on a cold read would find nothing left. A refused refresh is turned away before it claims anything, so it stays exactly as due as it was and comes back more overdue; those names arrive in `RunReport.throttled`, which replaces `deferredBudget`.

  Capacity is a separate question from rate, and it is not a number you set. A tick bounds itself from what you already declared: it reads one bounded page of the earliest rows, admits a call only while that call's own `timeout` fits the invocation's remaining wall clock (`Driver.budgetMs`), stops asking a source that already refused this tick, and removes at most a bounded number of departed rows. What does not fit is left exactly as it was and comes back in `RunReport.deferred`, most overdue first. `runDue` also reports `nextRunAt`, so a driver that schedules its own wake-ups re-arms from the tick rather than from storage.

  A read that runs out of quota waits, inside its own `timeout`, for the window to roll - and if the window outlasts the reader it answers `status: 'throttled'` with a `retryAt`, not `null`. "Not your turn yet" is not "there is nothing", and a UI has to be able to tell them apart. A reader over the whole store produces it too, because it is making the same calls.

  `maxConcurrent` bounds in-flight calls to a source inside one instance, for vendors that tolerate the rate but not the burst; a reader waiting out a window hands its slot back for the duration, because a call that is doing nothing must not hold the budget that bounds calls that are. And `RateLimitError { retryAfterMs }` lets a fetcher hand a vendor's own `Retry-After` back, so the retry lands when the vendor said instead of on the generic backoff curve - still jittered, because everyone it turned away heard the same number.

  Resolving a dynamic variant list is not counted. It is not a source query: it usually reaches your own database, not the vendor being limited.

- 2fef1d5: Data that expires on its own clock: `validUntil` on the query, `status` on every read.

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

- 2fef1d5: Variant lists can live in a database: arrays are static, functions are dynamic, and `dimensions` composes them.

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

- 5cb75c6: Open parameter spaces, without pretending they are entries.

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

  The call still leaves through the same dispatcher everything else does, so it spends the same source window (reserve included), obeys `maxConcurrent`, is bounded by the base's own `timeout` and honours `RateLimitError`. What it does not get is a lease, because there is no entry for it to be the current value of. An open base declares no `every`, `lease`, `validUntil` or `codec` - it is never scheduled and never stored - and all four are rejected at construction, not just by the types.

  `createReader` is now the whole read path, not half of it. Given a full store it builds the same dispatcher a tick uses: a cold registry entry is filled by the reader itself, coalesced behind the same lease, and `anyParams` params are answered by that one fresh call. Given a results-only store it serves and waits exactly as before. That is what makes a Worker's request path complete on its own - and a registry with an `anyParams` base over a results-only store now fails at construction rather than at read time. Because a reader can be rate limited now, `Reader.read` can return `status: 'throttled'`.

  `ScheduleRow` keeps `params`, so a variant row says what it is without the registry having to be consulted.

- 7a69fba: Concurrency and coalescing move into the store, where every executor can see them.

  Two things used to be true only inside one process, and both were the kind of true that stops being true the moment you deploy.

  `maxConcurrent` was per-instance smoothing. On Workers that is one ceiling per invocation, which is not a ceiling - fifty concurrent requests were fifty times whatever you wrote down. It is now a permit taken in the store for the length of the call and given back when it ends, so the number means the same thing to a Durable Object, a cron trigger and fifty request-path readers. A holder that dies never gives its permit back, so permits expire; until then they count, and after they do not. A scheduled refresh that finds no permit does not queue for one - it stays due and arrives in `RunReport.deferred`.

  Overlapping reads of params the registry does not name were separate calls. They now coalesce through a _flight_: the first reader makes the call, everyone who arrives while it is running takes its answer, and the cohort costs one upstream call and one quota slot however many Workers it spans. A reader arriving after that flight settles gets a new flight and a new call - the answer belongs to the readers who waited for it, and reusing it for whoever asks next would make the combination the cached entry it is deliberately not. Handoff is generation-scoped, so a late answer is refused rather than given to the wrong cohort; a dead leader is taken over once its deadline passes; flights expire and are swept in bounded batches by the tick.

  A refusal from either ceiling says when it could stop being one. `acquirePermit` reports the soonest live permit for that source, so a permit-starved read answers `status: 'throttled'` with a real `retryAt` rather than `null` - nothing reached upstream, so nothing is missing - and a scheduled refusal re-arms the alarm at that moment instead of once a second until the peer finishes. Either way the quota the call reserved is handed straight back. Running out of invocation wall clock still asks for the next tick immediately, because that is the one refusal that names no time.

  Holder ids are the caller's, and `random` is injectable, so uniqueness is never assumed: a store refuses a `holder` that already holds a live permit rather than letting it take a second or overwrite the first, and the caller mints another and takes the slot. The compatibility suite pins that, because the two obvious wrong answers - overwrite, or raise - breach the ceiling and lose the call respectively. An id whose own permit has expired is not that caller, and may take one again.

  Saying _why_ a permit was refused costs more than deciding it. A reader waiting out a saturated source polls until its timeout and reports only the last of those refusals, so `acquirePermit` takes an `explainRefusal` flag and may answer `retryAt: null` when the caller says it will not act on the reason. On D1 a refused poll is now one statement rather than three, on exactly the path a saturated source makes hottest. What a store may never do is invent a moment: `null` means "I did not look".

  `acquirePermit`, `releasePermit`, `joinFlight`, `readFlight`, `settleFlight` and `sweepFlights` join the store contract with chapters in the compatibility suite, alongside an optional `readSchedules` for reading a bounded batch of rows by name. `d1()` grows a `datafridge_permit` and a `datafridge_flight` table and applies them itself.

  Two costs the first cut left behind are gone. A tick no longer looks up a row per registry entry the page did not reach: a short page a tick actually read _is_ the whole table, so those names are known to have no row without asking, and past a page the lookups go out in bounded batches. A store without `listDue` reads no page at all, and an empty one there is evidence of nothing, so it keeps reading row by row exactly as documented. And `sweepFlights` keeps a running flight until its expiry is well behind, because deleting one lets the next caller restart at generation one - the very value a late leader would still be holding, and the thing the generation guard rests on.

  One quieter fix rides along, and it is the reason a large registry was previously unusable: a tick decided "there is more due work" from the _size_ of the page it read rather than from whether that page ran out while still due. Past one page of schedule rows - an ordinary `dimensions` product - every tick asked to be woken again in one second, forever, with nothing to do, and any query without a row yet was never planned at all. Dueness now comes from the page's last row, and a registry name the page did not reach is read by name instead of guessed at.

- 7698ce0: One store, one interface. `Store` holds both halves of what datafridge keeps - result envelopes and schedule bookkeeping - and `d1(db)` is the single D1 store.

  `createFridge`, `cronFridge`, and `FridgeDO` each take one `store`. `createReader({ store })` needs nothing but `readResult` to answer, so a read-only consumer can supply just that; a store that also offers `readSchedule` lets a miss tell a fetch that is about to land from a retry already scheduled for later.

  A stateful serialized driver may keep the schedule half itself, through the adapter-level `SchedulePlane` that applications never touch; the store's schedule half then goes unused. `FridgeDO` does not: it takes the store's, so the object is a scheduler rather than a coordination plane. A store that cannot claim atomically is still refused at construction under a non-serialized driver, rather than quietly double-fetching.

- 48279ce: One exit to upstream, and a read that never opens it.

  ```ts
  const fridge = createFridge({ queries, driver, store })
  await fridge.read('weekly-summary')
  ```

  Upstream calls used to leave by three different doors: a scheduled tick, a read miss, and a stale read's background refresh. Each door carried its own subset of the rules - the read miss skipped per-source budgets entirely - so every guarantee had to be re-implemented, and re-proved, once per door. They now converge on a single dispatcher: claim the lease, run under the deadline, write back under a version check, reschedule or back off. A scheduled refresh and a read miss are the same work arriving through different doors, distinguished only by which one has a reader waiting.

  `swrRefresh` is gone with the third door. `read` has exactly two behaviours: something stored returns at once - fresh, stale, or `invalid` alike - and touches nothing upstream, and nothing stored fetches, bounded by that query's own `timeout`. Refreshing what is already there is the scheduler's job, so reading a stale result can no longer add load to an upstream that is already struggling. `read(name, params?)` is the whole signature on both the fridge and the reader; `PollerReadOptions` is gone.

  The engine is a fridge, not a poller - it has served reads as well as ticks for a while now. `createPoller` is `createFridge` (`PollerConfig` -> `FridgeConfig`, `Poller` -> `Fridge`), `PollerDO` is `FridgeDO`, and `cronPoller` is `cronFridge` (`CronPollerConfig` -> `CronFridgeConfig`). There are no aliases for the old names. The class you export from your Worker is still yours to name, so `wrangler.toml` needs no change; `ensureStarted`'s default instance name is now `datafridge`, so pass the old `'datafridge-poller'` explicitly to keep an already-running Durable Object.

- 2fef1d5: A query can carry a codec.

  ```ts
  {
    name: 'lesson-engagement',
    every: '15m',
    codec: {
      encode: (v) => ({ rows: [...v.byPath] }),
      decode: (raw) => ({ byPath: new Map(raw.rows) }),
    },
    fetch: ...,
  }
  ```

  Results are stored as plain JSON, so a fetched `Map`, `Set`, or `Date` used to need hand-rolled Serialized* wrapper types and conversions on both sides. `encode` runs on write, `decode` on read, and the wrapper types disappear. The stored row stays plain JSON, readable from any language; only a reader holding the query registry decodes, and a bare reader sees the encoded form. An `encode` that throws counts as a fetch failure and keeps the previous result.

- cd3878d: A read with nothing stored waits for the first result, and a reader can hold the query registry.

  ```ts
  const reader = createReader({ store: d1(env.DB), queries })
  await reader.read('weekly-summary')
  ```

  Until now the first reader after a deploy got `null` and had nothing to show. With a Durable Object that lasts about a second, because ignition schedules an immediate alarm; under a Cron Trigger it can last until the next minute. Now that read waits for the first result instead, for as long as the query's own `timeout` allows. There is nothing to configure: one query, one answer to how long it may take. Only a miss ever waits - an existing result, stale or not, still returns immediately, so the hot path is untouched.

  However many readers miss at once, the lease keeps it to a single upstream call: the fridge fetches when nobody holds the lease and waits for whoever does, and across isolates the store's version-checked claim settles it. The same lease that keeps two scheduled ticks from overlapping now keeps a cold start from becoming a stampede. A query between backoff attempts answers `null` at once rather than waiting for something that is not coming, and when the timeout is reached the fetch is aborted and counted as a failure exactly as on a scheduled tick.

  `queries` on `createReader` is optional and decides two things: a name outside the registry throws instead of reading as `null`, and a miss waits rather than answering `null`, since the registry is where that timeout lives. Without it a reader still needs nothing but a store.

  `read` takes params positionally on both sides: `read(name, params?)`. `fridge.read`'s `params` option is gone.

## 1.0.0

### Major Changes

- cf8950d: Release the complete Wave 1 surface plus the accepted finite parameterized-query slice: the proactive refresh core, per-variant scheduling and identity, D1 stores, Durable Object alarm and Cron Trigger scheduling, packaged migrations, and the Cloudflare init CLI.
