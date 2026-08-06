import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { createReader } from '@datafridge/core'
import type { QueryDef } from '@datafridge/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { d1Results } from '../src/d1.js'
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
  return createReader({ results: d1Results(env.DB) })
}

type Stub = ReturnType<typeof pollerStub>

async function configure(stub: Stub, defs: readonly QueryDef[]) {
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
  it('runs due queries, lands envelopes in D1, and re-sets the alarm to min(nextRunAt)', async () => {
    const stub = pollerStub('due')
    await configure(stub, [counting('alpha', '1m'), counting('beta', '5m')])
    await stub.ensureStarted()
    await settled(stub, ['alpha', 'beta'])

    expect(fetchCounts.get('alpha')).toBe(1)
    expect(fetchCounts.get('beta')).toBe(1)

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
