import { describe, expect, it } from 'vitest'

import { ConfigError, createReader } from '../src/index.js'
import { makeHarness, resultsOnly } from './helpers.js'

describe('read() contract', () => {
  it('returns null before the first successful fetch', async () => {
    const { poller } = makeHarness([{ name: 'q', every: '5m', fetch: async () => 'v1' }])
    expect(await poller.read('q')).toBeNull()
  })

  it('throws at once for a query name that is not registered', async () => {
    const { poller } = makeHarness([{ name: 'q', every: '5m', fetch: async () => 'v1' }])
    await expect(poller.read('typo')).rejects.toThrow(ConfigError)
  })

  it('reports fresh data with age, then flips to stale once freshUntil passes', async () => {
    const { clock, poller } = makeHarness([{ name: 'q', every: '5m', fetch: async () => 'v1' }])
    await poller.runDue()

    expect(await poller.read<string>('q')).toEqual({
      data: 'v1',
      fetchedAt: 0,
      isStale: false,
      age: 0,
    })

    await clock.advance(100_000)
    expect(await poller.read<string>('q')).toMatchObject({ isStale: false, age: 100_000 })

    await clock.advance(200_000)
    expect(await poller.read<string>('q')).toMatchObject({ isStale: true, age: 300_000 })
  })

  it('createReader reads the result plane without a registry', async () => {
    const { clock, store, poller } = makeHarness([
      { name: 'q', every: '5m', fetch: async () => ({ nested: [1, 2, 3] }) },
    ])
    await poller.runDue()

    const reader = createReader({ results: resultsOnly(store), clock })
    expect(await reader.read('q')).toEqual({
      data: { nested: [1, 2, 3] },
      fetchedAt: 0,
      isStale: false,
      age: 0,
    })
    expect(await reader.read('unknown')).toBeNull()
  })

  it('exposes lastError from the envelope', async () => {
    let fail = false
    const { clock, poller } = makeHarness([
      {
        name: 'q',
        every: '5m',
        fetch: async () => {
          if (fail) throw new Error('upstream 500')
          return 'v1'
        },
      },
    ])
    await poller.runDue()
    fail = true
    await clock.advance(300_000)
    await poller.runDue()

    expect((await poller.read('q'))?.lastError).toEqual({
      at: 300_000,
      message: 'upstream 500',
      count: 1,
    })
  })
})

describe('read() SWR fallback mode', () => {
  it('serves the stale result immediately and defers one background refresh', async () => {
    let calls = 0
    const { clock, poller } = makeHarness([
      { name: 'q', every: '5m', fetch: async () => `v${++calls}` },
    ])
    await poller.runDue()
    await clock.advance(300_000)

    const deferredRefreshes: Promise<void>[] = []
    const stale = await poller.read<string>('q', {
      swrRefresh: (p) => deferredRefreshes.push(p),
    })
    expect(stale).toMatchObject({ data: 'v1', isStale: true })
    expect(deferredRefreshes).toHaveLength(1)

    await Promise.all(deferredRefreshes)
    expect(await poller.read<string>('q')).toMatchObject({ data: 'v2', isStale: false })
    expect(calls).toBe(2)
  })

  it('does not trigger a refresh while the result is fresh', async () => {
    let calls = 0
    const { poller } = makeHarness([{ name: 'q', every: '5m', fetch: async () => `v${++calls}` }])
    await poller.runDue()

    const deferredRefreshes: Promise<void>[] = []
    await poller.read('q', { swrRefresh: (p) => deferredRefreshes.push(p) })
    expect(deferredRefreshes).toHaveLength(0)
    expect(calls).toBe(1)
  })

  it('triggers a refresh when no result exists yet', async () => {
    let calls = 0
    const { poller } = makeHarness([{ name: 'q', every: '5m', fetch: async () => `v${++calls}` }])

    const deferredRefreshes: Promise<void>[] = []
    expect(await poller.read('q', { swrRefresh: (p) => deferredRefreshes.push(p) })).toBeNull()
    expect(deferredRefreshes).toHaveLength(1)

    await Promise.all(deferredRefreshes)
    expect(await poller.read('q')).toMatchObject({ data: 'v1' })
  })
})
