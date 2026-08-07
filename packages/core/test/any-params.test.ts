import { describe, expect, it } from 'vitest'

import {
  ConfigError,
  createReader,
  defineParameterizedQuery,
  defineQueries,
  memoryStore,
  queryKey,
} from '../src/index.js'
import type { QueryParams, Store } from '../src/index.js'
import { makeHarness, resultsOnly, stored } from './helpers.js'

const key = (courseId: string) => queryKey('course-funnel', { courseId })

function funnel(fetch: (params: QueryParams) => Promise<unknown>, extra: object = {}) {
  return defineQueries([
    defineParameterizedQuery({
      name: 'course-funnel',
      anyParams: true,
      ...extra,
      fetch: async ({ params }: { params: QueryParams }) => fetch(params),
    } as never),
  ])
}

const counting = () => {
  const calls: string[] = []
  return {
    calls,
    fetch: async (params: QueryParams) => {
      const { courseId } = params as { courseId: string }
      calls.push(courseId)
      return `funnel:${courseId}`
    },
  }
}

describe('params the registry does not name', () => {
  it('answers with a fresh call, and keeps nothing behind', async () => {
    const { calls, fetch } = counting()
    const { store, fridge } = makeHarness(funnel(fetch))

    expect(stored(await fridge.read('course-funnel', { courseId: 'alpha' }))).toMatchObject({
      data: 'funnel:alpha',
      isStale: false,
      status: 'ok',
    })
    expect(calls).toEqual(['alpha'])

    // Not an entry: no result, no schedule row, no membership.
    expect(await store.readResult(key('alpha'))).toBeNull()
    expect(await store.readSchedule(key('alpha'))).toBeNull()
  })

  it('is a call every time, because there is nothing to have kept', async () => {
    const { calls, fetch } = counting()
    const { fridge } = makeHarness(funnel(fetch))

    await fridge.read('course-funnel', { courseId: 'alpha' })
    await fridge.read('course-funnel', { courseId: 'alpha' })

    expect(calls).toEqual(['alpha', 'alpha'])
  })

  it('never becomes work for a tick, however often it is read', async () => {
    const { calls, fetch } = counting()
    const { clock, fridge } = makeHarness(funnel(fetch))
    await fridge.read('course-funnel', { courseId: 'alpha' })

    await clock.advance(900_000)
    const report = await fridge.runDue()

    expect(report).toMatchObject({ ran: [], deferred: [], failed: [] })
    expect(report.nextRunAt).toBeNull()
    expect(calls).toEqual(['alpha'])
  })

  it('answers null when the call fails, and holds no backoff to answer with', async () => {
    const { fridge } = makeHarness(
      funnel(async () => {
        throw new Error('posthog down')
      }),
    )

    expect(await fridge.read('course-funnel', { courseId: 'alpha' })).toBeNull()
  })

  it('rejects a read with no params: there is no combination to fetch', async () => {
    const { fetch } = counting()
    const { fridge } = makeHarness(funnel(fetch))
    await expect(fridge.read('course-funnel')).rejects.toThrow(ConfigError)
  })
})

describe('a source ceiling covers these calls too', () => {
  const metered = () => {
    const { calls, fetch } = counting()
    return {
      calls,
      harness: makeHarness(funnel(fetch, { source: 'posthog' }), {
        sources: { posthog: { limit: { requests: 1, per: '1m' } } },
      }),
    }
  }

  it('spends the same window a scheduled refresh does', async () => {
    const { calls, harness } = metered()
    expect(stored(await harness.fridge.read('course-funnel', { courseId: 'alpha' }))).toMatchObject(
      { data: 'funnel:alpha' },
    )

    // 30s into the window with a 30s timeout: it cannot outwait the boundary.
    await harness.clock.advance(30_000)
    expect(await harness.fridge.read('course-funnel', { courseId: 'beta' })).toEqual({
      status: 'throttled',
      retryAt: 60_000,
    })
    expect(calls).toEqual(['alpha'])
  })
})

describe('a reader is the same read path', () => {
  it('makes the call itself when it holds a full store', async () => {
    const { calls, fetch } = counting()
    const queries = funnel(fetch)
    const store: Store = memoryStore()
    const { clock } = makeHarness(queries, { store })
    const reader = createReader({ store, queries, clock })

    expect(stored(await reader.read('course-funnel', { courseId: 'alpha' }))).toMatchObject({
      data: 'funnel:alpha',
    })
    expect(calls).toEqual(['alpha'])
    expect(await store.readSchedule(key('alpha'))).toBeNull()
  })

  it('refuses at construction when it could never make that call', async () => {
    const { fetch } = counting()
    const queries = funnel(fetch)
    expect(() => createReader({ store: resultsOnly(memoryStore()), queries })).toThrow(
      /anyParams is answered by a fresh call/,
    )
  })
})

describe('anyParams at construction', () => {
  const build = (definition: Record<string, unknown>) => () => defineQueries([definition as never])

  it('rejects anyParams combined with a list, which would be two answers to one question', () => {
    expect(
      build({
        name: 'course-funnel',
        anyParams: true,
        variants: [{ courseId: 'alpha' }],
        fetch: async () => 'v',
      }),
    ).toThrow(/cannot be combined/)
  })

  it('rejects anyParams that is not true', () => {
    expect(build({ name: 'course-funnel', anyParams: 'yes', fetch: async () => 'v' })).toThrow(
      /anyParams must be true/,
    )
  })

  const forbidden: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['every', '1m', /no entries to schedule/],
    ['lease', '2m', /claims no lease/],
    ['validUntil', () => 0, /nothing for validUntil to expire/],
    ['codec', { encode: (v: unknown) => v, decode: (v: unknown) => v }, /nothing to encode/],
  ]

  for (const [field, value, message] of forbidden) {
    it(`rejects ${field}, which an open base could not mean anything by`, () => {
      expect(
        build({ name: 'course-funnel', anyParams: true, [field]: value, fetch: async () => 'v' }),
      ).toThrow(message)
    })

    it(`rejects ${field} even when it is explicitly undefined`, () => {
      expect(
        build({
          name: 'course-funnel',
          anyParams: true,
          [field]: undefined,
          fetch: async () => 'v',
        }),
      ).toThrow(message)
    })
  }

  it('accepts a base that declares only what an open base can have', () => {
    expect(
      build({
        name: 'course-funnel',
        anyParams: true,
        timeout: '5s',
        source: 'analytics',
        fetch: async () => 'v',
      }),
    ).not.toThrow()
  })
})
