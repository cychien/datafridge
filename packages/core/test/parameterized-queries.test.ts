import { describe, expect, it } from 'vitest'

import { createReader, defineParameterizedQuery, defineQueries, queryKey } from '../src/index.js'
import { makeHarness } from './helpers.js'

type Params = {
  courseId: string
  window: '7d' | '30d'
}

function analyticsQuery(
  variants: readonly Params[] | (() => readonly Params[]),
  fetch: (params: Params) => Promise<unknown>,
) {
  return defineParameterizedQuery({
    name: 'course-analytics',
    every: '5m',
    variants,
    fetch: async ({ params }) => fetch(params),
  })
}

describe('parameterized queries', () => {
  it('expands finite runtime variants and passes typed params to independent fetches', async () => {
    const variants: Params[] = [
      { courseId: 'alpha', window: '7d' },
      { courseId: 'alpha', window: '30d' },
    ]
    const seen: Params[] = []
    const { fridge, store } = makeHarness([
      analyticsQuery(
        () => variants,
        async (params) => {
          seen.push(params)
          return { label: `${params.courseId}:${params.window}` }
        },
      ),
    ])

    const report = await fridge.runDue()
    const keys = variants.map((params) => queryKey('course-analytics', params))
    expect(report).toEqual({
      ran: keys,
      skippedLeased: [],
      throttled: [],
      deferred: [],
      failed: [],
      nextRunAt: 300_000,
    })
    expect(seen).toEqual(variants)

    const reader = createReader({ store })
    await expect(reader.read('course-analytics', variants[0])).resolves.toMatchObject({
      data: { label: 'alpha:7d' },
    })
    await expect(fridge.read('course-analytics', variants[1]!)).resolves.toMatchObject({
      data: { label: 'alpha:30d' },
    })
  })

  it('isolates success, backoff, lease, and envelopes per variant', async () => {
    const healthy: Params = { courseId: 'healthy', window: '7d' }
    const failing: Params = { courseId: 'failing', window: '7d' }
    const leased: Params = { courseId: 'leased', window: '7d' }
    const variants = [healthy, failing, leased]
    const { fridge, store } = makeHarness([
      analyticsQuery(
        () => variants,
        async (params) => {
          if (params.courseId === 'failing') throw new Error('controlled failure')
          return params.courseId
        },
      ),
    ])
    const leasedKey = queryKey('course-analytics', leased)
    await store.writeSchedule({
      name: leasedKey,
      nextRunAt: 0,
      failCount: 0,
      leaseUntil: 10_000,
      version: 1,
    })

    const report = await fridge.runDue()
    expect(report.ran).toEqual([queryKey('course-analytics', healthy)])
    expect(report.failed).toEqual([
      { name: queryKey('course-analytics', failing), message: 'controlled failure' },
    ])
    expect(report.skippedLeased).toEqual([leasedKey])

    await expect(store.readSchedule(queryKey('course-analytics', healthy))).resolves.toMatchObject({
      failCount: 0,
      nextRunAt: 300_000,
    })
    await expect(store.readSchedule(queryKey('course-analytics', failing))).resolves.toMatchObject({
      failCount: 1,
      nextRunAt: 60_000,
    })
    await expect(store.readResult(queryKey('course-analytics', healthy))).resolves.toMatchObject({
      data: 'healthy',
    })
    await expect(store.readResult(queryKey('course-analytics', failing))).resolves.toBeNull()
    await expect(store.readResult(leasedKey)).resolves.toBeNull()
  })

  it('reconciles added and removed variants without disturbing retained variants', async () => {
    const alpha: Params = { courseId: 'alpha', window: '7d' }
    const beta: Params = { courseId: 'beta', window: '7d' }
    const gamma: Params = { courseId: 'gamma', window: '30d' }
    let variants: Params[] = [alpha, beta]
    const first = makeHarness([
      analyticsQuery(
        () => variants,
        async (params) => params.courseId,
      ),
    ])
    await first.fridge.runDue()
    const betaBefore = await first.store.readResult(queryKey('course-analytics', beta))

    variants = [beta, gamma]
    const second = makeHarness(
      [
        analyticsQuery(
          () => variants,
          async (params) => params.courseId,
        ),
      ],
      { store: first.store, clock: first.clock },
    )
    const report = await second.fridge.runDue()

    expect(report.ran).toEqual([queryKey('course-analytics', gamma)])
    await expect(first.store.readSchedule(queryKey('course-analytics', alpha))).resolves.toBeNull()
    await expect(first.store.readResult(queryKey('course-analytics', alpha))).resolves.toBeNull()
    await expect(first.store.readResult(queryKey('course-analytics', beta))).resolves.toEqual(
      betaBefore,
    )
    await expect(
      first.store.readResult(queryKey('course-analytics', gamma)),
    ).resolves.toMatchObject({
      data: 'gamma',
    })
  })

  it('snapshots and freezes params when constructing the registry', async () => {
    const params: Params = { courseId: 'alpha', window: '7d' }
    let fetched: Params | undefined
    const queries = defineQueries([
      analyticsQuery([params], async (value) => {
        fetched = value
        return value.courseId
      }),
    ])
    params.courseId = 'mutated'

    const { fridge } = makeHarness(queries)
    await fridge.runDue()
    expect(fetched).toEqual({ courseId: 'alpha', window: '7d' })
    expect(Object.isFrozen(fetched)).toBe(true)
    await expect(
      fridge.read('course-analytics', { courseId: 'alpha', window: '7d' }),
    ).resolves.toMatchObject({ data: 'alpha' })
  })

  it('rejects duplicate variants after canonicalization', () => {
    const first = { courseId: 'alpha', window: '7d' } as const
    const reordered = { window: '7d', courseId: 'alpha' } as const
    expect(() => defineQueries([analyticsQuery([first, reordered], async () => null)])).toThrow(
      "query 'course-analytics': duplicate variant params",
    )
  })

  it('keeps a function-valued provider out of the static registry: it is dynamic', () => {
    const definition = defineParameterizedQuery({
      name: 'runtime',
      every: '1m',
      variants: () => [{ courseId: 'alpha', window: '7d' }],
      fetch: async ({ params }) => params,
    })

    const queries = defineQueries([definition])
    expect(queries.all).toHaveLength(0)
    expect(queries.dynamic).toHaveLength(1)
    expect(queries.dynamic[0]!.baseName).toBe('runtime')
  })
})
