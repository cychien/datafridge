import { describe, expect, it } from 'vitest'

import { memoryStore } from '../src/index.js'
import type { QueryDef, Store } from '../src/index.js'
import { deferred, makeHarness } from './helpers.js'

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
    expect(await store.acquirePermit('posthog', 1, 'probe', 90_000, 0)).toBe(false)
    const blocked = await two.fridge.runDue()
    watch()
    expect(blocked.deferred).toEqual(['a'])
    expect(blocked.ran).toEqual([])
    expect(live.count).toBe(1)

    gate.resolve('a')
    expect((await runOne).ran).toEqual(['a'])
    // The permit came back with the call that held it.
    expect(await store.acquirePermit('posthog', 1, 'probe', 90_000, 0)).toBe(true)
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
    expect(await store.acquirePermit('posthog', 1, 'probe', 90_000, 0)).toBe(true)
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
    expect(await store.acquirePermit('posthog', 1, 'peer', 900_000, 0)).toBe(true)

    const report = await fridge.runDue()

    expect(report.deferred).toEqual(['q'])
    expect(report.ran).toEqual([])
    expect(live.count).toBe(0)
    // Untouched, so it is still due and comes back more overdue.
    expect(await store.readSchedule('q')).toBeNull()
    expect(report.nextRunAt).toBe(0)
    held.resolve('never used')
  })

  it('recovers the ceiling from a holder that died without releasing', async () => {
    const store: Store = memoryStore()
    const { clock, fridge } = makeHarness(
      [{ name: 'q', every: '5m', source: 'posthog', fetch: async () => 'v' }],
      { store, sources: { posthog: { maxConcurrent: 1 } } },
    )
    expect(await store.acquirePermit('posthog', 1, 'dead', 5_000, 0)).toBe(true)

    expect((await fridge.runDue()).deferred).toEqual(['q'])

    await clock.advance(5_000)
    expect((await fridge.runDue()).ran).toEqual(['q'])
  })
})
