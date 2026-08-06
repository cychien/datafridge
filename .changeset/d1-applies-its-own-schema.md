---
'@datafridge/cloudflare': minor
---

`d1()` applies its own tables, so there is no migration to run before the first deploy.

Forgetting the migration used to fail quietly: the first tick threw `no such table`, the alarm loop absorbed it to keep the chain alive, and every read returned `null` with nothing to explain why. Now the schema is applied once per binding before the first write, and a table that disappears under a warm isolate is re-created and retried once rather than failing until that isolate recycles.

The read path stays a single `SELECT` and never applies schema. A result table that does not exist yet reads as `null`, which is the same answer an empty one gives - any other error still propagates.

The packaged migration is still there for teams that would rather declare the schema in their own pipeline; applying it makes the automatic step a no-op, and a test keeps the two from drifting.

`cronPoller` also accepts `onRunReport` now, under the same contract as the `PollerDO` hook: sanitize before logging, and a throwing hook cannot fail the tick. Getting at the report no longer means dropping down to `cronDriver` plus `createPoller`.
