import { describe, expect, it } from 'vitest'

import { defineParameterizedQuery, defineQueries, memoryStore, queryKey } from '../src/index.js'
import type { QueryParams, Store } from '../src/index.js'
import { deferred, makeHarness, stored } from './helpers.js'

const MINUTE = 60_000

function funnel(fetch: (params: QueryParams) => Promise<unknown>, extra: object = {}) {
  return defineQueries([
    defineParameterizedQuery({
      name: 'course-funnel',
      anyParams: true,
      timeout: '2m',
      ...extra,
      fetch: async ({ params }: { params: QueryParams }) => fetch(params),
    } as never),
  ])
}

const alpha = { courseId: 'alpha' }

describe('reads of the same unnamed params that overlap', () => {
  it('coalesce into one call, and everyone gets its answer', async () => {
    const gate = deferred<string>()
    const calls: string[] = []
    const { clock, store, fridge } = makeHarness(
      funnel(async (params) => {
        calls.push((params as { courseId: string }).courseId)
        return gate.promise
      }),
    )

    const first = fridge.read<string>('course-funnel', alpha)
    const second = fridge.read<string>('course-funnel', alpha)
    await clock.advance(0)

    // Two readers, one flight, one call.
    expect(calls).toEqual(['alpha'])

    gate.resolve('funnel:alpha')
    await clock.advance(100)

    expect(stored(await first)).toMatchObject({ data: 'funnel:alpha' })
    expect(stored(await second)).toMatchObject({ data: 'funnel:alpha' })
    expect(calls).toEqual(['alpha'])
    // Coalescing is not caching: nothing lasting was created for these params.
    expect(await store.readResult(queryKey('course-funnel', alpha))).toBeNull()
    expect(await store.readSchedule(queryKey('course-funnel', alpha))).toBeNull()
  })

  it('cost the source exactly one slot between them', async () => {
    const gate = deferred<string>()
    const { clock, store, fridge } = makeHarness(
      funnel(async () => gate.promise, { source: 'posthog' }),
      { sources: { posthog: { limit: { requests: 2, per: '1m' } } } },
    )

    const first = fridge.read<string>('course-funnel', alpha)
    const second = fridge.read<string>('course-funnel', alpha)
    await clock.advance(0)
    gate.resolve('v')
    await clock.advance(100)
    await Promise.all([first, second])

    // One call happened, so one slot is spent and one is left.
    expect(await store.takeQuota('posthog', 2, MINUTE, 0)).toBe(true)
    expect(await store.takeQuota('posthog', 2, MINUTE, 0)).toBe(false)
  })

  it('do not coalesce once the flight they would have joined has settled', async () => {
    const calls: string[] = []
    const { clock, fridge } = makeHarness(
      funnel(async (params) => {
        calls.push((params as { courseId: string }).courseId)
        return `v${calls.length}`
      }),
    )

    expect(stored(await fridge.read<string>('course-funnel', alpha))).toMatchObject({ data: 'v1' })
    await clock.advance(0)
    // An answer belongs to the readers who waited for it. This one arrives
    // afterwards and is entitled to a fresh call, not to somebody else's.
    expect(stored(await fridge.read<string>('course-funnel', alpha))).toMatchObject({ data: 'v2' })
    expect(calls).toEqual(['alpha', 'alpha'])
  })

  it('keep different params apart', async () => {
    const gate = deferred<string>()
    const calls: string[] = []
    const { clock, fridge } = makeHarness(
      funnel(async (params) => {
        calls.push((params as { courseId: string }).courseId)
        return gate.promise
      }),
    )

    const a = fridge.read('course-funnel', alpha)
    const b = fridge.read('course-funnel', { courseId: 'beta' })
    await clock.advance(0)
    expect(calls.toSorted()).toEqual(['alpha', 'beta'])

    gate.resolve('v')
    await clock.advance(100)
    await Promise.all([a, b])
  })

  it('coalesce across separate readers over one store, as two Workers would', async () => {
    const gate = deferred<string>()
    const calls: string[] = []
    const store: Store = memoryStore()
    const fetch = async (params: QueryParams) => {
      calls.push((params as { courseId: string }).courseId)
      return gate.promise
    }
    const one = makeHarness(funnel(fetch), { store })
    const two = makeHarness(funnel(fetch), { store, clock: one.clock })

    const first = one.fridge.read<string>('course-funnel', alpha)
    const second = two.fridge.read<string>('course-funnel', alpha)
    await one.clock.advance(0)

    // Two instances, no shared memory between them, one upstream call.
    expect(calls).toEqual(['alpha'])

    gate.resolve('funnel:alpha')
    await one.clock.advance(100)
    expect(stored(await first)).toMatchObject({ data: 'funnel:alpha' })
    expect(stored(await second)).toMatchObject({ data: 'funnel:alpha' })
    expect(calls).toEqual(['alpha'])
  })

  it('hand the same failure to the whole cohort, and charge nobody twice', async () => {
    const gate = deferred<string>()
    const calls: string[] = []
    const { clock, fridge } = makeHarness(
      funnel(async () => {
        calls.push('x')
        return gate.promise
      }),
    )

    const first = fridge.read('course-funnel', alpha)
    const second = fridge.read('course-funnel', alpha)
    await clock.advance(0)
    gate.reject(new Error('posthog down'))
    await clock.advance(100)

    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(calls).toEqual(['x'])
  })
})
