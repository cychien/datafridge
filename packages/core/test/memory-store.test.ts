import { describe, expect, it } from 'vitest'

import { memoryStore } from '../src/index.js'

describe('memoryStore claim semantics', () => {
  it('creates and claims a missing row when expectedVersion is 0', async () => {
    const store = memoryStore()
    expect(await store.claim('q', 0, 500, 100)).toBe(true)
    expect(await store.readSchedule('q')).toEqual({
      name: 'q',
      nextRunAt: 100,
      failCount: 0,
      leaseUntil: 500,
      version: 1,
    })
  })

  it('rejects a claim for a missing row with a nonzero expectedVersion', async () => {
    const store = memoryStore()
    expect(await store.claim('q', 3, 500, 100)).toBe(false)
    expect(await store.readSchedule('q')).toBeNull()
  })

  it('rejects a claim while the lease is active, allows it after expiry', async () => {
    const store = memoryStore()
    await store.claim('q', 0, 500, 100)
    expect(await store.claim('q', 1, 900, 499)).toBe(false)
    expect(await store.claim('q', 1, 900, 500)).toBe(true)
    expect((await store.readSchedule('q'))!.version).toBe(2)
  })

  it('rejects a claim with a stale version', async () => {
    const store = memoryStore()
    await store.claim('q', 0, 500, 100)
    expect(await store.claim('q', 0, 900, 600)).toBe(false)
  })

  it('only one of many concurrent claims wins', async () => {
    const store = memoryStore()
    await store.writeSchedule({
      name: 'q',
      nextRunAt: 0,
      failCount: 0,
      leaseUntil: null,
      version: 7,
    })
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => store.claim('q', 7, 1_000, 100)),
    )
    expect(outcomes.filter(Boolean)).toHaveLength(1)
  })
})
