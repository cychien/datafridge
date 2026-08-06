import { describe, expect, it } from 'vitest'

import {
  ConfigError,
  createReader,
  defineParameterizedQuery,
  defineQueries,
  FakeClock,
  flushMicrotasks,
  memoryStore,
  queryKey,
} from '../src/index.js'
import type { QueryParams } from '../src/index.js'
import { makeHarness } from './helpers.js'

function courseQuery(list: () => QueryParams[] | Promise<QueryParams[]>) {
  return defineParameterizedQuery({
    name: 'per-course',
    every: '5m',
    variants: list,
    fetch: async ({ params }) => `data:${JSON.stringify(params)}`,
  })
}

const key = (courseId: string) => queryKey('per-course', { courseId })

describe('dynamic variants', () => {
  it('resolves the list at every tick: additions get rows, removals lose row and result', async () => {
    let courses = ['alpha']
    const queries = defineQueries([
      courseQuery(async () => courses.map((courseId) => ({ courseId }))),
    ])
    const { poller, store, clock } = makeHarness(queries)

    await poller.runDue()
    expect(await store.readResult(key('alpha'))).not.toBeNull()

    courses = ['alpha', 'beta']
    await clock.advance(300_000)
    await poller.runDue()
    expect(await store.readResult(key('beta'))).not.toBeNull()

    courses = ['beta']
    await clock.advance(300_000)
    await poller.runDue()
    expect(await store.readResult(key('alpha'))).toBeNull()
    expect(await store.readSchedule(key('alpha'))).toBeNull()
    expect(await store.readResult(key('beta'))).not.toBeNull()
  })

  it('a failed resolution keeps everything the base already has, and lands in the report', async () => {
    let down = false
    const queries = defineQueries([
      courseQuery(async () => {
        if (down) throw new Error('course db unreachable')
        return [{ courseId: 'alpha' }]
      }),
    ])
    const { poller, store, clock } = makeHarness(queries)
    await poller.runDue()

    down = true
    await clock.advance(300_000)
    const report = await poller.runDue()
    expect(report.failed).toEqual([{ name: 'per-course', message: 'course db unreachable' }])
    // One bad resolution deleted nothing.
    expect(await store.readResult(key('alpha'))).not.toBeNull()
    expect(await store.readSchedule(key('alpha'))).not.toBeNull()
  })

  it('duplicate params in one resolution fail that base without touching its rows', async () => {
    let dup = false
    const queries = defineQueries([
      courseQuery(async () =>
        dup ? [{ courseId: 'alpha' }, { courseId: 'alpha' }] : [{ courseId: 'alpha' }],
      ),
    ])
    const { poller, store, clock } = makeHarness(queries)
    await poller.runDue()

    dup = true
    await clock.advance(300_000)
    const report = await poller.runDue()
    expect(report.failed[0]!.message).toMatch(/duplicate variant params/)
    expect(await store.readResult(key('alpha'))).not.toBeNull()
  })

  it('a hit reads without resolving the list; only a miss pays for membership', async () => {
    let resolutions = 0
    const queries = defineQueries([
      courseQuery(() => {
        resolutions += 1
        return [{ courseId: 'alpha' }]
      }),
    ])
    const { poller, clock } = makeHarness(queries)
    await poller.runDue()
    const afterTick = resolutions

    await clock.advance(1_000)
    expect(await poller.read('per-course', { courseId: 'alpha' })).toMatchObject({
      data: 'data:{"courseId":"alpha"}',
    })
    expect(resolutions).toBe(afterTick)
  })

  it('a cold read of a current member fetches it; a non-member throws', async () => {
    const queries = defineQueries([courseQuery(() => [{ courseId: 'alpha' }])])
    const { poller, clock } = makeHarness(queries)

    const read = poller.read<string>('per-course', { courseId: 'alpha' })
    await clock.advance(0)
    await expect(read).resolves.toMatchObject({ data: 'data:{"courseId":"alpha"}' })

    await expect(poller.read('per-course', { courseId: 'ghost' })).rejects.toThrow(
      "unknown query 'per-course'",
    )
    await expect(poller.read('nowhere', { courseId: 'alpha' })).rejects.toThrow(ConfigError)
  })

  it('a reader waits for a dynamic member it cannot fetch, and rejects a non-member', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const queries = defineQueries([courseQuery(() => [{ courseId: 'alpha' }])])
    const { poller } = makeHarness(queries, { store, clock })
    const reader = createReader({ store, queries, clock })

    const waiting = reader.read<string>('per-course', { courseId: 'alpha' })
    await flushMicrotasks()
    await poller.runDue()
    await clock.advance(50)
    await expect(waiting).resolves.toMatchObject({ data: 'data:{"courseId":"alpha"}' })

    await expect(reader.read('per-course', { courseId: 'ghost' })).rejects.toThrow(
      "unknown query 'per-course'",
    )
  })
})

