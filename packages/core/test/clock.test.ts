import { describe, expect, it } from 'vitest'

import { FakeClock, systemClock } from '../src/index.js'

describe('systemClock', () => {
  it('reads the wall clock', () => {
    const before = Date.now()
    const now = systemClock.now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })

  it('schedules and cancels real timers', async () => {
    let fired = false
    const cancelled = systemClock.setTimeout(() => (fired = true), 0)
    systemClock.clearTimeout(cancelled)

    await new Promise<void>((resolve) => systemClock.setTimeout(resolve, 0))
    expect(fired).toBe(false)
  })
})

describe('FakeClock', () => {
  it('starts at the given time and advances', async () => {
    const clock = new FakeClock(1_000)
    expect(clock.now()).toBe(1_000)
    await clock.advance(500)
    expect(clock.now()).toBe(1_500)
  })

  it('fires timers in due order at their scheduled time', async () => {
    const clock = new FakeClock()
    const fired: Array<[string, number]> = []
    clock.setTimeout(() => fired.push(['b', clock.now()]), 200)
    clock.setTimeout(() => fired.push(['a', clock.now()]), 100)
    await clock.advance(300)
    expect(fired).toEqual([
      ['a', 100],
      ['b', 200],
    ])
  })

  it('does not fire timers beyond the advance window', async () => {
    const clock = new FakeClock()
    let fired = false
    clock.setTimeout(() => (fired = true), 1_000)
    await clock.advance(999)
    expect(fired).toBe(false)
    await clock.advance(1)
    expect(fired).toBe(true)
  })

  it('clearTimeout cancels a pending timer', async () => {
    const clock = new FakeClock()
    let fired = false
    const handle = clock.setTimeout(() => (fired = true), 100)
    clock.clearTimeout(handle)
    await clock.advance(200)
    expect(fired).toBe(false)
  })

  it('lets promise chains settle between timer firings', async () => {
    const clock = new FakeClock()
    let settled = false
    clock.setTimeout(() => {
      void Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => (settled = true))
    }, 50)
    await clock.advance(50)
    expect(settled).toBe(true)
  })
})
