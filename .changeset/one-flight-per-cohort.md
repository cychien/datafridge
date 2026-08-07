---
'@datafridge/core': major
'@datafridge/cloudflare': major
---

Concurrency and coalescing move into the store, where every executor can see them.

Two things used to be true only inside one process, and both were the kind of true that stops being true the moment you deploy.

`maxConcurrent` was per-instance smoothing. On Workers that is one ceiling per invocation, which is not a ceiling - fifty concurrent requests were fifty times whatever you wrote down. It is now a permit taken in the store for the length of the call and given back when it ends, so the number means the same thing to a Durable Object, a cron trigger and fifty request-path readers. A holder that dies never gives its permit back, so permits expire; until then they count, and after they do not. A scheduled refresh that finds no permit does not queue for one - it stays due and arrives in `RunReport.deferred`.

Overlapping reads of params the registry does not name were separate calls. They now coalesce through a *flight*: the first reader makes the call, everyone who arrives while it is running takes its answer, and the cohort costs one upstream call and one quota slot however many Workers it spans. A reader arriving after that flight settles gets a new flight and a new call - the answer belongs to the readers who waited for it, and reusing it for whoever asks next would make the combination the cached entry it is deliberately not. Handoff is generation-scoped, so a late answer is refused rather than given to the wrong cohort; a dead leader is taken over once its deadline passes; flights expire and are swept in bounded batches by the tick.

`acquirePermit`, `releasePermit`, `joinFlight`, `readFlight`, `settleFlight` and `sweepFlights` join the store contract with chapters in the compatibility suite. `d1()` grows a `datafridge_permit` and a `datafridge_flight` table and applies them itself.

One quieter fix rides along, and it is the reason a large registry was previously unusable: a tick decided "there is more due work" from the *size* of the page it read rather than from whether that page ran out while still due. Past one page of schedule rows - an ordinary `dimensions` product - every tick asked to be woken again in one second, forever, with nothing to do, and any query without a row yet was never planned at all. Dueness now comes from the page's last row, and a registry name the page did not reach is read by name instead of guessed at.