describe('dimensions', () => {
  it('static arrays expand to the cartesian product at construction', () => {
    const queries = defineQueries([
      defineParameterizedQuery({
        name: 'analytics',
        every: '5m',
        dimensions: {
          preset: ['7d', '30d'],
          courseId: ['alpha', 'beta'],
        },
        fetch: async ({ params }) => params,
      }),
    ])
    expect(queries.all).toHaveLength(4)
    expect(queries.dynamic).toHaveLength(0)
    // Params are canonicalized (keys sorted) at snapshot; combo order is the
    // declaration order of the dimensions.
    expect(queries.all.map((q) => q.params).map((p) => JSON.stringify(p))).toEqual([
      '{"courseId":"alpha","preset":"7d"}',
      '{"courseId":"beta","preset":"7d"}',
      '{"courseId":"alpha","preset":"30d"}',
      '{"courseId":"beta","preset":"30d"}',
    ])
  })

  it('one async dimension makes the whole product dynamic, resolved per tick', async () => {
    let courses = ['alpha']
    const queries = defineQueries([
      defineParameterizedQuery({
        name: 'analytics',
        every: '5m',
        dimensions: {
          preset: ['7d', '30d'],
          courseId: async () => courses,
        },
        fetch: async ({ params }) => params,
      }),
    ])
    expect(queries.all).toHaveLength(0)
    expect(queries.dynamic).toHaveLength(1)

    const { poller, store, clock } = makeHarness(queries)
    await poller.runDue()
    expect(
      await store.readResult(queryKey('analytics', { preset: '7d', courseId: 'alpha' })),
    ).not.toBeNull()

    courses = ['alpha', 'beta']
    await clock.advance(300_000)
    await poller.runDue()
    expect(
      await store.readResult(queryKey('analytics', { preset: '30d', courseId: 'beta' })),
    ).not.toBeNull()
  })

  it('rejects both variants and dimensions, an empty dimensions object, and a bad value', () => {
    expect(() =>
      defineQueries([
        {
          name: 'x',
          every: '5m',
          variants: [{ a: 1 }],
          dimensions: { a: [1] },
          fetch: async () => 1,
        } as never,
      ]),
    ).toThrow(/either variants or dimensions/)
    expect(() =>
      defineQueries([{ name: 'x', every: '5m', dimensions: {}, fetch: async () => 1 } as never]),
    ).toThrow(/at least one dimension/)
    expect(() =>
      defineQueries([
        { name: 'x', every: '5m', dimensions: { a: 3 }, fetch: async () => 1 } as never,
      ]),
    ).toThrow(/must be an array or a function/)
  })

  it('a dimension resolving to a non-array fails that tick, not the registry', async () => {
    const queries = defineQueries([
      defineParameterizedQuery({
        name: 'analytics',
        every: '5m',
        dimensions: { courseId: async () => 'oops' as never },
        fetch: async ({ params }) => params,
      }),
    ])
    const { poller } = makeHarness(queries)
    const report = await poller.runDue()
    expect(report.failed[0]!.message).toMatch(/dimension 'courseId' must resolve to an array/)
  })
})
