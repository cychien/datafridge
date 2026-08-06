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
import { makeDriver, makeHarness, stored } from './helpers.js'

const HOUR = 3_600_000
const key = (courseId: string) => queryKey('course-funnel', { courseId })

function funnel(fetch: (params: QueryParams) => Promise<unknown>) {
  return defineQueries([
    defineParameterizedQuery({
      name: 'course-funnel',
      every: '15m',
      retain: '2h',
      fetch: async ({ params }) => fetch(params),
    }),
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

describe('entries nothing declared', () => {
  it('a read for unknown params creates the entry and answers with it', async () => {
    const { calls, fetch } = counting()
    const { clock, store, fridge } = makeHarness(funnel(fetch))

    const read = fridge.read<string>('course-funnel', { courseId: 'alpha' })
    await clock.advance(0)
    expect(stored(await read)).toMatchObject({ data: 'funnel:alpha' })
    expect(calls).toEqual(['alpha'])

    // The row carries the params, because the key only hashes them and the
    // scheduler has to be able to run this again without anyone declaring it.
    expect(await store.readSchedule(key('alpha'))).toMatchObject({
      params: { courseId: 'alpha' },
      failCount: 0,
    })
  })

  it('is then refreshed on its own period like any other entry', async () => {
    const { calls, fetch } = counting()
    const { clock, fridge } = makeHarness(funnel(fetch))
    await fridge.read('course-funnel', { courseId: 'alpha' }).catch(() => null)
    await clock.advance(0)

    await clock.advance(900_000)
    expect((await fridge.runDue()).ran).toEqual([key('alpha')])
    expect(calls).toEqual(['alpha', 'alpha'])
  })

  it('a tick with no on-demand entries yet reconciles nothing away', async () => {
    const { fetch } = counting()
    const { store, fridge } = makeHarness(funnel(fetch))
    expect(await fridge.runDue()).toMatchObject({ ran: [], failed: [] })
    expect(await store.readSchedule(key('alpha'))).toBeNull()
  })

  it('rejects a read with no params: there is no list to belong to', async () => {
    const { fetch } = counting()
    const { fridge } = makeHarness(funnel(fetch))
    await expect(fridge.read('course-funnel')).rejects.toThrow(ConfigError)
  })
})

describe('retain', () => {
  it('drops an entry nothing has read for that long, and stops refreshing it', async () => {
    const { calls, fetch } = counting()
    const { clock, store, fridge } = makeHarness(funnel(fetch))
    await fridge.read('course-funnel', { courseId: 'alpha' })
    await clock.advance(0)

    // Eviction is for an entry idle for longer than retain, so the boundary
    // itself is still a keep.
    await clock.advance(2 * HOUR)
    await fridge.runDue()
    expect(await store.readResult(key('alpha'))).not.toBeNull()

    await clock.advance(1)
    const report = await fridge.runDue()

    expect(await store.readResult(key('alpha'))).toBeNull()
    expect(await store.readSchedule(key('alpha'))).toBeNull()
    expect(report.ran).toEqual([])
    // Eviction is what stops the refreshing; there is no other switch.
    const before = calls.length
    await clock.advance(HOUR)
    expect((await fridge.runDue()).ran).toEqual([])
    expect(calls).toHaveLength(before)
  })

  it('a read inside the window keeps it, and the clock starts again from there', async () => {
    const { fetch } = counting()
    const { clock, store, fridge } = makeHarness(funnel(fetch))
    await fridge.read('course-funnel', { courseId: 'alpha' })
    await clock.advance(0)

    await clock.advance(HOUR)
    await fridge.read('course-funnel', { courseId: 'alpha' })
    await clock.advance(0)

    // 2h after the entry was created, but only 1h after it was last read.
    await clock.advance(HOUR)
    await fridge.runDue()
    expect(await store.readResult(key('alpha'))).not.toBeNull()

    await clock.advance(2 * HOUR)
    await fridge.runDue()
    expect(await store.readResult(key('alpha'))).toBeNull()
  })

  it('a refresh is not a read: polling alone cannot keep an entry alive', async () => {
    const { fetch } = counting()
    const { clock, store, fridge } = makeHarness(funnel(fetch))
    await fridge.read('course-funnel', { courseId: 'alpha' })
    await clock.advance(0)

    // Nine refreshes over two and a quarter hours, and not one reader.
    for (let i = 0; i < 9; i += 1) {
      await clock.advance(900_000)
      await fridge.runDue()
    }
    expect(await store.readResult(key('alpha'))).toBeNull()
  })

  it('a reader keeps an entry warm, which is the only way it works on Cloudflare', async () => {
    const { fetch } = counting()
    const queries = funnel(fetch)
    const store: Store = memoryStore()
    const { clock, fridge } = makeHarness(queries, { store })
    await fridge.read('course-funnel', { courseId: 'alpha' })
    await clock.advance(0)

    const deferred: Array<Promise<unknown>> = []
    const reader = createReader({ store, queries, clock, defer: (p) => deferred.push(p) })

    await clock.advance(HOUR)
    expect(await reader.read('course-funnel', { courseId: 'alpha' })).toMatchObject({
      data: 'funnel:alpha',
    })
    await Promise.all(deferred)

    await clock.advance(HOUR + 60_000)
    await fridge.runDue()
    expect(await store.readResult(key('alpha'))).not.toBeNull()
  })
})

describe('an on-demand entry whose first fetch failed', () => {
  const broken = () =>
    funnel(async () => {
      throw new Error('posthog down')
    })

  it('keeps its backoff, then goes away instead of retrying forever unread', async () => {
    const { clock, store, fridge } = makeHarness(broken())
    expect(await fridge.read('course-funnel', { courseId: 'alpha' })).toBeNull()
    await clock.advance(0)

    const row = (await store.readSchedule(key('alpha')))!
    expect(row).toMatchObject({ failCount: 1 })
    expect(row.nextRunAt).toBeGreaterThan(clock.now())

    // Inside the backoff the row is protection against a reader hammering a
    // broken key, so the tick leaves it exactly where it is.
    await fridge.runDue()
    expect(await store.readSchedule(key('alpha'))).toEqual(row)

    // Once it expires, one read is not evidence that anybody still wants this.
    await clock.advance(row.nextRunAt - clock.now())
    expect((await fridge.runDue()).ran).toEqual([])
    expect(await store.readSchedule(key('alpha'))).toBeNull()
  })
})

describe('retain at construction', () => {
  const build = (definition: Record<string, unknown>) => () => defineQueries([definition as never])

  it('rejects a retain shorter than the period it would be refreshed on', () => {
    expect(
      build({
        name: 'course-funnel',
        every: '15m',
        retain: '5m',
        fetch: async () => 'v',
      }),
    ).toThrow(/retain .* must be longer than every/)
  })

  it('rejects retain combined with a list, which would be two answers to one question', () => {
    expect(
      build({
        name: 'course-funnel',
        every: '15m',
        retain: '2h',
        variants: [{ courseId: 'alpha' }],
        fetch: async () => 'v',
      }),
    ).toThrow(/cannot be combined/)
  })

  it('rejects a schedule plane that cannot enumerate what it is holding', () => {
    const store = memoryStore()
    const blind: Store = { ...store, capabilities: { atomicClaim: true, listDue: false } }
    delete (blind as { listDue?: unknown }).listDue
    const { fetch } = counting()
    expect(() =>
      makeHarness(funnel(fetch), { store: blind, driver: makeDriver({ serialized: true }) }),
    ).toThrow(/retain needs a schedule plane that can list rows/)
  })
})
