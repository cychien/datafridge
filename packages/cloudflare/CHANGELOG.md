# @datafridge/cloudflare

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

- 1773678: `d1()` applies its own tables, so there is no migration to run before the first deploy.

  Forgetting the migration used to fail quietly: the first tick threw `no such table`, the alarm loop absorbed it to keep the chain alive, and every read returned `null` with nothing to explain why. Now the schema is applied once per binding before the first write, and a table that disappears under a warm isolate is re-created and retried once rather than failing until that isolate recycles.

  The read path stays a single `SELECT` and never applies schema. A result table that does not exist yet reads as `null`, which is the same answer an empty one gives - any other error still propagates.

  The packaged migration is still there for teams that would rather declare the schema in their own pipeline; applying it makes the automatic step a no-op, and a test keeps the two from drifting.

  `cronFridge` also accepts `onRunReport` now, under the same contract as the `FridgeDO` hook: sanitize before logging, and a throwing hook cannot fail the tick. Getting at the report no longer means dropping down to `cronDriver` plus `createFridge`.

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

- 1773678: `datafridge init` takes the scheduler and the store as separate choices, and writes only what that combination needs.

  ```sh
  datafridge init --scheduler durable-object --store d1
  datafridge init --scheduler cron --store d1
  ```

  It used to scaffold both schedulers and tell you to delete the one you were not using. Generated configuration you have to prune is not a starting point, and it contradicted the rest of the library: the pieces compose freely, so `init` should not hand out a fixed pairing. Both flags are required - there is no default - and an unknown value is refused with the list of supported ones rather than guessed at.

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

- 389b4e4: D1 is the coordination plane; the Durable Object is only a scheduler.

  `FridgeDO` used to keep schedule rows, leases and the quota ledger in its own SQLite. It no longer keeps any of it: rows, leases, versions, backoff, quota and results all live in the Store you give it, and the object's own storage holds one row recording which registry it last ignited for. It is a thing that wakes up on time, and nothing else.

  This is what makes the rest composable. A cron trigger and a Durable Object over the same D1 now coordinate through D1 rather than through whichever object happens to be the singleton, and a request path can read - and fetch - against that same data without an RPC to it. A scheduler that owns the coordination plane is a scheduler you cannot put a second reader beside.

  The alarm follows from the tick instead of re-deriving it: `runDue` returns `nextRunAt`, computed from rows it already held, so re-arming costs no storage read at all - where it previously scanned the whole schedule table on every alarm. `cronDriver` and `FridgeDO` both declare the platform's 15-minute wall clock as the tick's `budgetMs`.

  Because the coordination plane is the store, a request path is complete without the object: `createReader` over the same `d1(env.DB)` serves what is stored, fills a cold entry through the same dispatcher, and shares the same quota ledger, the same concurrency permits and the same in-flight coalescing as the scheduler.

- 48279ce: One exit to upstream, and a read that never opens it.

  ```ts
  const fridge = createFridge({ queries, driver, store })
  await fridge.read('weekly-summary')
  ```

  Upstream calls used to leave by three different doors: a scheduled tick, a read miss, and a stale read's background refresh. Each door carried its own subset of the rules - the read miss skipped per-source budgets entirely - so every guarantee had to be re-implemented, and re-proved, once per door. They now converge on a single dispatcher: claim the lease, run under the deadline, write back under a version check, reschedule or back off. A scheduled refresh and a read miss are the same work arriving through different doors, distinguished only by which one has a reader waiting.

  `swrRefresh` is gone with the third door. `read` has exactly two behaviours: something stored returns at once - fresh, stale, or `invalid` alike - and touches nothing upstream, and nothing stored fetches, bounded by that query's own `timeout`. Refreshing what is already there is the scheduler's job, so reading a stale result can no longer add load to an upstream that is already struggling. `read(name, params?)` is the whole signature on both the fridge and the reader; `PollerReadOptions` is gone.

  The engine is a fridge, not a poller - it has served reads as well as ticks for a while now. `createPoller` is `createFridge` (`PollerConfig` -> `FridgeConfig`, `Poller` -> `Fridge`), `PollerDO` is `FridgeDO`, and `cronPoller` is `cronFridge` (`CronPollerConfig` -> `CronFridgeConfig`). There are no aliases for the old names. The class you export from your Worker is still yours to name, so `wrangler.toml` needs no change; `ensureStarted`'s default instance name is now `datafridge`, so pass the old `'datafridge-poller'` explicitly to keep an already-running Durable Object.

## 1.0.0

### Major Changes

- cf8950d: Release the complete Wave 1 surface plus the accepted finite parameterized-query slice: the proactive refresh core, per-variant scheduling and identity, D1 stores, Durable Object alarm and Cron Trigger scheduling, packaged migrations, and the Cloudflare init CLI.

### Patch Changes

- Updated dependencies [cf8950d]
  - @datafridge/core@1.0.0
