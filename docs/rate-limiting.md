# Rate limiting

datafridge groups queries by `source` (the `source` field on a query definition, defaulting to `'default'`) and limits how hard each source gets hit. Wave 1 ships the simple, stateless version; a precise accounting version is on the roadmap for the narrow cases that actually need it.

## v1: per-tick budget + jitter

```ts
createPoller({
  store: d1Store(env.DB),
  queries,
  sources: { posthog: { maxPerTick: 2 } },
})
```

Each `runDue` tick groups due queries by source and runs at most `maxPerTick` per group. Queries squeezed out by the budget stay due and are picked up on the next tick - and because priority is the overdue *ratio* `(now - nextRunAt) / every`, a squeezed-out query rises in priority every tick it waits, so nothing starves.

Two properties make this the right v1:

- **Stateless.** The budget needs no counters and no shared state, so it is trivially safe across distributed, concurrent executors (multi-instance cron included).
- **A hard ceiling.** The upstream rate can never exceed `maxPerTick × tick frequency`, regardless of how many queries you register.

Jitter is the other half. On first registration, each query's `nextRunAt` gets a random offset, so queries with integer-multiple periods (`5m`, `10m`, `1h`) never permanently align on the same tick and collectively slam one source's budget. The budget is the fuse; jitter keeps the fuse from blowing in normal operation.

## v2 (roadmap): precise window accounting

Not implemented. The plan: a per-source window counter stored in the schedule plane and updated via CAS, giving exact "N calls per window" accounting shared across every executor.

You need it only when **all three** of these hold:

1. Multiple programs share one vendor hard quota,
2. the quota cannot be split into separate API keys, and
3. you actually run close to the quota.

If any of the three fails, the v1 budget already gives you a safe ceiling - and if you can split API keys, do that first. It is simpler than distributed accounting will ever be.
