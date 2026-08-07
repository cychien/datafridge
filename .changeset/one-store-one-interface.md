---
'@datafridge/core': major
'@datafridge/cloudflare': major
---

One store, one interface. `Store` holds both halves of what datafridge keeps - result envelopes and schedule bookkeeping - and `d1(db)` is the single D1 store.

`createFridge`, `cronFridge`, and `FridgeDO` each take one `store`. `createReader({ store })` needs nothing but `readResult` to answer, so a read-only consumer can supply just that; a store that also offers `readSchedule` lets a miss tell a fetch that is about to land from a retry already scheduled for later.

A stateful serialized driver may keep the schedule half itself, through the adapter-level `SchedulePlane` that applications never touch; the store's schedule half then goes unused. `FridgeDO` does not: it takes the store's, so the object is a scheduler rather than a coordination plane. A store that cannot claim atomically is still refused at construction under a non-serialized driver, rather than quietly double-fetching.
