import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { createReader, defineParameterizedQuery, queryKey, variantBaseOf } from '@datafridge/core'
import type { QueryDef, QueryDefinition } from '@datafridge/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { d1 } from '../src/d1.js'
import type { TestPoller } from './worker.js'

const fetchCounts = new Map<string, number>()

function counting(name: string, every: QueryDef['every']): QueryDef {
  return {
    name,
    every,
    fetch: async () => {
      const tick = (fetchCounts.get(name) ?? 0) + 1
      fetchCounts.set(name, tick)
      return { name, tick }
    },
  }
}

function pollerStub(id: string) {
  return env.POLLER.get(env.POLLER.idFromName(id))
}

function reader() {
  return createReader({ store: d1(env.DB) })
}

type Stub = ReturnType<typeof pollerStub>

async function configure(stub: Stub, defs: readonly QueryDefinition[]) {
  await runInDurableObject(stub, async (instance) => {
    ;(instance as TestPoller).queries = defs
  })
}

async function scheduleRows(stub: Stub) {
  return runInDurableObject(stub, async (_instance, state) =>
    state.storage.sql
      .exec<{
        name: string
        next_run_at: number
        fail_count: number
      }>('SELECT name, next_run_at, fail_count FROM datafridge_schedule ORDER BY name')
      .toArray(),
  )
}

async function currentAlarm(stub: Stub) {
  return runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm())
}

// The ignition alarm set by ensureStarted() fires on its own in workerd, so
// the first tick is awaited by polling; later ticks are driven precisely with
// runDurableObjectAlarm on the (far-future) chain alarm.
async function settled(stub: Stub, names: string[]) {
  await vi.waitFor(
    async () => {
      const rows = await scheduleRows(stub)
      expect(rows.map((r) => r.name)).toEqual([...names].sort())
      const now = Date.now()
      for (const row of rows) expect(row.next_run_at).toBeGreaterThan(now)
    },
    { timeout: 5_000 },
  )
}

beforeEach(async () => {
  fetchCounts.clear()
  // Storage isolation is per test file, so wipe the shared D1 between tests;
  // each test uses its own DO instance for fresh bookkeeping.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM datafridge_results'),
    env.DB.prepare('DELETE FROM datafridge_schedule'),
  ])
})

