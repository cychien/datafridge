import { describe, expect, it } from 'vitest'

import { memoryStore } from '../src/index.js'
import type { QueryDef, Store } from '../src/index.js'
import { makeHarness } from './helpers.js'

// Comfortably past the page a tick reads, which is deliberately private: what
// has to hold is that outgrowing it changes nothing an operator can observe.
const BEYOND_ONE_PAGE = 600

const every = '5m'
const PERIOD = 300_000

function registry(count: number, calls: string[]): QueryDef[] {
  return Array.from({ length: count }, (_, index) => {
    const name = `q${String(index).padStart(4, '0')}`
    return {
      name,
      every,
      fetch: async () => {
        calls.push(name)
        return name
      },
    }
  })
}

function countingListDue(store: Store, pages: number[]): Store {
  return {
    ...store,
    listDue: async (now, limit) => {
      const rows = await store.listDue!(now, limit)
      pages.push(rows.length)
      return rows
    },
  }
}

describe('a registry larger than the page a tick reads', () => {
  it('runs every query, then goes quiet until the period is up', async () => {
    const calls: string[] = []
    const store = memoryStore()
    const pages: number[] = []
    const { fridge } = makeHarness(registry(BEYOND_ONE_PAGE, calls), {
      store: countingListDue(store, pages),
    })

    const first = await fridge.runDue()
    expect(first.ran).toHaveLength(BEYOND_ONE_PAGE)
    expect(first.deferred).toEqual([])

    const second = await fridge.runDue()

    // The table now holds more rows than one page, and every one of them is in
    // the future. A tick that read "the page is full" as "I am behind" would
    // ask to be woken immediately, forever, with nothing at all to do.
    expect(second.ran).toEqual([])
    expect(second.deferred).toEqual([])
    expect(second.skippedLeased).toEqual([])
    expect(second.failed).toEqual([])
    expect(second.nextRunAt).toBe(PERIOD)
    expect(calls).toHaveLength(BEYOND_ONE_PAGE)
    // The page really is the bound on what one tick reads.
    expect(Math.max(...pages)).toBeLessThan(BEYOND_ONE_PAGE)
  })

  it('still starts a query that has no row yet', async () => {
    const calls: string[] = []
    const store = memoryStore()
    const first = makeHarness(registry(BEYOND_ONE_PAGE, calls), { store })
    await first.fridge.runDue()

    // A deploy adds one query. Its name sorts last, so nothing about the page
    // it is missing from should decide whether it ever runs.
    const added: QueryDef = {
      name: 'zz-added',
      every,
      fetch: async () => {
        calls.push('zz-added')
        return 'zz-added'
      },
    }
    const grown = makeHarness([...registry(BEYOND_ONE_PAGE, calls), added], {
      store,
      clock: first.clock,
    })
    const report = await grown.fridge.runDue()

    expect(report.ran).toEqual(['zz-added'])
    expect(report.skippedLeased).toEqual([])
    expect(await store.readSchedule('zz-added')).toMatchObject({ nextRunAt: PERIOD })
  })
})
