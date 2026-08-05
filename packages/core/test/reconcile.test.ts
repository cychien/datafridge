import { describe, expect, it } from 'vitest'

import { FakeClock, memoryStore } from '../src/index.js'
import { makeHarness } from './helpers.js'

describe('registry reconcile', () => {
  it('deletes rows and envelopes for removed queries, creates rows for new ones, recomputes nextRunAt on an every change', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const calls = { q1: 0, q2: 0, q3: 0 }

    const pollerA = makeHarness(
      [
        { name: 'q1', every: '60m', fetch: async () => `q1:${++calls.q1}` },
        { name: 'q2', every: '5m', fetch: async () => `q2:${++calls.q2}` },
      ],
      { clock, store },
    ).poller
    expect((await pollerA.runDue()).ran).toEqual(['q1', 'q2'])
    expect(await store.readSchedule('q1')).toMatchObject({ nextRunAt: 3_600_000 })

    const pollerB = makeHarness(
      [
        { name: 'q1', every: '5m', fetch: async () => `q1:${++calls.q1}` },
        { name: 'q3', every: '5m', fetch: async () => `q3:${++calls.q3}` },
      ],
      { clock, store },
    ).poller

    await clock.advance(1_000)
    const report = await pollerB.runDue()

    expect(report.ran).toEqual(['q3'])
    expect(await store.readSchedule('q2')).toBeNull()
    expect(await store.readResult('q2')).toBeNull()
    expect(await store.readSchedule('q1')).toMatchObject({
      nextRunAt: 300_000,
      failCount: 0,
      version: 1,
    })
    expect(await store.readSchedule('q3')).toMatchObject({ nextRunAt: 301_000, version: 1 })
    expect(calls).toEqual({ q1: 1, q2: 1, q3: 1 })

    await clock.advance(299_000)
    expect((await pollerB.runDue()).ran).toEqual(['q1'])
    expect(await store.readSchedule('q1')).toMatchObject({ nextRunAt: 600_000, version: 2 })
    expect(calls.q1).toBe(2)
  })

  it('leaves backoff scheduling untouched during reconcile', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const failing = async () => {
      throw new Error('down')
    }
    const pollerA = makeHarness([{ name: 'q', every: '60m', fetch: failing }], {
      clock,
      store,
    }).poller
    await pollerA.runDue()
    const afterFail = await store.readSchedule('q')
    expect(afterFail).toMatchObject({ failCount: 1, nextRunAt: 60_000 })

    const pollerB = makeHarness([{ name: 'q', every: '5m', fetch: failing }], {
      clock,
      store,
    }).poller
    await clock.advance(1_000)
    const report = await pollerB.runDue()
    expect(report.ran).toEqual([])
    expect(await store.readSchedule('q')).toMatchObject({ failCount: 1, nextRunAt: 60_000 })
  })

  it('does not rewrite healthy rows whose first-run jitter is within tolerance', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const { poller } = makeHarness([{ name: 'q', every: '5m', fetch: async () => 'v1' }], {
      clock,
      store,
      random: () => 0.999,
    })
    await poller.runDue()
    const seeded = await store.readSchedule('q')
    expect(seeded!.nextRunAt).toBeGreaterThan(300_000)

    await clock.advance(1_000)
    await poller.runDue()
    expect(await store.readSchedule('q')).toEqual(seeded)
  })
})
