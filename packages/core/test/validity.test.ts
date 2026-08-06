import { describe, expect, it } from 'vitest'

import { FakeClock } from '../src/index.js'
import { makeHarness } from './helpers.js'

const HOUR = 3_600_000

// "Today's traffic": the window ends at the next hour boundary here, so the
// tests stay short. Fetched at 0:59 it is still today's; at 1:01 it is not,
// however fresh it is by age.
function windowQuery(everyMs = 900_000) {
  return {
    name: 'today',
    every: everyMs,
    validUntil: ({ now }: { now: number }) => Math.ceil((now + 1) / HOUR) * HOUR,
    fetch: async () => 'window-data',
  }
}

describe('validUntil', () => {
  it('stores the boundary and reports invalid once it passes, still serving the data', async () => {
    const clock = new FakeClock(HOUR - 60_000)
    const { poller, store } = makeHarness([windowQuery()], { clock })
    await poller.runDue()

    expect((await store.readResult('today'))!.validUntil).toBe(HOUR)
    expect(await poller.read('today')).toMatchObject({ status: 'ok', validUntil: HOUR })

    await clock.advance(120_000)
    const after = await poller.read<string>('today')
    expect(after).toMatchObject({ status: 'invalid', data: 'window-data', isStale: false })
  })

  it('schedules the re-fetch at the boundary instead of a full period later', async () => {
    const clock = new FakeClock(HOUR - 60_000)
    const { poller, store } = makeHarness([windowQuery()], { clock })
    await poller.runDue()

    // A 15m period would land past the boundary; the boundary wins.
    expect((await store.readSchedule('today'))!.nextRunAt).toBe(HOUR)

    await clock.advance(60_000)
    await poller.runDue()
    const second = await store.readResult('today')
    expect(second!.fetchedAt).toBe(HOUR)
    expect(second!.validUntil).toBe(2 * HOUR)
    expect(await poller.read('today')).toMatchObject({ status: 'ok' })
  })

  it('keeps the periodic schedule when the boundary is further away', async () => {
    const clock = new FakeClock(0)
    const { poller, store } = makeHarness([windowQuery(900_000)], { clock })
    await poller.runDue()
    expect((await store.readSchedule('today'))!.nextRunAt).toBe(900_000)
  })

  it('stale-if-error across the boundary: old data served as invalid with the error attached', async () => {
    const clock = new FakeClock(HOUR - 60_000)
    let fail = false
    const { poller } = makeHarness(
      [
        {
          name: 'today',
          every: 900_000,
          validUntil: ({ now }: { now: number }) => Math.ceil((now + 1) / HOUR) * HOUR,
          fetch: async () => {
            if (fail) throw new Error('upstream down')
            return 'window-data'
          },
        },
      ],
      { clock },
    )
    await poller.runDue()
    fail = true
    await clock.advance(60_000)
    await poller.runDue()

    const read = await poller.read<string>('today')
    expect(read).toMatchObject({
      status: 'invalid',
      data: 'window-data',
      lastError: { message: 'upstream down', count: 1 },
    })
  })

  it('an expired window triggers the background refresh hook, like staleness does', async () => {
    const clock = new FakeClock(HOUR - 60_000)
    const { poller } = makeHarness([windowQuery()], { clock })
    await poller.runDue()
    await clock.advance(120_000)

    const refreshes: Promise<void>[] = []
    const read = await poller.read<string>('today', undefined, {
      swrRefresh: (p) => refreshes.push(p),
    })
    expect(read).toMatchObject({ status: 'invalid' })
    expect(refreshes).toHaveLength(1)
    await Promise.all(refreshes)
    expect(await poller.read('today')).toMatchObject({ status: 'ok' })
  })

  it('a non-finite boundary is a failure, not a corrupt envelope', async () => {
    const { poller, store } = makeHarness([
      {
        name: 'today',
        every: '15m',
        validUntil: () => Number.NaN,
        fetch: async () => 'window-data',
      },
    ])
    const report = await poller.runDue()
    expect(report.failed[0]!.message).toMatch(/finite epoch-ms/)
    expect(await store.readResult('today')).toBeNull()
  })
})
