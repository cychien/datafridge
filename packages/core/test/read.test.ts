import { describe, expect, it } from 'vitest'

import { ConfigError, createReader } from '../src/index.js'
import { makeHarness, resultsOnly, stored } from './helpers.js'

describe('read() contract', () => {
  it('serves the first read itself rather than answering null', async () => {
    const { fridge } = makeHarness([{ name: 'q', every: '5m', fetch: async () => 'v1' }])
    expect(await fridge.read<string>('q')).toMatchObject({ data: 'v1', isStale: false })
  })

  it('throws at once for a query name that is not registered', async () => {
    const { fridge } = makeHarness([{ name: 'q', every: '5m', fetch: async () => 'v1' }])
    await expect(fridge.read('typo')).rejects.toThrow(ConfigError)
  })

  it('reports fresh data with age, then flips to stale once freshUntil passes', async () => {
    const { clock, fridge } = makeHarness([{ name: 'q', every: '5m', fetch: async () => 'v1' }])
    await fridge.runDue()

    expect(await fridge.read<string>('q')).toEqual({
      data: 'v1',
      fetchedAt: 0,
      isStale: false,
      age: 0,
      status: 'ok',
    })

    await clock.advance(100_000)
    expect(await fridge.read<string>('q')).toMatchObject({ isStale: false, age: 100_000 })

    await clock.advance(200_000)
    expect(await fridge.read<string>('q')).toMatchObject({ isStale: true, age: 300_000 })
  })

  it('createReader reads the result plane without a registry', async () => {
    const { clock, store, fridge } = makeHarness([
      { name: 'q', every: '5m', fetch: async () => ({ nested: [1, 2, 3] }) },
    ])
    await fridge.runDue()

    const reader = createReader({ store: resultsOnly(store), clock })
    expect(await reader.read('q')).toEqual({
      data: { nested: [1, 2, 3] },
      fetchedAt: 0,
      isStale: false,
      status: 'ok',
      age: 0,
    })
    expect(await reader.read('unknown')).toBeNull()
  })

  it('createReader defaults to systemClock when no clock is passed', async () => {
    const { store, fridge } = makeHarness([{ name: 'q', every: '5m', fetch: async () => 'v1' }])
    await fridge.runDue()

    const reader = createReader({ store: resultsOnly(store) })
    const result = stored(await reader.read<string>('q'))
    expect(result).toMatchObject({ data: 'v1', fetchedAt: 0 })
    expect(result!.age).toBeGreaterThan(0)
  })

  it('exposes lastError from the envelope', async () => {
    let fail = false
    const { clock, fridge } = makeHarness([
      {
        name: 'q',
        every: '5m',
        fetch: async () => {
          if (fail) throw new Error('upstream 500')
          return 'v1'
        },
      },
    ])
    await fridge.runDue()
    fail = true
    await clock.advance(300_000)
    await fridge.runDue()

    expect(stored(await fridge.read('q'))?.lastError).toEqual({
      at: 300_000,
      message: 'upstream 500',
      count: 1,
    })
  })
})

describe('read() on a stored result is a local read', () => {
  it('serves a stale result without touching upstream, however overdue it is', async () => {
    let calls = 0
    const { clock, fridge } = makeHarness([
      { name: 'q', every: '5m', fetch: async () => `v${++calls}` },
    ])
    await fridge.runDue()
    await clock.advance(3_600_000)

    expect(await fridge.read<string>('q')).toMatchObject({ data: 'v1', isStale: true })
    expect(await fridge.read<string>('q')).toMatchObject({ data: 'v1', isStale: true })
    expect(calls).toBe(1)
  })

  it('leaves the schedule row untouched, so reads cannot outpace the poll period', async () => {
    const { clock, fridge, store } = makeHarness([
      { name: 'q', every: '5m', fetch: async () => 'v1' },
    ])
    await fridge.runDue()
    const scheduled = await store.readSchedule('q')

    await clock.advance(3_600_000)
    await fridge.read('q')

    expect(await store.readSchedule('q')).toEqual(scheduled)
  })
})
