import { createFridge, createReader, FakeClock } from '@datafridge/core'
import type {
  Driver,
  QueryDef,
  ReadResult,
  SourcePolicy,
  Store,
  ThrottledRead,
} from '@datafridge/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureSchema, postgresStore } from '../src/index.js'
import { eachBackend, withPostgres } from './backends.js'

const START = 1_700_000_000_000

const driver: Driver = { serialized: false, defer: () => undefined }

function stored<T>(result: ReadResult<T> | ThrottledRead | null): ReadResult<T> | null {
  if (result !== null && result.status === 'throttled') {
    throw new Error(`expected a stored read, got throttled until ${result.retryAt}`)
  }
  return result
}

function fridgeOver(
  store: Store,
  queries: readonly QueryDef[],
  sources?: Record<string, SourcePolicy>,
) {
  return createFridge({
    store,
    driver,
    queries,
    clock: new FakeClock(START),
    random: () => 0,
    ...(sources ? { sources } : {}),
  })
}

eachBackend((backend) => {
  beforeEach(async () => {
    await backend().drop()
  })

  describe('the engine over postgresStore', () => {
    it('a tick against an empty database fills it, and a reader serves what it wrote', async () => {
      const queries: QueryDef[] = [
        { name: 'funnel', every: '5m', fetch: async () => ({ steps: [10, 4, 1] }) },
      ]
      const report = await fridgeOver(postgresStore(backend().db), queries).runDue()
      expect(report.ran).toEqual(['funnel'])
      expect(report.nextRunAt).toBe(START + 300_000)

      const read = stored(await createReader({ store: postgresStore(backend().db) }).read('funnel'))
      expect(read).toMatchObject({ data: { steps: [10, 4, 1] }, fetchedAt: START })
    })

    it('a reader holding the whole store fills a cold read itself, leaving an ordinary row', async () => {
      const store = postgresStore(backend().db)
      const reader = createReader({
        store,
        clock: new FakeClock(START),
        queries: [{ name: 'funnel', every: '5m', fetch: async () => ({ ok: true }) }],
      })
      expect(stored(await reader.read('funnel'))?.data).toEqual({ ok: true })
      expect(await store.readSchedule('funnel')).toMatchObject({ version: 1, failCount: 0 })
    })
  })
})

withPostgres((backend) => {
  beforeEach(async () => {
    await ensureSchema(backend().pool)
    await backend().wipe()
  })

  describe('two executors with pools of their own', () => {
    const executors = () =>
      [postgresStore(backend().openPool()), postgresStore(backend().openPool())] as const

    it('make one upstream call per due query between them', async () => {
      const calls = new Map<string, number>()
      const queries: QueryDef[] = Array.from({ length: 12 }, (_, i) => ({
        name: `q${i}`,
        every: '5m',
        fetch: async () => {
          calls.set(`q${i}`, (calls.get(`q${i}`) ?? 0) + 1)
          return i
        },
      }))
      const [a, b] = executors()
      const reports = await Promise.all([
        fridgeOver(a, queries).runDue(),
        fridgeOver(b, queries).runDue(),
      ])

      expect(calls.size).toBe(12)
      expect([...calls.values()].every((count) => count === 1)).toBe(true)
      expect(reports.flatMap((report) => report.ran).sort()).toEqual(
        queries.map((query) => query.name).sort(),
      )
    })

    it('share one source ceiling', async () => {
      let calls = 0
      const queries: QueryDef[] = Array.from({ length: 10 }, (_, i) => ({
        name: `q${i}`,
        every: '5m',
        source: 'posthog',
        fetch: async () => ++calls,
      }))
      const sources = { posthog: { limit: { requests: 3, per: '1m' as const } } }
      const [a, b] = executors()
      await Promise.all([
        fridgeOver(a, queries, sources).runDue(),
        fridgeOver(b, queries, sources).runDue(),
      ])
      // A slot handed back by an executor that lost the claim is not asked for
      // again this tick, so the pair may land under the ceiling, never over it.
      expect(calls).toBeGreaterThan(0)
      expect(calls).toBeLessThanOrEqual(3)
    })

    it('share one concurrency ceiling', async () => {
      let inFlight = 0
      let peak = 0
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const queries: QueryDef[] = Array.from({ length: 4 }, (_, i) => ({
        name: `q${i}`,
        every: '5m',
        source: 'posthog',
        fetch: async () => {
          peak = Math.max(peak, ++inFlight)
          await gate
          inFlight -= 1
          return i
        },
      }))
      const sources = { posthog: { maxConcurrent: 1 } }
      const [a, b] = executors()
      const first = fridgeOver(a, queries, sources).runDue()
      await vi.waitFor(() => expect(inFlight).toBe(1))

      const second = await fridgeOver(b, queries, sources).runDue()
      expect(second.ran).toEqual([])
      expect(second.deferred.length).toBeGreaterThan(0)

      release()
      expect((await first).ran).toHaveLength(queries.length)
      expect(peak).toBe(1)
    })
  })
})
