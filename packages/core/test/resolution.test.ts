import { describe, expect, it } from 'vitest'

import { ConfigError, createPoller, defineQueries, FakeClock, memoryStore } from '../src/index.js'
import type { Store } from '../src/index.js'
import { makeDriver, resultsOnly, scheduleOnly } from './helpers.js'

const queries = defineQueries([{ name: 'q', every: '5m', fetch: async () => 'v1' }])
const clock = () => new FakeClock(0)

function withoutAtomicClaim(store: Store): Store {
  return { ...store, capabilities: { ...store.capabilities, atomicClaim: false } }
}

describe('schedule plane resolution (fail at config time)', () => {
  it('rule 4 counterexample: results-only store + non-serialized driver + no schedule throws', () => {
    expect(() =>
      createPoller({
        results: resultsOnly(memoryStore()),
        driver: makeDriver({ serialized: false }),
        queries,
        clock: clock(),
      }),
    ).toThrow(/no valid schedule plane/)
  })

  it('rule 4 also applies for a serialized driver when nothing can host the schedule', () => {
    expect(() =>
      createPoller({
        results: resultsOnly(memoryStore()),
        driver: makeDriver({ serialized: true }),
        queries,
        clock: clock(),
      }),
    ).toThrow(ConfigError)
  })

  it('rule 1: an explicit schedule store wins over the full store', async () => {
    const resultsStore = memoryStore()
    const scheduleStore = memoryStore()
    const poller = createPoller({
      store: resultsStore,
      schedule: scheduleOnly(scheduleStore),
      driver: makeDriver(),
      queries,
      clock: clock(),
    })
    const report = await poller.runDue(0)
    expect(report.ran).toEqual(['q'])
    expect(await scheduleStore.readSchedule('q')).not.toBeNull()
    expect(await resultsStore.readSchedule('q')).toBeNull()
    expect(await resultsStore.readResult('q')).not.toBeNull()
  })

  it('rule 1: an explicit non-atomic schedule store requires a serialized driver', () => {
    const schedule = scheduleOnly(withoutAtomicClaim(memoryStore()))
    expect(() =>
      createPoller({
        results: resultsOnly(memoryStore()),
        schedule,
        driver: makeDriver({ serialized: false }),
        queries,
        clock: clock(),
      }),
    ).toThrow(/lacks atomicClaim/)
    expect(() =>
      createPoller({
        results: resultsOnly(memoryStore()),
        schedule,
        driver: makeDriver({ serialized: true }),
        queries,
        clock: clock(),
      }),
    ).not.toThrow()
  })

  it("rule 2: a stateful driver's own schedule store hosts the bookkeeping", async () => {
    const resultsStore = memoryStore()
    const driverStore = memoryStore()
    const poller = createPoller({
      results: resultsOnly(resultsStore),
      driver: makeDriver({ serialized: true, schedule: scheduleOnly(driverStore) }),
      queries,
      clock: clock(),
    })
    const report = await poller.runDue(0)
    expect(report.ran).toEqual(['q'])
    expect(await driverStore.readSchedule('q')).toMatchObject({ version: 1 })
    expect(await resultsStore.readResult('q')).toMatchObject({ data: 'v1' })
  })

  it('rule 3: a full store with atomicClaim hosts both planes, even non-serialized', async () => {
    const store = memoryStore()
    const poller = createPoller({
      store,
      driver: makeDriver({ serialized: false }),
      queries,
      clock: clock(),
    })
    const report = await poller.runDue(0)
    expect(report.ran).toEqual(['q'])
    expect(await store.readSchedule('q')).not.toBeNull()
  })

  it('serialized waiver: a full store without atomicClaim is allowed only under a serialized driver', async () => {
    const okPoller = createPoller({
      store: withoutAtomicClaim(memoryStore()),
      driver: makeDriver({ serialized: true }),
      queries,
      clock: clock(),
    })
    expect((await okPoller.runDue(0)).ran).toEqual(['q'])

    expect(() =>
      createPoller({
        store: withoutAtomicClaim(memoryStore()),
        driver: makeDriver({ serialized: false }),
        queries,
        clock: clock(),
      }),
    ).toThrow(ConfigError)
  })
})

describe('createPoller config validation', () => {
  it('rejects passing both store and results', () => {
    expect(() =>
      createPoller({
        store: memoryStore(),
        results: resultsOnly(memoryStore()),
        driver: makeDriver(),
        queries,
        clock: clock(),
      }),
    ).toThrow(/either store or results/)
  })

  it('rejects a missing result store', () => {
    expect(() => createPoller({ driver: makeDriver(), queries, clock: clock() })).toThrow(
      /result store/,
    )
  })

  it('rejects a missing or malformed driver', () => {
    expect(() => createPoller({ store: memoryStore(), queries, clock: clock() } as never)).toThrow(
      /driver/,
    )
    expect(() =>
      createPoller({
        store: memoryStore(),
        driver: { serialized: true } as never,
        queries,
        clock: clock(),
      }),
    ).toThrow(/defer/)
  })

  it('defaults to systemClock when no clock is passed', async () => {
    const store = memoryStore()
    const poller = createPoller({ store, driver: makeDriver(), queries, random: () => 0 })
    const before = Date.now()
    expect((await poller.runDue()).ran).toEqual(['q'])
    expect(await store.readResult('q')).toMatchObject({ data: 'v1' })
    expect((await store.readSchedule('q'))!.nextRunAt).toBeGreaterThanOrEqual(before + 300_000)
  })

  it('rejects a malformed clock', () => {
    expect(() =>
      createPoller({
        store: memoryStore(),
        driver: makeDriver(),
        queries,
        clock: { now: () => 0 } as never,
      }),
    ).toThrow(/clock/)
  })

  it('rejects invalid source budgets', () => {
    for (const maxPerTick of [0, -1, 1.5, NaN]) {
      expect(() =>
        createPoller({
          store: memoryStore(),
          driver: makeDriver(),
          queries,
          clock: clock(),
          sources: { posthog: { maxPerTick } },
        }),
      ).toThrow(/maxPerTick/)
    }
  })

  it('validates raw query defs passed without defineQueries', () => {
    expect(() =>
      createPoller({
        store: memoryStore(),
        driver: makeDriver(),
        clock: clock(),
        queries: [
          { name: 'dup', every: '5m', fetch: async () => 1 },
          { name: 'dup', every: '5m', fetch: async () => 2 },
        ],
      }),
    ).toThrow(/duplicate/)
  })
})
