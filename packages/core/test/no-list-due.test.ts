import { describe, expect, it } from 'vitest'

import { memoryStore } from '../src/index.js'
import type { QueryDef, Store } from '../src/index.js'
import { makeHarness } from './helpers.js'

const PERIOD = 300_000

/**
 * `listDue` is an optimization an adapter may not have; without it core reads
 * rows by name. A store that cannot list is the one place "the page came back
 * empty" says nothing about the table, and reading it as "there are no rows"
 * makes every row invisible from the second tick on.
 */
function withoutListDue(store: Store): Store {
  const { listDue: _unlisted, ...rest } = store
  return { ...rest, capabilities: { ...store.capabilities, listDue: false } }
}

function registry(calls: string[]): QueryDef[] {
  return ['a', 'b'].map((name) => ({
    name,
    every: '5m',
    fetch: async () => {
      calls.push(name)
      return name
    },
  }))
}

describe('a schedule plane that cannot list', () => {
  it('keeps its rows and its period across ticks', async () => {
    const calls: string[] = []
    const store = withoutListDue(memoryStore())
    const { fridge, clock } = makeHarness(registry(calls), { store })

    const first = await fridge.runDue()
    expect(first.ran).toEqual(['a', 'b'])
    expect(first.nextRunAt).toBe(PERIOD)

    // The rows exist and are in the future. A tick that took the empty page for
    // the whole table would plan both at version 0, lose every claim to the row
    // already there, and never refresh either query again.
    const second = await fridge.runDue()
    expect(second.ran).toEqual([])
    expect(second.skippedLeased).toEqual([])
    expect(second.failed).toEqual([])
    // And it would ask to be woken immediately, forever, with nothing to do.
    expect(second.nextRunAt).toBe(PERIOD)

    await clock.advance(PERIOD)
    const third = await fridge.runDue()
    expect(third.ran).toEqual(['a', 'b'])
    expect(calls).toEqual(['a', 'b', 'a', 'b'])
  })

  it('still starts a query that has no row yet', async () => {
    const calls: string[] = []
    const store = withoutListDue(memoryStore())
    const first = makeHarness(registry(calls), { store })
    await first.fridge.runDue()

    const added: QueryDef = {
      name: 'c',
      every: '5m',
      fetch: async () => {
        calls.push('c')
        return 'c'
      },
    }
    const grown = makeHarness([...registry(calls), added], { store, clock: first.clock })
    expect((await grown.fridge.runDue()).ran).toEqual(['c'])
  })
})
