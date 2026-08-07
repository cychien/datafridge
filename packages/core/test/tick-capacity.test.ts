import { describe, expect, it } from 'vitest'

import { memoryStore } from '../src/index.js'
import type { QueryDef, Store } from '../src/index.js'
import { makeDriver, makeHarness } from './helpers.js'

const slow = (name: string, calls: string[], timeout: QueryDef['timeout'] = '30s'): QueryDef => ({
  name,
  every: '5m',
  timeout,
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
  it('never starts work whose own timeout outlasts what the invocation has left', async () => {
    const calls: string[] = []
    // A 30s query cannot finish inside a 20s invocation, so it is never begun;
    // the 5s one alongside it is unaffected.
    const { clock, fridge } = makeHarness(
      [slow('wide', calls, '30s'), slow('narrow', calls, '5s')],
      { driver: makeDriver({ serialized: true, budgetMs: 20_000 }) },
    )

    const report = await fridge.runDue()

    expect(report.ran).toEqual(['narrow'])
    expect(report.deferred).toEqual(['wide'])
    expect(calls).toEqual(['narrow'])
    // Deferred work is untouched, so it is still due - and the tick says so.
    expect(report.nextRunAt).toBe(clock.now())
  })

  it('takes on everything that does fit, and says when it next has work', async () => {
    const calls: string[] = []
    const { fridge } = makeHarness([slow('a', calls), slow('b', calls)], {
      driver: makeDriver({ serialized: true, budgetMs: 900_000 }),
    })

    const report = await fridge.runDue()

    expect(report.ran.toSorted()).toEqual(['a', 'b'])
    expect(report.deferred).toEqual([])
    expect(report.nextRunAt).toBe(300_000)
  })

  it('stops asking a source that already said no this tick', async () => {
    const takes: number[] = []
    const base = memoryStore()
    const store: Store = {
      ...base,
      takeQuota: (source, limit, windowMs, now) => {
        takes.push(now)
        return base.takeQuota(source, limit, windowMs, now)
      },
    }
    const metered = (name: string): QueryDef => ({
      name,
      every: '5m',
      source: 'posthog',
      fetch: async () => name,
    })
    const names = Array.from({ length: 12 }, (_, i) => metered(`q${i}`))
    const { fridge } = makeHarness(names, {
      store,
      sources: { posthog: { limit: { requests: 1, per: '1m' }, maxConcurrent: 1 } },
    })

    const report = await fridge.runDue()

    expect(report.ran).toHaveLength(1)
    expect(report.throttled).toHaveLength(1)
    expect(report.deferred).toHaveLength(10)
    // One call got through, one learned the window was spent, and nobody else
    // paid a round trip to be told the same thing.
    expect(takes).toHaveLength(2)
  })

  it('reads rows in one bounded page, and never asks for an unbounded one', async () => {
    const limits: number[] = []
    const { store, fridge } = makeHarness([slow('a', [])], {
      store: countingListDue(memoryStore(), limits),
    })
    await fridge.runDue()

    expect(limits).toHaveLength(1)
    expect(Number.isSafeInteger(limits[0])).toBe(true)
    expect(limits[0]).toBeLessThan(Number.MAX_SAFE_INTEGER)
    expect(await store.readSchedule('a')).not.toBeNull()
  })

  it('rejects an invocation budget that is not a positive duration, at construction', () => {
    for (const budgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        makeHarness([slow('a', [])], { driver: makeDriver({ serialized: true, budgetMs }) }),
      ).toThrow(/budgetMs must be a positive number/)
    }
  })
})
