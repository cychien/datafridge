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
  TimeoutError,
} from '../src/index.js'
import type { QueryParams, ResolveCtx, Store } from '../src/index.js'
import { deferred, makeHarness } from './helpers.js'

type VariantList = (ctx: ResolveCtx) => QueryParams[] | Promise<QueryParams[]>

function courseQuery(list: VariantList) {
  return defineParameterizedQuery({
    name: 'per-course',
    every: '5m',
    variants: list,
    fetch: async ({ params }) => `data:${JSON.stringify(params)}`,
  })
}

function hangingQuery(name: string, onSignal: (signal: AbortSignal) => void) {
  return defineParameterizedQuery({
    name,
    every: '5m',
    timeout: '10s',
    variants: ({ signal }) => {
      onSignal(signal)
      return new Promise<QueryParams[]>(() => {})
    },
    fetch: async ({ params }) => `data:${JSON.stringify(params)}`,
  })
}

const key = (courseId: string) => queryKey('per-course', { courseId })

/**
 * A default-timeout static query sharing a registry with a dynamic base whose
 * list resolves once and hangs for a full 2m timeout on every tick after that.
 */
function slowListHarness() {
  const clock = new FakeClock(0)
  const backing = memoryStore()
  const claims: Array<{ name: string; leaseUntil: number }> = []
  const store: Store = {
    ...backing,
    claim: (name, expectedVersion, leaseUntil, now) => {
      claims.push({ name, leaseUntil })
      return backing.claim(name, expectedVersion, leaseUntil, now)
    },
  }
  let resolutions = 0
  let fetches = 0
  const queries = defineQueries([
    {
      name: 'static',
      every: '5m',
      fetch: async () => {
        fetches += 1
        return 'v'
      },
    },
    defineParameterizedQuery({
      name: 'per-course',
      every: '15m',
      timeout: '2m',
      variants: () => {
        resolutions += 1
        return resolutions === 1 ? [{ courseId: 'alpha' }] : new Promise<QueryParams[]>(() => {})
      },
      fetch: async ({ params }) => params,
    }),
  ])
  const { fridge } = makeHarness(queries, { store, clock })
  return { fridge, clock, fetches: () => fetches, claims: () => claims }
}

