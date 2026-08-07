import { describe, expect, it } from 'vitest'

import { ConfigError, memoryStore } from '../src/index.js'
import type { QueryDef, Store } from '../src/index.js'
import { makeHarness } from './helpers.js'

const counted = (name: string, calls: string[]): QueryDef => ({
  name,
  every: '5m',
  fetch: async () => {
    calls.push(name)
    return name
  },
})

function countingListDue(store: Store, limits: number[]): Store {
  return {
    ...store,
    listDue: (now, limit) => {
      limits.push(limit)
      return store.listDue!(now, limit)
    },
  }
}

describe('what one tick will take on', () => {
  it('runs the most overdue up to maxPerTick and reports the rest as deferred', async () => {
    const calls: string[] = []
    const { clock, fridge } = makeHarness(
      [counted('a', calls), counted('b', calls), counted('c', calls)],
      { maxPerTick: 2 },
    )

    const first = await fridge.runDue()
    expect(first.ran).toHaveLength(2)
    expect(first.deferred).toHaveLength(1)
    expect([...first.ran, ...first.deferred].toSorted()).toEqual(['a', 'b', 'c'])

    // Deferred work is untouched, so it is still due - and now the most overdue
    // thing there is, which is what stops a capacity bound from starving it.
    const deferredName = first.deferred[0]!
    await clock.advance(1)
    const second = await fridge.runDue()
    expect(second.ran).toEqual([deferredName])
    expect(second.deferred).toEqual([])
    expect(calls.toSorted()).toEqual(['a', 'b', 'c'])
  })

  it('bounds the rows one tick reads, not just the calls it makes', async () => {
    const limits: number[] = []
    const { store, fridge } = makeHarness([counted('a', [])], {
      store: countingListDue(memoryStore(), limits),
      maxPerTick: 7,
    })
    await fridge.runDue()

    expect(limits).toEqual([7])
    expect(await store.readSchedule('a')).not.toBeNull()
  })

  it('rejects a capacity that is not a positive whole number, at construction', () => {
    for (const maxPerTick of [0, -1, 1.5]) {
      expect(() => makeHarness([counted('a', [])], { maxPerTick })).toThrow(ConfigError)
    }
  })
})
