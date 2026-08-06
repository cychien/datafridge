---
'@datafridge/core': major
'@datafridge/cloudflare': major
---

One store, one interface. `Store` holds both halves of what datafridge keeps - result envelopes and schedule bookkeeping - and `d1(db)` is the single D1 store.

`createPoller`, `cronPoller`, and `PollerDO` each take one `store`. `createReader({ store })` only ever calls `readResult`, so a read-only consumer can supply just that.

A stateful serialized driver may keep the schedule half itself: `PollerDO` does, in the Durable Object's own SQLite, through the adapter-level `SchedulePlane` that applications never touch. The store's schedule half then goes unused. A store that cannot claim atomically is still refused at construction under a non-serialized driver, rather than quietly double-fetching.
