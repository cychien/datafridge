import { describe, expect, it } from 'vitest'

import { FakeClock, memoryStore } from '../src/index.js'
import type { QueryDef, Store } from '../src/index.js'
import { deferred, makeHarness } from './helpers.js'

/**
 * A store whose coordination calls take time off the same fake clock the
 * dispatcher runs on, so "the deadline passed mid-round-trip" is arithmetic
 * rather than a race. Counts the acquires, because the point of admission
 * backing off early is the one it does not make.
 */
function withLatency(
  store: Store,
  clock: FakeClock,
  latencyMs: number,
  acquires: { count: number },
): Store {
  const trip = (): Promise<void> =>
    new Promise((resolve) => clock.setTimeout(() => resolve(), latencyMs))
  return {
    ...store,
    async takeQuota(source, limit, windowMs, now) {
      await trip()
      return store.takeQuota(source, limit, windowMs, now)
    },
    async releaseQuota(source, windowMs, takenAt) {
      await trip()
      return store.releaseQuota(source, windowMs, takenAt)
    },
    async acquirePermit(source, limit, holder, expiresAt, now, explainRefusal) {
      acquires.count += 1
      await trip()
      return store.acquirePermit(source, limit, holder, expiresAt, now, explainRefusal)
    },
  }
}

const gated = (name: string, promise: Promise<string>, live: { count: number }): QueryDef => ({
  name,
  every: '5m',
  source: 'posthog',
  timeout: '5m',
  lease: '10m',
  fetch: async () => {
    live.count += 1
    try {
      return await promise
    } finally {
      live.count -= 1
    }
  },
})

describe('maxConcurrent across executors', () => {
  it('bounds two instances together, not one apiece', async () => {
    const gate = deferred<string>()
    const live = { count: 0 }
    let peak = 0
    const watch = () => {
      peak = Math.max(peak, live.count)
    }
    const store: Store = memoryStore()
    const sources = { posthog: { maxConcurrent: 1 } }
    const registry = () => [gated('a', gate.promise, live)]

    const one = makeHarness(registry(), { store, sources })
    const two = makeHarness(registry(), { store, sources, clock: one.clock })

    const runOne = one.fridge.runDue()
    await one.clock.advance(0)
    watch()
    expect(live.count).toBe(1)

    // The ceiling lives in the store, so anyone who asks sees it taken - and a
    // whole second instance is turned away by it, not by its own memory.
    expect(await store.acquirePermit('posthog', 1, 'probe', 90_000, 0)).toMatchObject({
      granted: false,
    })
    const blocked = await two.fridge.runDue()
    watch()
    expect(blocked.deferred).toEqual(['a'])
    expect(blocked.ran).toEqual([])
    expect(live.count).toBe(1)

    gate.resolve('a')
    expect((await runOne).ran).toEqual(['a'])
    // The permit came back with the call that held it.
    expect(await store.acquirePermit('posthog', 1, 'probe', 90_000, 0)).toEqual({ granted: true })
    expect(peak).toBe(1)
  })

  it('gives a permit back the moment the call it was taken for is done', async () => {
    const store: Store = memoryStore()
    const { fridge } = makeHarness(
      [{ name: 'q', every: '5m', source: 'posthog', fetch: async () => 'v' }],
      {
        store,
        sources: { posthog: { maxConcurrent: 1 } },
      },
    )

    expect((await fridge.runDue()).ran).toEqual(['q'])
    // Nothing is in flight, so the whole ceiling is available again.
    expect(await store.acquirePermit('posthog', 1, 'probe', 90_000, 0)).toEqual({ granted: true })
  })

  it('lets a scheduled tick defer rather than queue behind a peer that has the permit', async () => {
    const store: Store = memoryStore()
    const held = deferred<string>()
    const live = { count: 0 }
    const { fridge } = makeHarness([gated('q', held.promise, live)], {
      store,
      sources: { posthog: { maxConcurrent: 1 } },
    })
    // A peer holds the only permit and is still alive.
    expect(await store.acquirePermit('posthog', 1, 'peer', 900_000, 0)).toEqual({ granted: true })

    const report = await fridge.runDue()

    expect(report.deferred).toEqual(['q'])
    expect(report.ran).toEqual([])
    expect(live.count).toBe(0)
    // Untouched, so it is still due and comes back more overdue.
    expect(await store.readSchedule('q')).toBeNull()
    // Nothing changes until that peer's permit frees, so the tick asks to be
    // woken then - not in a second, and not three hundred times over.
    expect(report.nextRunAt).toBe(900_000)
    held.resolve('never used')
  })

  it('asks to be woken when the permit frees, not on a loop', async () => {
    const store: Store = memoryStore()
    const held = deferred<string>()
    const live = { count: 0 }
    const { clock, fridge } = makeHarness([gated('q', held.promise, live)], {
      store,
      sources: { posthog: { maxConcurrent: 1 } },
    })
    await store.acquirePermit('posthog', 1, 'peer', 60_000, 0)

    const first = await fridge.runDue()
    expect(first.nextRunAt).toBe(60_000)

    // Still held a moment later: the answer is still that expiry, never `now`.
    await clock.advance(1_000)
    const second = await fridge.runDue()
    expect(second.deferred).toEqual(['q'])
    expect(second.nextRunAt).toBe(60_000)
    held.resolve('never used')
  })

  it('tells a waiting reader it is not their turn rather than that there is nothing', async () => {
    const store: Store = memoryStore()
    const held = deferred<string>()
    const live = { count: 0 }
    const { clock, fridge } = makeHarness([gated('cold', held.promise, live)], {
      store,
      sources: { posthog: { maxConcurrent: 1 } },
    })
    // A peer holds the only permit for longer than this reader may wait.
    await store.acquirePermit('posthog', 1, 'peer', 900_000, 0)

    const read = fridge.read('cold')
    // Let the read reach its wait before the clock moves under it.
    await clock.advance(0)
    // The reader waits for a permit inside its own timeout, then gives up.
    await clock.advance(300_000)

    expect(await read).toEqual({ status: 'throttled', retryAt: 900_000 })
    expect(live.count).toBe(0)
    held.resolve('never used')
  })

  it('refunds the quota a permit-starved call reserved', async () => {
    const store: Store = memoryStore()
    const held = deferred<string>()
    const live = { count: 0 }
    const { fridge } = makeHarness([gated('q', held.promise, live)], {
      store,
      sources: { posthog: { limit: { requests: 1, per: '1m' }, maxConcurrent: 1 } },
    })
    await store.acquirePermit('posthog', 1, 'peer', 900_000, 0)

    expect((await fridge.runDue()).deferred).toEqual(['q'])

    // No upstream call happened, so the window is untouched.
    expect(await store.takeQuota('posthog', 1, 60_000, 0)).toBe(true)
    held.resolve('never used')
  })

  it('takes the permit a colliding holder id could not, rather than giving up', async () => {
    const store: Store = memoryStore()
    const live = { count: 0 }
    const gate = deferred<string>()
    const sources = { posthog: { maxConcurrent: 2 } }
    // `random` is pinned in these harnesses, so both dispatchers mint the same
    // holder ids in the same order: the ceiling must hold anyway, and neither
    // call may be lost to the collision.
    const one = makeHarness([gated('a', gate.promise, live)], { store, sources })
    const two = makeHarness([gated('b', gate.promise, live)], {
      store,
      sources,
      clock: one.clock,
    })

    const runOne = one.fridge.runDue()
    const runTwo = two.fridge.runDue()
    await one.clock.advance(0)
    expect(live.count).toBe(2)

    gate.resolve('v')
    expect((await runOne).ran).toEqual(['a'])
    expect((await runTwo).ran).toEqual(['b'])
    // Two distinct permits were taken and both came back.
    expect(await store.acquirePermit('posthog', 1, 'probe', 90_000, 0)).toEqual({ granted: true })
  })

  it('recovers the ceiling from a holder that died without releasing', async () => {
    const store: Store = memoryStore()
    const { clock, fridge } = makeHarness(
      [{ name: 'q', every: '5m', source: 'posthog', fetch: async () => 'v' }],
      { store, sources: { posthog: { maxConcurrent: 1 } } },
    )
    expect(await store.acquirePermit('posthog', 1, 'dead', 5_000, 0)).toEqual({ granted: true })

    expect((await fridge.runDue()).deferred).toEqual(['q'])

    await clock.advance(5_000)
    expect((await fridge.runDue()).ran).toEqual(['q'])
  })
})

