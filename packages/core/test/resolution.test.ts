import { describe, expect, it } from 'vitest'

import { ConfigError, createFridge, defineQueries, FakeClock, memoryStore } from '../src/index.js'
import type { SourcePolicy, Store } from '../src/index.js'
import { makeDriver, scheduleOnly } from './helpers.js'

const queries = defineQueries([{ name: 'q', every: '5m', fetch: async () => 'v1' }])
const clock = () => new FakeClock(0)

function withoutAtomicClaim(store: Store): Store {
  return { ...store, capabilities: { ...store.capabilities, atomicClaim: false } }
}

describe('where schedule bookkeeping lives', () => {
  it('the store holds both halves, even under a non-serialized driver', async () => {
    const store = memoryStore()
    const fridge = createFridge({
      store,
      driver: makeDriver({ serialized: false }),
      queries,
      clock: clock(),
    })
    const report = await fridge.runDue(0)
    expect(report.ran).toEqual(['q'])
    expect(await store.readSchedule('q')).not.toBeNull()
    expect(await store.readResult('q')).toMatchObject({ data: 'v1' })
  })

  it("a stateful driver's own bookkeeping wins, leaving the store's schedule half unused", async () => {
    const store = memoryStore()
    const driverPlane = memoryStore()
    const fridge = createFridge({
      store,
      driver: makeDriver({ serialized: true, schedule: scheduleOnly(driverPlane) }),
      queries,
      clock: clock(),
    })
    const report = await fridge.runDue(0)
    expect(report.ran).toEqual(['q'])
    expect(await driverPlane.readSchedule('q')).toMatchObject({ version: 1 })
    expect(await store.readSchedule('q')).toBeNull()
    expect(await store.readResult('q')).toMatchObject({ data: 'v1' })
  })

  it('a store without atomicClaim is allowed only under a serialized driver', async () => {
    const okFridge = createFridge({
      store: withoutAtomicClaim(memoryStore()),
      driver: makeDriver({ serialized: true }),
      queries,
      clock: clock(),
    })
    expect((await okFridge.runDue(0)).ran).toEqual(['q'])

    expect(() =>
      createFridge({
        store: withoutAtomicClaim(memoryStore()),
        driver: makeDriver({ serialized: false }),
        queries,
        clock: clock(),
      }),
    ).toThrow(ConfigError)
  })
})

describe('unsafe claiming fails at config time with an exact, actionable message', () => {
  function configErrorMessage(fn: () => unknown): string {
    try {
      fn()
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      return (err as ConfigError).message
    }
    return expect.unreachable('expected a ConfigError')
  }

  it('the store cannot claim safely under a non-serialized driver', () => {
    expect(
      configErrorMessage(() =>
        createFridge({
          store: withoutAtomicClaim(memoryStore()),
          driver: makeDriver({ serialized: false }),
          queries,
          clock: clock(),
        }),
      ),
    ).toBe(
      'the store lacks atomicClaim and the driver is not serialized, so concurrent runDue ' +
        'calls could double-fetch; use a store with atomic claims or a serialized driver',
    )
  })

  it("the driver's own bookkeeping cannot claim safely under a non-serialized driver", () => {
    expect(
      configErrorMessage(() =>
        createFridge({
          store: memoryStore(),
          driver: makeDriver({
            serialized: false,
            schedule: scheduleOnly(withoutAtomicClaim(memoryStore())),
          }),
          queries,
          clock: clock(),
        }),
      ),
    ).toBe(
      "the driver's schedule bookkeeping lacks atomicClaim and the driver is not serialized, " +
        'so concurrent runDue calls could double-fetch; use a store with atomic claims or a ' +
        'serialized driver',
    )
  })
})

describe('createFridge config validation', () => {
  it('rejects a missing store', () => {
    expect(() => createFridge({ driver: makeDriver(), queries, clock: clock() } as never)).toThrow(
      /requires a store/,
    )
  })

  it('rejects a store that is missing either half', () => {
    const { readResult, writeResult, deleteResult } = memoryStore()
    expect(() =>
      createFridge({
        store: { readResult, writeResult, deleteResult } as never,
        driver: makeDriver(),
        queries,
        clock: clock(),
      }),
    ).toThrow(/results and schedule rows/)
  })

  it('rejects a missing or malformed driver', () => {
    expect(() => createFridge({ store: memoryStore(), queries, clock: clock() } as never)).toThrow(
      /driver/,
    )
    expect(() =>
      createFridge({
        store: memoryStore(),
        driver: { serialized: true } as never,
        queries,
        clock: clock(),
      }),
    ).toThrow(/defer/)
  })

  it('defaults to systemClock when no clock is passed', async () => {
    const store = memoryStore()
    const fridge = createFridge({ store, driver: makeDriver(), queries, random: () => 0 })
    const before = Date.now()
    expect((await fridge.runDue()).ran).toEqual(['q'])
    expect(await store.readResult('q')).toMatchObject({ data: 'v1' })
    expect((await store.readSchedule('q'))!.nextRunAt).toBeGreaterThanOrEqual(before + 300_000)
  })

  it('rejects a malformed clock', () => {
    expect(() =>
      createFridge({
        store: memoryStore(),
        driver: makeDriver(),
        queries,
        clock: { now: () => 0 } as never,
      }),
    ).toThrow(/clock/)
  })

  it('rejects invalid source policies', () => {
    const build = (policy: SourcePolicy) =>
      createFridge({
        store: memoryStore(),
        driver: makeDriver(),
        queries,
        clock: clock(),
        sources: { posthog: policy },
      })

    for (const requests of [0, -1, 1.5, NaN]) {
      expect(() => build({ limit: { requests, per: '1m' } })).toThrow(/limit\.requests/)
    }
    for (const maxConcurrent of [0, -1, 1.5, NaN]) {
      expect(() => build({ maxConcurrent })).toThrow(/maxConcurrent/)
    }
    expect(() => build({ limit: { requests: 10, per: '0s' } })).toThrow(/limit\.per/)
    expect(() => build({ limit: { requests: 10, per: '1m', reserve: -1 } })).toThrow(
      /limit\.reserve/,
    )
    // A reserve that swallows the whole window would freeze scheduled refreshes
    // out forever, which is a configuration mistake, not a policy.
    expect(() => build({ limit: { requests: 10, per: '1m', reserve: 10 } })).toThrow(
      /must be smaller than/,
    )
    expect(() => build({})).toThrow(/limits nothing/)
  })

  it('validates raw query defs passed without defineQueries', () => {
    expect(() =>
      createFridge({
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
