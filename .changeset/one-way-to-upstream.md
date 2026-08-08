---
'@datafridge/core': minor
'@datafridge/cloudflare': minor
---

One exit to upstream, and a read that never opens it.

```ts
const fridge = createFridge({ queries, driver, store })
await fridge.read('weekly-summary')
```

Upstream calls used to leave by three different doors: a scheduled tick, a read miss, and a stale read's background refresh. Each door carried its own subset of the rules - the read miss skipped per-source budgets entirely - so every guarantee had to be re-implemented, and re-proved, once per door. They now converge on a single dispatcher: claim the lease, run under the deadline, write back under a version check, reschedule or back off. A scheduled refresh and a read miss are the same work arriving through different doors, distinguished only by which one has a reader waiting.

`swrRefresh` is gone with the third door. `read` has exactly two behaviours: something stored returns at once - fresh, stale, or `invalid` alike - and touches nothing upstream, and nothing stored fetches, bounded by that query's own `timeout`. Refreshing what is already there is the scheduler's job, so reading a stale result can no longer add load to an upstream that is already struggling. `read(name, params?)` is the whole signature on both the fridge and the reader; `PollerReadOptions` is gone.

The engine is a fridge, not a poller - it has served reads as well as ticks for a while now. `createPoller` is `createFridge` (`PollerConfig` -> `FridgeConfig`, `Poller` -> `Fridge`), `PollerDO` is `FridgeDO`, and `cronPoller` is `cronFridge` (`CronPollerConfig` -> `CronFridgeConfig`). There are no aliases for the old names. The class you export from your Worker is still yours to name, so `wrangler.toml` needs no change; `ensureStarted`'s default instance name is now `datafridge`, so pass the old `'datafridge-poller'` explicitly to keep an already-running Durable Object.