/**
 * An answer that lands after the reader has stopped listening is `null`, which
 * is "there is nothing" - the one thing work that never reached upstream must
 * never say. Admission therefore stops asking once the budget left cannot carry
 * the asking and the refund that follows it.
 */
describe('a permit-starved read whose budget runs out mid-admission', () => {
  it('answers from the refusal it has rather than making one last doomed ask', async () => {
    const clock = new FakeClock(0)
    const base: Store = memoryStore()
    const acquires = { count: 0 }
    const live = { count: 0 }
    const held = deferred<string>()
    const { fridge } = makeHarness([{ ...gated('cold', held.promise, live), timeout: 200 }], {
      store: withLatency(base, clock, 60, acquires),
      clock,
      sources: { posthog: { maxConcurrent: 1 } },
    })
    await base.acquirePermit('posthog', 1, 'peer', 900_000, 0)

    const read = fridge.read('cold')
    await clock.advance(0)
    await clock.advance(500)

    // Two polls fit; the third would have answered at +255 against a deadline
    // of 200, so it is not made and the peer's expiry is still the answer.
    expect(await read).toEqual({ status: 'throttled', retryAt: 900_000 })
    expect(acquires.count).toBe(2)
    expect(live.count).toBe(0)
    held.resolve('never used')
  })

  it('answers a reader whose wait for the window left no room to ask at all', async () => {
    const clock = new FakeClock(0)
    const base: Store = memoryStore()
    const acquires = { count: 0 }
    const live = { count: 0 }
    const held = deferred<string>()
    const { fridge } = makeHarness([{ ...gated('cold', held.promise, live), timeout: 60_250 }], {
      store: withLatency(base, clock, 100, acquires),
      clock,
      sources: { posthog: { limit: { requests: 1, per: '1m' }, maxConcurrent: 1 } },
    })
    // The window is spent, so the reader waits it out - and arrives at the
    // permit with less budget left than asking for one would cost.
    expect(await base.takeQuota('posthog', 1, 60_000, 0)).toBe(true)
    await base.acquirePermit('posthog', 1, 'peer', 900_000, 0)

    const read = fridge.read('cold')
    await clock.advance(0)
    await clock.advance(61_000)

    expect(await read).toEqual({ status: 'throttled', retryAt: 60_100 })
    expect(acquires.count).toBe(0)
    expect(live.count).toBe(0)
    // The slot the wait won was never spent, so the new window is whole.
    expect(await base.takeQuota('posthog', 1, 60_000, 60_000)).toBe(true)
    held.resolve('never used')
  })
})
