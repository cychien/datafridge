import { describe, expect, it } from 'vitest'

import { FakeClock, flushMicrotasks, memoryStore, TimeoutError } from '../src/index.js'
import type { FetchCtx, Store } from '../src/index.js'
import { deferred, makeHarness } from './helpers.js'

describe('runDue', () => {
  it('cold start: no records means everything is due, first run schedules with jitter', async () => {
    let aCalls = 0
    let bCalls = 0
    const { clock, store, poller } = makeHarness(
      [
        { name: 'a', every: '5m', fetch: async () => `a${++aCalls}` },
        { name: 'b', every: '10m', fetch: async () => `b${++bCalls}` },
      ],
      { random: () => 0.5 },
    )

    const report = await poller.runDue()

    expect(report.ran).toEqual(['a', 'b'])
    expect([aCalls, bCalls]).toEqual([1, 1])
    const rowA = await store.readSchedule('a')
    const rowB = await store.readSchedule('b')
    expect(rowA).toMatchObject({ nextRunAt: 315_000, failCount: 0, leaseUntil: null, version: 1 })
    expect(rowB).toMatchObject({ nextRunAt: 630_000, failCount: 0, leaseUntil: null, version: 1 })
    const envA = await store.readResult('a')
    expect(envA).toEqual({ data: 'a1', fetchedAt: 0, freshUntil: 300_000 })
    expect(clock.now()).toBe(0)
  })

  it('budget squeeze: the deferred query is picked up on the next tick', async () => {
    const calls = { p1: 0, p2: 0, p3: 0 }
    const { clock, poller } = makeHarness(
      (['p1', 'p2', 'p3'] as const).map((name) => ({
        name,
        every: '5m' as const,
        source: 'posthog',
        fetch: async () => ++calls[name],
      })),
      { sources: { posthog: { maxPerTick: 2 } } },
    )

    const first = await poller.runDue()
    expect(first.ran).toEqual(['p1', 'p2'])
    expect(first.deferredBudget).toEqual(['p3'])
    expect(calls).toEqual({ p1: 1, p2: 1, p3: 0 })

    await clock.advance(60_000)
    const second = await poller.runDue()
    expect(second.ran).toEqual(['p3'])
    expect(second.deferredBudget).toEqual([])
    expect(calls).toEqual({ p1: 1, p2: 1, p3: 1 })
  })

  it('orders by overdue ratio: a 5m query late by 4m beats a 60m query late by 5m', async () => {
    const { store, poller } = makeHarness(
      [
        { name: 'hourly', every: '60m', source: 's', fetch: async () => 'h' },
        { name: 'fast', every: '5m', source: 's', fetch: async () => 'f' },
      ],
      { clock: new FakeClock(1_000_000), sources: { s: { maxPerTick: 1 } } },
    )
    await store.writeSchedule({
      name: 'hourly',
      nextRunAt: 700_000,
      failCount: 0,
      leaseUntil: null,
      version: 1,
    })
    await store.writeSchedule({
      name: 'fast',
      nextRunAt: 760_000,
      failCount: 0,
      leaseUntil: null,
      version: 1,
    })

    const report = await poller.runDue()
    expect(report.ran).toEqual(['fast'])
    expect(report.deferredBudget).toEqual(['hourly'])
  })

  it('fixed-delay: a slow query reschedules from completion time, never piling up', async () => {
    const slow = deferred<string>()
    const { clock, store, poller } = makeHarness([
      { name: 'q', every: '5m', timeout: '3m', fetch: () => slow.promise },
    ])

    const pending = poller.runDue()
    await flushMicrotasks()
    await clock.advance(120_000)
    slow.resolve('v1')
    const report = await pending

    expect(report.ran).toEqual(['q'])
    expect(await store.readSchedule('q')).toMatchObject({
      nextRunAt: 420_000,
      failCount: 0,
      leaseUntil: null,
    })
    expect(await store.readResult('q')).toEqual({
      data: 'v1',
      fetchedAt: 120_000,
      freshUntil: 420_000,
    })
  })

  it('stale-if-error: a failed refresh keeps the old envelope and read() reports stale', async () => {
    let fail = false
    const { clock, store, poller } = makeHarness([
      {
        name: 'q',
        every: '5m',
        fetch: async () => {
          if (fail) throw new Error('boom')
          return 'v1'
        },
      },
    ])

    await poller.runDue()
    fail = true
    await clock.advance(300_000)
    const report = await poller.runDue()

    expect(report.failed).toEqual([{ name: 'q', message: 'boom' }])
    expect(await store.readResult('q')).toEqual({
      data: 'v1',
      fetchedAt: 0,
      freshUntil: 300_000,
      lastError: { at: 300_000, message: 'boom', count: 1 },
    })
    expect(await store.readSchedule('q')).toMatchObject({ failCount: 1, leaseUntil: null })

    const result = await poller.read<string>('q')
    expect(result).toEqual({
      data: 'v1',
      fetchedAt: 0,
      isStale: true,
      status: 'ok',
      age: 300_000,
      lastError: { at: 300_000, message: 'boom', count: 1 },
    })
  })

  it('backoff curve: 1m, 2m, 4m doubling, capped at every, reset on success', async () => {
    let fail = true
    const attempts: number[] = []
    const { clock, store, poller } = makeHarness([
      {
        name: 'q',
        every: '1h',
        fetch: async ({ attempt }: FetchCtx) => {
          attempts.push(attempt)
          if (fail) throw new Error('down')
          return 'up'
        },
      },
    ])

    const backoffs: number[] = []
    for (let i = 0; i < 7; i++) {
      await poller.runDue()
      const row = (await store.readSchedule('q'))!
      backoffs.push(row.nextRunAt - clock.now())
      await clock.advance(row.nextRunAt - clock.now())
    }
    expect(backoffs).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000])
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7])

    fail = false
    await poller.runDue()
    const row = (await store.readSchedule('q'))!
    expect(row.failCount).toBe(0)
    expect(row.nextRunAt).toBe(clock.now() + 3_600_000)
    expect(attempts.at(-1)).toBe(8)
  })

  it('timeout: the AbortSignal fires and the run is recorded as failed', async () => {
    let signal: AbortSignal | undefined
    const { clock, store, poller } = makeHarness([
      {
        name: 'q',
        every: '5m',
        fetch: ({ signal: s }: FetchCtx) => {
          signal = s
          return new Promise<never>(() => undefined)
        },
      },
    ])

    const pending = poller.runDue()
    await flushMicrotasks()
    expect(signal!.aborted).toBe(false)
    await clock.advance(30_000)
    const report = await pending

    expect(signal!.aborted).toBe(true)
    expect(signal!.reason).toBeInstanceOf(TimeoutError)
    expect(report.failed).toEqual([{ name: 'q', message: "query 'q' timed out after 30000ms" }])
    expect(await store.readSchedule('q')).toMatchObject({
      failCount: 1,
      leaseUntil: null,
      nextRunAt: 90_000,
    })
    expect(await store.readResult('q')).toBeNull()
  })

  it('lease skip: a second runDue while the lease is live silently skips', async () => {
    let calls = 0
    const slow = deferred<string>()
    const { poller } = makeHarness([
      {
        name: 'q',
        every: '5m',
        fetch: () => {
          calls++
          return slow.promise
        },
      },
    ])

    const first = poller.runDue()
    await flushMicrotasks()
    const second = await poller.runDue()
    expect(second.skippedLeased).toEqual(['q'])
    expect(second.ran).toEqual([])

    slow.resolve('v1')
    expect((await first).ran).toEqual(['q'])
    expect(calls).toBe(1)
  })

  it('lease expiry: a crashed executor is re-claimed and re-run after the lease lapses', async () => {
    let calls = 0
    let crashWrites = true
    const inner = memoryStore()
    const store: Store = {
      ...inner,
      writeResult: (name, env) => {
        if (crashWrites) throw new Error('process died')
        return inner.writeResult(name, env)
      },
      writeSchedule: (row) => {
        if (crashWrites) throw new Error('process died')
        return inner.writeSchedule(row)
      },
    }
    const { clock, poller } = makeHarness(
      [{ name: 'q', every: '5m', fetch: async () => `v${++calls}` }],
      { store },
    )

    const first = await poller.runDue()
    expect(first.failed).toEqual([{ name: 'q', message: 'process died' }])
    expect(await inner.readResult('q')).toBeNull()
    expect(await inner.readSchedule('q')).toMatchObject({ version: 1, leaseUntil: 60_000 })

    crashWrites = false
    await clock.advance(59_999)
    const tooEarly = await poller.runDue()
    expect(tooEarly.skippedLeased).toEqual(['q'])

    await clock.advance(1)
    const second = await poller.runDue()
    expect(second.ran).toEqual(['q'])
    expect(calls).toBe(2)
    expect(await inner.readResult('q')).toMatchObject({ data: 'v2' })
    expect(await inner.readSchedule('q')).toMatchObject({
      version: 2,
      failCount: 0,
      leaseUntil: null,
      nextRunAt: 360_000,
    })
  })

  it('zombie write-back: a stale executor cannot overwrite the reclaimed result', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let calls = 0
    const gate = deferred<void>()
    let gateArmed = false
    const inner = memoryStore()
    const store: Store = {
      ...inner,
      readSchedule: async (name) => {
        if (gateArmed) {
          gateArmed = false
          await gate.promise
        }
        return inner.readSchedule(name)
      },
    }
    const { clock, poller } = makeHarness(
      [
        {
          name: 'q',
          every: '5m',
          timeout: '10m',
          fetch: () => (++calls === 1 ? first : second).promise,
        },
      ],
      { store },
    )

    const zombieRun = poller.runDue()
    await flushMicrotasks()
    gateArmed = true
    first.resolve('zombie-data')
    await flushMicrotasks()

    await clock.advance(630_001)
    const rerun = poller.runDue()
    await flushMicrotasks()
    second.resolve('fresh-data')
    const rerunReport = await rerun
    expect(rerunReport.ran).toEqual(['q'])

    gate.resolve()
    const zombieReport = await zombieRun
    expect(zombieReport.ran).toEqual([])
    expect(zombieReport.failed).toEqual([
      { name: 'q', message: 'write discarded (lease reclaimed)' },
    ])

    expect(await inner.readResult('q')).toMatchObject({ data: 'fresh-data' })
    expect(await inner.readSchedule('q')).toMatchObject({ version: 2, failCount: 0 })
    expect(calls).toBe(2)
  })

  it('concurrent runDue: each query is fetched exactly once', async () => {
    let calls = 0
    const { poller } = makeHarness([{ name: 'q', every: '5m', fetch: async () => ++calls }])

    const [r1, r2] = await Promise.all([poller.runDue(), poller.runDue()])

    expect(calls).toBe(1)
    expect([...r1.ran, ...r2.ran]).toEqual(['q'])
    expect([...r1.skippedLeased, ...r2.skippedLeased]).toEqual(['q'])
    expect([...r1.failed, ...r2.failed]).toEqual([])
  })

  it('RunReport: ran, skippedLeased, deferredBudget and failed are classified correctly', async () => {
    const t0 = 1_000_000
    const clock = new FakeClock(t0)
    const { store, poller } = makeHarness(
      [
        { name: 'ok', every: '5m', fetch: async () => 'fine' },
        {
          name: 'boom',
          every: '5m',
          fetch: async () => {
            throw new Error('exploded')
          },
        },
        { name: 'leased', every: '5m', fetch: async () => 'never' },
        { name: 'old', every: '5m', source: 'limited', fetch: async () => 'old-data' },
        { name: 'newer', every: '5m', source: 'limited', fetch: async () => 'newer-data' },
      ],
      { clock, sources: { limited: { maxPerTick: 1 } } },
    )
    await store.claim('leased', 0, t0 + 100_000, t0)
    await store.writeSchedule({
      name: 'old',
      nextRunAt: t0 - 240_000,
      failCount: 0,
      leaseUntil: null,
      version: 1,
    })
    await store.writeSchedule({
      name: 'newer',
      nextRunAt: t0 - 30_000,
      failCount: 0,
      leaseUntil: null,
      version: 1,
    })

    const report = await poller.runDue()

    expect(report.ran.toSorted()).toEqual(['ok', 'old'])
    expect(report.skippedLeased).toEqual(['leased'])
    expect(report.deferredBudget).toEqual(['newer'])
    expect(report.failed).toEqual([{ name: 'boom', message: 'exploded' }])
  })
})
