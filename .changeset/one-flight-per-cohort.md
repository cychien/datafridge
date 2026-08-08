---
'@datafridge/core': minor
'@datafridge/cloudflare': minor
---

Concurrency and coalescing move into the store, where every executor can see them.

Two things used to be true only inside one process, and both were the kind of true that stops being true the moment you deploy.

`maxConcurrent` was per-instance smoothing. On Workers that is one ceiling per invocation, which is not a ceiling - fifty concurrent requests were fifty times whatever you wrote down. It is now a permit taken in the store for the length of the call and given back when it ends, so the number means the same thing to a Durable Object, a cron trigger and fifty request-path readers. A holder that dies never gives its permit back, so permits expire; until then they count, and after they do not. A scheduled refresh that finds no permit does not queue for one - it stays due and arrives in `RunReport.deferred`.

Overlapping reads of params the registry does not name were separate calls. They now coalesce through a *flight*: the first reader makes the call, everyone who arrives while it is running takes its answer, and the cohort costs one upstream call and one quota slot however many Workers it spans. A reader arriving after that flight settles gets a new flight and a new call - the answer belongs to the readers who waited for it, and reusing it for whoever asks next would make the combination the cached entry it is deliberately not. Handoff is generation-scoped, so a late answer is refused rather than given to the wrong cohort; a dead leader is taken over once its deadline passes; flights expire and are swept in bounded batches by the tick.

A refusal from either ceiling says when it could stop being one. `acquirePermit` reports the soonest live permit for that source, so a permit-starved read answers `status: 'throttled'` with a real `retryAt` rather than `null` - nothing reached upstream, so nothing is missing - and a scheduled refusal re-arms the alarm at that moment instead of once a second until the peer finishes. Either way the quota the call reserved is handed straight back. Running out of invocation wall clock still asks for the next tick immediately, because that is the one refusal that names no time.

Holder ids are the caller's, and `random` is injectable, so uniqueness is never assumed: a store refuses a `holder` that already holds a live permit rather than letting it take a second or overwrite the first, and the caller mints another and takes the slot. The compatibility suite pins that, because the two obvious wrong answers - overwrite, or raise - breach the ceiling and lose the call respectively. An id whose own permit has expired is not that caller, and may take one again.

Saying *why* a permit was refused costs more than deciding it. A reader waiting out a saturated source polls until its timeout and reports only the last of those refusals, so `acquirePermit` takes an `explainRefusal` flag and may answer `retryAt: null` when the caller says it will not act on the reason. On D1 a refused poll is now one statement rather than three, on exactly the path a saturated source makes hottest. What a store may never do is invent a moment: `null` means "I did not look".

`acquirePermit`, `releasePermit`, `joinFlight`, `readFlight`, `settleFlight` and `sweepFlights` join the store contract with chapters in the compatibility suite, alongside an optional `readSchedules` for reading a bounded batch of rows by name. `d1()` grows a `datafridge_permit` and a `datafridge_flight` table and applies them itself.

Two costs the first cut left behind are gone. A tick no longer looks up a row per registry entry the page did not reach: a short page a tick actually read *is* the whole table, so those names are known to have no row without asking, and past a page the lookups go out in bounded batches. A store without `listDue` reads no page at all, and an empty one there is evidence of nothing, so it keeps reading row by row exactly as documented. And `sweepFlights` keeps a running flight until its expiry is well behind, because deleting one lets the next caller restart at generation one - the very value a late leader would still be holding, and the thing the generation guard rests on.

One quieter fix rides along, and it is the reason a large registry was previously unusable: a tick decided "there is more due work" from the *size* of the page it read rather than from whether that page ran out while still due. Past one page of schedule rows - an ordinary `dimensions` product - every tick asked to be woken again in one second, forever, with nothing to do, and any query without a row yet was never planned at all. Dueness now comes from the page's last row, and a registry name the page did not reach is read by name instead of guessed at.