describe('dynamic variants', () => {
  it('resolves the list at every tick: additions get rows, removals lose row and result', async () => {
    let courses = ['alpha']
    const queries = defineQueries([
      courseQuery(async () => courses.map((courseId) => ({ courseId }))),
    ])
    const { fridge, store, clock } = makeHarness(queries)

    await fridge.runDue()
    expect(await store.readResult(key('alpha'))).not.toBeNull()

    courses = ['alpha', 'beta']
    await clock.advance(300_000)
    await fridge.runDue()
    expect(await store.readResult(key('beta'))).not.toBeNull()

    courses = ['beta']
    await clock.advance(300_000)
    await fridge.runDue()
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
    const { fridge, store, clock } = makeHarness(queries)
    await fridge.runDue()

    down = true
    await clock.advance(300_000)
    const report = await fridge.runDue()
    expect(report.failed).toEqual([{ name: 'per-course', message: 'course db unreachable' }])
    // One bad resolution deleted nothing.
    expect(await store.readResult(key('alpha'))).not.toBeNull()
    expect(await store.readSchedule(key('alpha'))).not.toBeNull()
  })

  it('a failing resolution backs the base off in its own row instead of retrying every tick', async () => {
    let down = false
    let resolutions = 0
    const queries = defineQueries([
      courseQuery(async () => {
        resolutions += 1
        if (down) throw new Error('course db unreachable')
        return [{ courseId: 'alpha' }]
      }),
    ])
    const { fridge, store, clock } = makeHarness(queries)
    await fridge.runDue()
    const afterFirstTick = resolutions

    down = true
    await clock.advance(300_000)
    const firstFailAt = clock.now()
    await fridge.runDue()
    const first = (await store.readSchedule('per-course'))!
    expect(first.failCount).toBe(1)
    expect(first.nextRunAt).toBeGreaterThan(firstFailAt)
    expect(resolutions).toBe(afterFirstTick + 1)

    // Ticks inside the backoff window do not call resolve() at all, so a down
    // dependency is not asked again once per alarm.
    await clock.advance(1_000)
    const quiet = await fridge.runDue()
    expect(resolutions).toBe(afterFirstTick + 1)
    expect(quiet.failed).toEqual([])

    await clock.advance(first.nextRunAt - clock.now())
    const secondFailAt = clock.now()
    await fridge.runDue()
    const second = (await store.readSchedule('per-course'))!
    expect(second.failCount).toBe(2)
    expect(second.nextRunAt - secondFailAt).toBeGreaterThan(first.nextRunAt - firstFailAt)

    // Everything the base already had survived every failure.
    expect(await store.readResult(key('alpha'))).not.toBeNull()
    expect(await store.readSchedule(key('alpha'))).not.toBeNull()
  })

  it('a resolution that recovers clears the backoff row and resumes the variants', async () => {
    let down = true
    const queries = defineQueries([
      courseQuery(async () => {
        if (down) throw new Error('course db unreachable')
        return [{ courseId: 'alpha' }]
      }),
    ])
    const { fridge, store, clock } = makeHarness(queries)
    await fridge.runDue()
    expect((await store.readSchedule('per-course'))!.failCount).toBe(1)

    down = false
    await clock.advance(60_000)
    const report = await fridge.runDue()
    expect(report.failed).toEqual([])
    expect(await store.readSchedule('per-course')).toBeNull()
    expect(await store.readResult(key('alpha'))).not.toBeNull()
  })

  it('a resolution that hangs is a failed resolution, aborted at the base timeout', async () => {
    let hang = false
    let received: AbortSignal | undefined
    const queries = defineQueries([
      defineParameterizedQuery({
        name: 'per-course',
        every: '5m',
        timeout: '10s',
        variants: ({ signal }) => {
          if (!hang) return [{ courseId: 'alpha' }]
          received = signal
          return new Promise<QueryParams[]>(() => {})
        },
        fetch: async ({ params }) => `data:${JSON.stringify(params)}`,
      }),
    ])
    const { fridge, store, clock } = makeHarness(queries)
    await fridge.runDue()

    hang = true
    await clock.advance(300_000)
    const startedAt = clock.now()
    const run = fridge.runDue()
    await flushMicrotasks()
    await clock.advance(10_000)

    const report = await run
    expect(clock.now() - startedAt).toBe(10_000)
    expect(report.failed).toEqual([
      {
        name: 'per-course',
        message: "query 'per-course': variant resolution timed out after 10000ms",
      },
    ])
    expect(received!.aborted).toBe(true)
    expect(received!.reason).toBeInstanceOf(TimeoutError)

    const base = (await store.readSchedule('per-course'))!
    expect(base.failCount).toBe(1)
    expect(base.nextRunAt).toBeGreaterThan(clock.now())
    expect(await store.readResult(key('alpha'))).not.toBeNull()
    expect(await store.readSchedule(key('alpha'))).not.toBeNull()
  })

  it('two hung bases cost one timeout, not two', async () => {
    const queries = defineQueries([
      hangingQuery('first', () => undefined),
      hangingQuery('second', () => undefined),
    ])
    const { fridge, clock } = makeHarness(queries)

    const startedAt = clock.now()
    const run = fridge.runDue()
    await flushMicrotasks()
    await clock.advance(10_000)

    const report = await run
    expect(clock.now() - startedAt).toBe(10_000)
    expect(report.failed.map((f) => f.name)).toEqual(['first', 'second'])
  })

  it('a cold read of a hung base surfaces the timeout rather than waiting past it', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const queries = defineQueries([hangingQuery('per-course', () => undefined)])
    const { fridge } = makeHarness(queries, { store, clock })
    const reader = createReader({ store, queries, clock })

    const viaFridge = fridge.read('per-course', { courseId: 'alpha' })
    const viaReader = reader.read('per-course', { courseId: 'alpha' })
    await flushMicrotasks()
    await clock.advance(10_000)

    await expect(viaFridge).rejects.toThrow(TimeoutError)
    await expect(viaReader).rejects.toThrow(TimeoutError)
  })

  it('a hang longer than the first backoff still schedules ahead, not into the past', async () => {
    // The one-second alarm floor coming back through a different door: a `now`
    // captured before resolution would put a 60s backoff 60s behind a 120s hang.
    let resolutions = 0
    const queries = defineQueries([
      defineParameterizedQuery({
        name: 'per-course',
        every: '15m',
        timeout: '2m',
        variants: () => {
          resolutions += 1
          return new Promise<QueryParams[]>(() => {})
        },
        fetch: async ({ params }) => params,
      }),
    ])
    const { fridge, store, clock } = makeHarness(queries)

    const run = fridge.runDue()
    await flushMicrotasks()
    await clock.advance(120_000)
    await run

    const row = (await store.readSchedule('per-course'))!
    expect(row.nextRunAt).toBe(clock.now() + 60_000)
    expect(resolutions).toBe(1)

    // And the very next tick honours that backoff instead of hanging again.
    await fridge.runDue()
    expect(resolutions).toBe(1)
  })

  it('an explicit runDue(now) is never refreshed, so a caller keeps control of time', async () => {
    const { fridge, clock, fetches } = slowListHarness()
    await fridge.runDue()
    expect(fetches()).toBe(1)

    await clock.advance(200_000)
    const run = fridge.runDue(clock.now())
    await flushMicrotasks()
    await clock.advance(120_000)
    await run

    // Pinned at 200_000, so 'static' is not due even though the wall clock
    // passed its 300_000 boundary while the list hung.
    expect(fetches()).toBe(1)
  })

  it('runDue() picks up the post-resolution time, and leases are still born live', async () => {
    const { fridge, clock, fetches, claims } = slowListHarness()
    await fridge.runDue()
    expect(fetches()).toBe(1)

    await clock.advance(200_000)
    const run = fridge.runDue()
    await flushMicrotasks()
    await clock.advance(120_000)
    await run

    expect(fetches()).toBe(2)
    const staticClaims = claims().filter((c) => c.name === 'static')
    expect(staticClaims[staticClaims.length - 1]!.leaseUntil).toBeGreaterThan(clock.now())
  })

  it('a cold read spends one timeout on membership and the wait together, not two', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const list = deferred<QueryParams[]>()
    const queries = defineQueries([
      defineParameterizedQuery({
        name: 'per-course',
        every: '5m',
        timeout: '10s',
        variants: () => list.promise,
        fetch: () => new Promise<string>(() => {}),
      }),
    ])
    const { fridge } = makeHarness(queries, { store, clock })
    const reader = createReader({ store, queries, clock })

    const viaFridge = fridge.read('per-course', { courseId: 'alpha' })
    const viaReader = reader.read('per-course', { courseId: 'alpha' })
    await flushMicrotasks()

    // Six of the ten seconds go to the list; the wait inherits the remaining
    // four rather than starting a fresh ten.
    await clock.advance(6_000)
    list.resolve([{ courseId: 'alpha' }])
    await flushMicrotasks()
    await clock.advance(4_000)

    expect(clock.now()).toBe(10_000)
    expect(await Promise.race([viaFridge, Promise.resolve('pending')])).not.toBe('pending')
    expect(await Promise.race([viaReader, Promise.resolve('pending')])).not.toBe('pending')
    await expect(viaFridge).resolves.toBeNull()
    await expect(viaReader).resolves.toBeNull()
  })

  it('duplicate params in one resolution fail that base without touching its rows', async () => {
    let dup = false
    const queries = defineQueries([
      courseQuery(async () =>
        dup ? [{ courseId: 'alpha' }, { courseId: 'alpha' }] : [{ courseId: 'alpha' }],
      ),
    ])
    const { fridge, store, clock } = makeHarness(queries)
    await fridge.runDue()

    dup = true
    await clock.advance(300_000)
    const report = await fridge.runDue()
    expect(report.failed[0]!.message).toMatch(/duplicate variant params/)
    expect(await store.readResult(key('alpha'))).not.toBeNull()
  })

  it('a stale variant reads straight from the store, however broken the variant list is', async () => {
    let down = false
    const queries = defineQueries([
      courseQuery(async () => {
        if (down) throw new Error('course db unreachable')
        return [{ courseId: 'alpha' }]
      }),
    ])
    const { fridge, clock } = makeHarness(queries)
    await fridge.runDue()

    down = true
    await clock.advance(300_000)

    expect(await fridge.read('per-course', { courseId: 'alpha' })).toMatchObject({ isStale: true })
  })

  it('a hit reads without resolving the list; only a miss pays for membership', async () => {
    let resolutions = 0
    const queries = defineQueries([
      courseQuery(() => {
        resolutions += 1
        return [{ courseId: 'alpha' }]
      }),
    ])
    const { fridge, clock } = makeHarness(queries)
    await fridge.runDue()
    const afterTick = resolutions

    await clock.advance(1_000)
    expect(await fridge.read('per-course', { courseId: 'alpha' })).toMatchObject({
      data: 'data:{"courseId":"alpha"}',
    })
    expect(resolutions).toBe(afterTick)
  })

  it('a cold read of a current member fetches it; a non-member throws', async () => {
    const queries = defineQueries([courseQuery(() => [{ courseId: 'alpha' }])])
    const { fridge, clock } = makeHarness(queries)

    const read = fridge.read<string>('per-course', { courseId: 'alpha' })
    await clock.advance(0)
    await expect(read).resolves.toMatchObject({ data: 'data:{"courseId":"alpha"}' })

    await expect(fridge.read('per-course', { courseId: 'ghost' })).rejects.toThrow(
      "unknown query 'per-course'",
    )
    await expect(fridge.read('nowhere', { courseId: 'alpha' })).rejects.toThrow(ConfigError)
  })

  it('a reader waits for a dynamic member it cannot fetch, and rejects a non-member', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const queries = defineQueries([courseQuery(() => [{ courseId: 'alpha' }])])
    const { fridge } = makeHarness(queries, { store, clock })
    const reader = createReader({ store, queries, clock })

    const waiting = reader.read<string>('per-course', { courseId: 'alpha' })
    await flushMicrotasks()
    await fridge.runDue()
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

    const { fridge, store, clock } = makeHarness(queries)
    await fridge.runDue()
    expect(
      await store.readResult(queryKey('analytics', { preset: '7d', courseId: 'alpha' })),
    ).not.toBeNull()

    courses = ['alpha', 'beta']
    await clock.advance(300_000)
    await fridge.runDue()
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
    const { fridge } = makeHarness(queries)
    const report = await fridge.runDue()
    expect(report.failed[0]!.message).toMatch(/dimension 'courseId' must resolve to an array/)
  })
})
