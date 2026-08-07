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
    const { fridge, store } = makeHarness([windowQuery()], { clock })
    await fridge.runDue()

    expect((await store.readResult('today'))!.validUntil).toBe(HOUR)
    expect(await fridge.read('today')).toMatchObject({ status: 'ok', validUntil: HOUR })

    await clock.advance(120_000)
    const after = await fridge.read<string>('today')
    expect(after).toMatchObject({ status: 'invalid', data: 'window-data', isStale: false })
  })

  it('schedules the re-fetch at the boundary instead of a full period later', async () => {
    const clock = new FakeClock(HOUR - 60_000)
    const { fridge, store } = makeHarness([windowQuery()], { clock })
    await fridge.runDue()

    // A 15m period would land past the boundary; the boundary wins.
    expect((await store.readSchedule('today'))!.nextRunAt).toBe(HOUR)

    await clock.advance(60_000)
    await fridge.runDue()
    const second = await store.readResult('today')
    expect(second!.fetchedAt).toBe(HOUR)
    expect(second!.validUntil).toBe(2 * HOUR)
    expect(await fridge.read('today')).toMatchObject({ status: 'ok' })
  })

  it('keeps the periodic schedule when the boundary is further away', async () => {
    const clock = new FakeClock(0)
    const { fridge, store } = makeHarness([windowQuery(900_000)], { clock })
    await fridge.runDue()
    expect((await store.readSchedule('today'))!.nextRunAt).toBe(900_000)
  })

  it('stale-if-error across the boundary: old data served as invalid with the error attached', async () => {
    const clock = new FakeClock(HOUR - 60_000)
    let fail = false
    const { fridge } = makeHarness(
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
    await fridge.runDue()
    fail = true
    await clock.advance(60_000)
    await fridge.runDue()

    const read = await fridge.read<string>('today')
    expect(read).toMatchObject({
      status: 'invalid',
      data: 'window-data',
      lastError: { message: 'upstream down', count: 1 },
    })
  })

  it('serves an expired window without re-fetching; the boundary run is the scheduler’s', async () => {
    const clock = new FakeClock(HOUR - 60_000)
    let fetches = 0
    const { fridge } = makeHarness(
      [{ ...windowQuery(), fetch: async () => `window-data-${++fetches}` }],
      { clock },
    )
    await fridge.runDue()
    await clock.advance(120_000)

    expect(await fridge.read<string>('today')).toMatchObject({ status: 'invalid' })
    expect(fetches).toBe(1)

    await fridge.runDue()
    expect(await fridge.read<string>('today')).toMatchObject({ status: 'ok' })
  })

  it('a boundary already behind keeps the ordinary period instead of re-fetching every tick', async () => {
    // A variant naming a past date: the window closed before the data landed.
    const clock = new FakeClock(HOUR)
    let fetches = 0
    const { fridge, store } = makeHarness(
      [
        {
          name: 'yesterday',
          every: '15m',
          validUntil: () => HOUR - 1,
          fetch: async () => {
            fetches += 1
            return 'closed-window'
          },
        },
      ],
      { clock },
    )
    await fridge.runDue()
    expect((await store.readSchedule('yesterday'))!.nextRunAt).toBe(HOUR + 900_000)
    expect(await fridge.read('yesterday')).toMatchObject({
      status: 'invalid',
      data: 'closed-window',
    })

    // No tick-every-time loop: the next run is a period away, not immediate.
    await clock.advance(1_000)
    expect((await fridge.runDue()).ran).toEqual([])
    expect(fetches).toBe(1)
  })

  it('a boundary exactly at completion is a closed window, not a zero-length period', async () => {
    const clock = new FakeClock(HOUR)
    const { fridge, store } = makeHarness(
      [
        {
          name: 'edge',
          every: '15m',
          validUntil: ({ now }: { now: number }) => now,
          fetch: async () => 'edge-data',
        },
      ],
      { clock },
    )
    await fridge.runDue()
    expect((await store.readSchedule('edge'))!.nextRunAt).toBe(HOUR + 900_000)
    expect(await fridge.read('edge')).toMatchObject({ status: 'invalid' })
  })

  it('a non-finite boundary is a failure, not a corrupt envelope', async () => {
    const { fridge, store } = makeHarness([
      {
        name: 'today',
        every: '15m',
        validUntil: () => Number.NaN,
        fetch: async () => 'window-data',
      },
    ])
    const report = await fridge.runDue()
    expect(report.failed[0]!.message).toMatch(/finite epoch-ms/)
    expect(await store.readResult('today')).toBeNull()
  })
})