describe('PollerDO alarm loop', () => {
  it('drives dynamic variants: rows come from the table, and the alarm covers them', async () => {
    const stub = pollerStub('dynamic')
    const dynamicDef = defineParameterizedQuery({
      name: 'per-course',
      every: '1m',
      variants: async () => [{ courseId: 'alpha' }],
      fetch: async ({ params }) => ({ course: (params as { courseId: string }).courseId }),
    })
    await runInDurableObject(stub, async (instance) => {
      ;(instance as TestPoller).queries = [dynamicDef]
    })
    await stub.ensureStarted()

    await vi.waitFor(
      async () => {
        const rows = await scheduleRows(stub)
        expect(rows.map((r) => variantBaseOf(r.name))).toEqual(['per-course'])
        expect(rows[0]!.next_run_at).toBeGreaterThan(Date.now())
      },
      { timeout: 5_000 },
    )

    const withRegistry = createReader({ store: d1(env.DB), queries: [dynamicDef] })
    const read = await withRegistry.read<{ course: string }>('per-course', { courseId: 'alpha' })
    expect(read).not.toBeNull()
    expect(read!.data).toEqual({ course: 'alpha' })

    // The next alarm exists and points at the dynamic row.
    const alarm = await currentAlarm(stub)
    expect(alarm).not.toBeNull()
  })

  it('a failed resolution backs the base off instead of pinning the alarm to its floor', async () => {
    const stub = pollerStub('resolution-backoff')
    let down = false
    const variantKey = queryKey('per-course', { courseId: 'alpha' })
    await configure(stub, [
      defineParameterizedQuery({
        name: 'per-course',
        every: '15m',
        variants: async () => {
          if (down) throw new Error('course db unreachable')
          return [{ courseId: 'alpha' }]
        },
        fetch: async () => ({ ok: true }),
      }),
    ])
    await stub.ensureStarted()
    await settled(stub, [variantKey])

    // The variant is overdue and the course database is down: the old alarm
    // came from that past-due row and re-fired at the 1-second floor forever.
    down = true
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE datafridge_schedule SET next_run_at = ? WHERE name = ?',
        Date.now() - 1_000,
        variantKey,
      )
    })
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true)

    const rows = await scheduleRows(stub)
    const base = rows.find((r) => r.name === 'per-course')!
    expect(base.fail_count).toBe(1)
    // A failed resolution deletes nothing.
    expect(rows.map((r) => r.name)).toContain(variantKey)
    expect(await reader().read('per-course', { courseId: 'alpha' })).not.toBeNull()

    expect(await currentAlarm(stub)).toBe(base.next_run_at)
    expect(base.next_run_at).toBeGreaterThan(Date.now() + 30_000)
  })

  it('runs due queries, lands envelopes in D1, and re-sets the alarm to min(nextRunAt)', async () => {
    const stub = pollerStub('due')
    await configure(stub, [counting('alpha', '1m'), counting('beta', '5m')])
    await stub.ensureStarted()
    await settled(stub, ['alpha', 'beta'])

    expect(fetchCounts.get('alpha')).toBe(1)
    expect(fetchCounts.get('beta')).toBe(1)
    const reports = await runInDurableObject(stub, async (instance) =>
      (instance as TestPoller).reports.map((report) => structuredClone(report)),
    )
    expect(reports).toEqual([
      {
        ran: ['alpha', 'beta'],
        skippedLeased: [],
        deferredBudget: [],
        failed: [],
      },
    ])

    const alpha = await reader().read<{ name: string; tick: number }>('alpha')
    expect(alpha).not.toBeNull()
    expect(alpha!.data).toEqual({ name: 'alpha', tick: 1 })
    expect(alpha!.isStale).toBe(false)
    expect((await reader().read('beta'))!.data).toEqual({ name: 'beta', tick: 1 })

    const rows = await scheduleRows(stub)
    const alarm = await currentAlarm(stub)
    expect(alarm).toBe(Math.min(...rows.map((r) => r.next_run_at)))
    expect(alarm).toBeGreaterThan(Date.now())
  })

  it('keeps alarm-level error details out of logs while continuing the chain', async () => {
    const stub = pollerStub('sanitized-alarm-error')
    await configure(stub, [counting('safe', '1m')])
    await runInDurableObject(stub, async (instance) => {
      ;(instance as TestPoller).reportError = new Error('private payload must not leak')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await stub.ensureStarted()
      await settled(stub, ['safe'])
      await vi.waitFor(() => expect(error).toHaveBeenCalled())

      expect(error).toHaveBeenCalledWith('datafridge: alarm-level failure; alarm chain continues')
      expect(JSON.stringify(error.mock.calls)).not.toContain('private payload')
      expect(await currentAlarm(stub)).not.toBeNull()
    } finally {
      error.mockRestore()
    }
  })

  it('keeps the chain alive when a fetcher throws: no alarm error, failCount recorded', async () => {
    const stub = pollerStub('resilience')
    await configure(stub, [
      {
        name: 'boom',
        every: '1m',
        fetch: async () => {
          throw new Error('upstream down')
        },
      },
      counting('ok', '1m'),
    ])
    await stub.ensureStarted()
    await settled(stub, ['boom', 'ok'])

    expect(fetchCounts.get('ok')).toBe(1)
    expect(await reader().read('boom')).toBeNull()
    expect(await reader().read('ok')).not.toBeNull()

    let rows = await scheduleRows(stub)
    expect(rows.find((r) => r.name === 'boom')!.fail_count).toBe(1)

    // Second tick, driven manually: the fetcher throws inside the alarm
    // handler and the handler still must not throw and must re-arm the chain.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE datafridge_schedule SET next_run_at = ? WHERE name = ?',
        Date.now(),
        'boom',
      )
    })
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true)

    rows = await scheduleRows(stub)
    const boom = rows.find((r) => r.name === 'boom')!
    expect(boom.fail_count).toBe(2)
    expect(boom.next_run_at).toBeGreaterThan(Date.now())

    const alarm = await currentAlarm(stub)
    expect(alarm).not.toBeNull()
    expect(alarm).toBe(Math.min(...rows.map((r) => r.next_run_at)))
  })

  it('serves the stale envelope with lastError once a previously good query starts failing', async () => {
    let shouldFail = false
    const stub = pollerStub('stale')
    await configure(stub, [
      {
        name: 'flaky',
        every: '1m',
        fetch: async () => {
          if (shouldFail) throw new Error('now failing')
          return { fresh: true }
        },
      },
    ])
    await stub.ensureStarted()
    await settled(stub, ['flaky'])
    const good = await reader().read('flaky')
    expect(good!.data).toEqual({ fresh: true })

    shouldFail = true
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE datafridge_schedule SET next_run_at = ? WHERE name = ?',
        Date.now(),
        'flaky',
      )
    })
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true)

    const stale = await reader().read('flaky')
    expect(stale!.data).toEqual({ fresh: true })
    expect(stale!.fetchedAt).toBe(good!.fetchedAt)
    expect(stale!.lastError).toMatchObject({ message: 'now failing', count: 1 })
  })

  it('reconciles runtime parameter variants and stores each envelope independently', async () => {
    const stub = pollerStub('parameterized')
    const query = (courseIds: readonly string[]) =>
      defineParameterizedQuery({
        name: 'course-summary',
        every: '5m',
        variants: courseIds.map((courseId) => ({ courseId, window: '7d' })),
        fetch: async ({ params }) => params.courseId,
      })
    const alpha = { courseId: 'alpha', window: '7d' }
    const beta = { courseId: 'beta', window: '7d' }
    const gamma = { courseId: 'gamma', window: '7d' }

    await configure(stub, [query(['alpha', 'beta'])])
    await stub.ensureStarted()
    await settled(stub, [queryKey('course-summary', alpha), queryKey('course-summary', beta)])
    await expect(reader().read('course-summary', alpha)).resolves.toMatchObject({ data: 'alpha' })
    await expect(reader().read('course-summary', beta)).resolves.toMatchObject({ data: 'beta' })

    await configure(stub, [query(['beta', 'gamma'])])
    await stub.ensureStarted()
    await settled(stub, [queryKey('course-summary', beta), queryKey('course-summary', gamma)])
    await expect(reader().read('course-summary', alpha)).resolves.toBeNull()
    await expect(reader().read('course-summary', beta)).resolves.toMatchObject({ data: 'beta' })
    await expect(reader().read('course-summary', gamma)).resolves.toMatchObject({ data: 'gamma' })
  })

  it('ensureStarted is idempotent: no double chain, no early re-alarm', async () => {
    const stub = pollerStub('idempotent')
    await configure(stub, [counting('solo', '1m')])

    await stub.ensureStarted()
    await stub.ensureStarted()
    await settled(stub, ['solo'])
    expect(fetchCounts.get('solo')).toBe(1)

    const before = await currentAlarm(stub)
    expect(before).not.toBeNull()
    await stub.ensureStarted()
    expect(await currentAlarm(stub)).toBe(before)
    expect(fetchCounts.get('solo')).toBe(1)
  })

  it('rejects a registry whose timeout cannot fit the alarm invocation, at ignition', async () => {
    const stub = pollerStub('timeout-limit')
    await configure(stub, [{ name: 'slow', every: '1h', timeout: '15m', fetch: async () => 0 }])
    // Caught inside the DO so the RPC rejection is not also reported as an
    // unhandled error by workerd.
    const message = await runInDurableObject(stub, async (instance) => {
      try {
        await (instance as TestPoller).ensureStarted()
        return null
      } catch (err) {
        return (err as Error).message
      }
    })
    expect(message).toBe(
      "query 'slow': timeout (900000ms) must be shorter than the 900000ms wall-clock limit " +
        'of a Cloudflare Durable Object alarm invocation; lower the timeout',
    )
  })

  it('rejects an invalid source budget at ignition instead of failing silently each alarm', async () => {
    const stub = pollerStub('invalid-source-budget')
    await configure(stub, [counting('budgeted', '1m')])

    for (const maxPerTick of [0, -1, 1.5]) {
      const result = await runInDurableObject(stub, async (instance) => {
        const poller = instance as TestPoller
        poller.sources = { posthog: { maxPerTick } }
        try {
          await poller.ensureStarted()
          return null
        } catch (err) {
          return { name: (err as Error).name, message: (err as Error).message }
        }
      })
      expect(result).toEqual({
        name: 'ConfigError',
        message: "source 'posthog': maxPerTick must be a positive integer",
      })
    }

    expect(await currentAlarm(stub)).toBeNull()
    expect(await scheduleRows(stub)).toEqual([])
  })

  it('accepts a valid source budget and defers the over-budget query to the next tick', async () => {
    const stub = pollerStub('valid-source-budget')
    await configure(stub, [
      { ...counting('first', '5m'), source: 'posthog' },
      { ...counting('second', '5m'), source: 'posthog' },
    ])
    await runInDurableObject(stub, async (instance) => {
      ;(instance as TestPoller).sources = { posthog: { maxPerTick: 1 } }
    })

    await stub.ensureStarted()
    await settled(stub, ['first', 'second'])

    expect(fetchCounts.get('first')).toBe(1)
    expect(fetchCounts.get('second')).toBe(1)
    const reports = await runInDurableObject(stub, async (instance) =>
      (instance as TestPoller).reports.map((report) => structuredClone(report)),
    )
    expect(reports[0]!.ran).toHaveLength(1)
    expect(reports[0]!.deferredBudget).toHaveLength(1)
    expect(reports.flatMap((report) => report.ran).sort()).toEqual(['first', 'second'])
  })

  it('reconciles a changed registry: adds run, removed rows and envelopes vanish, every changes reschedule', async () => {
    const stub = pollerStub('reconcile')
    await configure(stub, [counting('keep', '5m'), counting('drop', '5m')])
    await stub.ensureStarted()
    await settled(stub, ['drop', 'keep'])
    expect(fetchCounts.get('keep')).toBe(1)
    expect(fetchCounts.get('drop')).toBe(1)
    const keptBefore = await reader().read('keep')

    await configure(stub, [counting('keep', '1m'), counting('added', '1m')])
    await stub.ensureStarted()
    await settled(stub, ['added', 'keep'])

    expect(fetchCounts.get('added')).toBe(1)
    expect(await reader().read('added')).not.toBeNull()

    expect(await reader().read('drop')).toBeNull()
    const rows = await scheduleRows(stub)
    expect(rows.map((r) => r.name)).toEqual(['added', 'keep'])

    // every shrank from 5m to 1m: nextRunAt is recomputed off the existing
    // envelope instead of waiting out the old period.
    const keep = rows.find((r) => r.name === 'keep')!
    expect(keep.next_run_at).toBe(keptBefore!.fetchedAt + 60_000)
    expect(fetchCounts.get('keep')).toBe(1)
  })
})
