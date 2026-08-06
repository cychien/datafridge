import { describe, expect, it } from 'vitest'

import {
  ConfigError,
  createReader,
  defineParameterizedQuery,
  defineQueries,
  queryKey,
} from '../src/index.js'
import type { QueryCodec } from '../src/index.js'
import { makeHarness, resultsOnly } from './helpers.js'

const mapCodec: QueryCodec<Map<string, number>> = {
  encode: (value) => ({ rows: [...value] }),
  decode: (raw) => new Map((raw as { rows: [string, number][] }).rows),
}

const byPath = new Map([
  ['/a', 3],
  ['/b', 7],
])

describe('codec', () => {
  it('stores the encoded JSON and hands the decoded value back', async () => {
    const { store, poller } = makeHarness([
      { name: 'views', every: '5m', codec: mapCodec, fetch: async () => new Map(byPath) },
    ])
    await poller.runDue()

    // The row is plain JSON: any language can read it.
    expect((await store.readResult('views'))!.data).toEqual({
      rows: [
        ['/a', 3],
        ['/b', 7],
      ],
    })

    const read = await poller.read<Map<string, number>>('views')
    expect(read!.data).toBeInstanceOf(Map)
    expect(read!.data.get('/b')).toBe(7)
  })

  it('decodes through a reader holding the registry, and not through a bare one', async () => {
    const queries = defineQueries([
      { name: 'views', every: '5m', codec: mapCodec, fetch: async () => new Map(byPath) },
    ])
    const { store, poller, clock } = makeHarness(queries)
    await poller.runDue()

    const withRegistry = createReader({ store, queries, clock })
    expect((await withRegistry.read<Map<string, number>>('views'))!.data).toBeInstanceOf(Map)

    const bare = createReader({ store: resultsOnly(store), clock })
    expect((await bare.read('views'))!.data).toEqual({
      rows: [
        ['/a', 3],
        ['/b', 7],
      ],
    })
  })

  it('an encode failure counts as a fetch failure and keeps the old result', async () => {
    let broken = false
    const { store, poller, clock } = makeHarness([
      {
        name: 'views',
        every: '5m',
        codec: {
          encode: (value) => {
            if (broken) throw new Error('not serializable')
            return value
          },
          decode: (raw) => raw,
        },
        fetch: async () => 'v1',
      },
    ])
    await poller.runDue()
    broken = true
    await clock.advance(300_000)

    const report = await poller.runDue()
    expect(report.failed).toEqual([{ name: 'views', message: 'not serializable' }])
    expect((await poller.read<string>('views'))!.data).toBe('v1')
    expect((await store.readSchedule('views'))!.failCount).toBe(1)
  })

  it('applies to every variant of a parameterized query', async () => {
    const queries = defineQueries([
      defineParameterizedQuery({
        name: 'per-course',
        every: '5m',
        variants: [{ courseId: 'alpha' }],
        codec: mapCodec,
        fetch: async () => new Map(byPath),
      }),
    ])
    const { store, poller } = makeHarness(queries)
    await poller.runDue()

    const key = queryKey('per-course', { courseId: 'alpha' })
    expect((await store.readResult(key))!.data).toEqual({
      rows: [
        ['/a', 3],
        ['/b', 7],
      ],
    })
    const read = await poller.read<Map<string, number>>('per-course', { courseId: 'alpha' })
    expect(read!.data).toBeInstanceOf(Map)
  })

  it('rejects a codec missing either half at construction', () => {
    expect(() =>
      defineQueries([
        {
          name: 'views',
          every: '5m',
          codec: { encode: (v: unknown) => v } as never,
          fetch: async () => 'v1',
        },
      ]),
    ).toThrow(ConfigError)
  })

  it('leaves the untouched default exactly as before', async () => {
    const { store, poller } = makeHarness([{ name: 'plain', every: '5m', fetch: async () => 'v1' }])
    await poller.runDue()
    expect((await store.readResult('plain'))!.data).toBe('v1')
    expect((await poller.read<string>('plain'))!.data).toBe('v1')
  })
})
