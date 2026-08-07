---
'@datafridge/cloudflare': major
---

D1 is the coordination plane; the Durable Object is only a scheduler.

`FridgeDO` used to keep schedule rows, leases and the quota ledger in its own SQLite. It no longer keeps any of it: rows, leases, versions, backoff, quota and results all live in the Store you give it, and the object's own storage holds one row recording which registry it last ignited for. It is a thing that wakes up on time, and nothing else.

This is what makes the rest composable. A cron trigger and a Durable Object over the same D1 now coordinate through D1 rather than through whichever object happens to be the singleton, and a request path can read - and fetch - against that same data without an RPC to it. A scheduler that owns the coordination plane is a scheduler you cannot put a second reader beside.

The alarm follows from the tick instead of re-deriving it: `runDue` returns `nextRunAt`, computed from rows it already held, so re-arming costs no storage read at all - where it previously scanned the whole schedule table on every alarm. `cronDriver` and `FridgeDO` both declare the platform's 15-minute wall clock as the tick's `budgetMs`.

Because the coordination plane is the store, a request path is complete without the object: `createReader` over the same `d1(env.DB)` serves what is stored, fills a cold entry through the same dispatcher, and shares the same quota ledger, the same concurrency permits and the same in-flight coalescing as the scheduler.
