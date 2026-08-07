import { describe, expect, it } from 'vitest'

import { FakeClock, flushMicrotasks, RateLimitError } from '../src/index.js'
import type { QueryDef } from '../src/index.js'
import { deferred, makeHarness, stored } from './helpers.js'

const MINUTE = 60_000

const counted = (name: string, calls: Record<string, number>): QueryDef => ({
  name,
  every: '5m',
  source: 'posthog',
  fetch: async () => {
    calls[name] = (calls[name] ?? 0) + 1
    return name
  },
})

describe('a source ceiling both paths obey', () => {
  it('a read miss and a tick draw on the same window', async () => {
    const calls: Record<string, number> = {}
    const { fridge } = makeHarness([counted('scheduled', calls), counted('cold', calls)], {
      sources: { posthog: { limit: { requests: 1, per: '1m' } } },
    })

    // The tick spends the window's single call on whichever query is due.
    const report = await fridge.runDue()
    expect(report.ran).toEqual(['scheduled'])
    expect(report.throttled).toEqual(['cold'])

    // The reader is not a way around the ceiling: the window is spent.
    expect(await fridge.read('cold')).toEqual({ status: 'throttled', retryAt: MINUTE })
    expect(calls).toEqual({ scheduled: 1 })
  })

  it('a reserve keeps the last of the window for whoever is waiting', async () => {
    const calls: Record<string, number> = {}
    const { fridge } = makeHarness(
      [counted('a', calls), counted('b', calls), counted('c', calls)],
      {
        sources: { posthog: { limit: { requests: 3, per: '1m', reserve: 2 } } },
      },
    )

    // Scheduled work sees 3 - 2, so it stops one call into a three-call window.
    const report = await fridge.runDue()
    expect(report.ran).toEqual(['a'])
    expect(report.throttled).toEqual(['b', 'c'])

    // The held-back calls are there for a reader, and only for a reader.
    expect(stored(await fridge.read('b'))).toMatchObject({ data: 'b' })
    expect(stored(await fridge.read('c'))).toMatchObject({ data: 'c' })
    expect(calls).toEqual({ a: 1, b: 1, c: 1 })
  })

  it('a throttled tick leaves the row untouched, so the next window finds it more overdue', async () => {
    const calls: Record<string, number> = {}
    const { clock, store, fridge } = makeHarness([counted('a', calls), counted('b', calls)], {
      sources: { posthog: { limit: { requests: 1, per: '1m' } } },
    })
    await fridge.runDue()
    expect(await store.readSchedule('b')).toBeNull()

    await clock.advance(MINUTE)
    expect((await fridge.runDue()).ran).toEqual(['b'])
    expect(calls).toEqual({ a: 1, b: 1 })
  })
})

describe('a read that runs out of quota', () => {
  const slowRead = (name: string, calls: Record<string, number>): QueryDef => ({
    ...counted(name, calls),
    timeout: '2m',
    lease: '5m',
  })

  it('waits for the window to roll when its own timeout allows, then fetches', async () => {
    const calls: Record<string, number> = {}
    const { clock, fridge } = makeHarness([slowRead('a', calls), slowRead('cold', calls)], {
      sources: { posthog: { limit: { requests: 1, per: '1m' } } },
    })
    await fridge.runDue()

    const read = fridge.read<string>('cold')
    await flushMicrotasks()
    expect(calls).toEqual({ a: 1 })

    // Its 2m timeout outlasts the window, so it waits rather than giving up.
    await clock.advance(MINUTE)
    expect(stored(await read)).toMatchObject({ data: 'cold' })
    expect(calls).toEqual({ a: 1, cold: 1 })
  })

  it('answers throttled, not null, when the window outlasts the reader', async () => {
    const calls: Record<string, number> = {}
    // 30s into the window, so a 30s default timeout cannot reach the next one.
    const clock = new FakeClock(30_000)
    const { fridge } = makeHarness([counted('a', calls), counted('cold', calls)], {
      clock,
      sources: { posthog: { limit: { requests: 1, per: '1m' } } },
    })
    await fridge.runDue()

    const throttled = await fridge.read('cold')
    expect(throttled).toEqual({ status: 'throttled', retryAt: MINUTE })
    // Nothing is wrong and nothing is missing - it is only not this reader's turn.
    expect(calls).toEqual({ a: 1 })
  })
})

describe('a dispatch that never reaches upstream', () => {
  it('hands its quota slot back when it loses the claim', async () => {
    const calls: Record<string, number> = {}
    const { store, fridge } = makeHarness([counted('q', calls)], {
      sources: { posthog: { limit: { requests: 1, per: '1m' } } },
    })
    // Somebody else holds the lease, so this tick claims nothing, calls nothing,
    // and must cost the window nothing.
    await store.claim('q', 0, 100_000, 0)

    expect((await fridge.runDue()).skippedLeased).toEqual(['q'])
    expect(calls).toEqual({})
    expect(await store.takeQuota('posthog', 1, MINUTE, 0)).toBe(true)
  })

  it('keeps the slot spent when the call did happen and only the write-back lost', async () => {
    const calls: Record<string, number> = {}
    const { store, fridge } = makeHarness([counted('q', calls)], {
      sources: { posthog: { limit: { requests: 1, per: '1m' } } },
    })
    const report = await fridge.runDue()

    expect(report.ran).toEqual(['q'])
    expect(calls).toEqual({ q: 1 })
    expect(await store.takeQuota('posthog', 1, MINUTE, 0)).toBe(false)
  })
})

describe('maxConcurrent', () => {
  it('does not count a call waiting out a window against the in-flight budget', async () => {
    const calls: Record<string, number> = {}
    const cold: QueryDef = { ...counted('cold', calls), timeout: '2m', lease: '5m' }
    const { clock, fridge } = makeHarness(
      [counted('spender', calls), cold, counted('other', calls)],
      { sources: { posthog: { limit: { requests: 1, per: '1m' }, maxConcurrent: 1 } } },
    )
    expect((await fridge.runDue()).ran).toEqual(['spender'])

    // This reader outlasts the window, so it sleeps until the window rolls.
    const read = fridge.read<string>('cold')
    await flushMicrotasks(200)

    // The sleeper is not a call in flight, so the one slot is free and the tick
    // gets its answer now instead of in fifty-nine seconds.
    let settled = false
    const run = fridge.runDue().then((report) => {
      settled = true
      return report
    })
    await flushMicrotasks(200)
    expect(settled).toBe(true)
    expect((await run).throttled.toSorted()).toEqual(['cold', 'other'])

    await clock.advance(MINUTE)
    expect(stored(await read)).toMatchObject({ data: 'cold' })
  })

  it('smooths a burst without reducing how much gets done', async () => {
    const gates = { a: deferred<string>(), b: deferred<string>(), c: deferred<string>() }
    let inFlight = 0
    let peak = 0
    const gated = (name: keyof typeof gates): QueryDef => ({
      name,
      every: '5m',
      source: 'posthog',
      timeout: '5m',
      lease: '10m',
      fetch: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        try {
          return await gates[name].promise
        } finally {
          inFlight -= 1
        }
      },
    })
    const { fridge } = makeHarness([gated('a'), gated('b'), gated('c')], {
      sources: { posthog: { maxConcurrent: 1 } },
    })

    const run = fridge.runDue()
    await flushMicrotasks()
    expect(inFlight).toBe(1)

    for (const gate of [gates.a, gates.b, gates.c]) {
      gate.resolve('done')
      await flushMicrotasks()
    }

    expect((await run).ran.toSorted()).toEqual(['a', 'b', 'c'])
    expect(peak).toBe(1)
  })
})

describe('RateLimitError', () => {
  it('retries when upstream said to, instead of on the generic curve', async () => {
    const { store, fridge } = makeHarness([
      {
        name: 'q',
        every: '60m',
        fetch: async () => {
          throw new RateLimitError('429 from upstream', { retryAfterMs: 5_000 })
        },
      },
    ])
    await fridge.runDue()

    // The generic first backoff is a minute; the vendor asked for five seconds.
    expect(await store.readSchedule('q')).toMatchObject({ nextRunAt: 5_000, failCount: 1 })
  })

  it('falls back to the backoff curve when it names no retry time', async () => {
    const { store, fridge } = makeHarness([
      {
        name: 'q',
        every: '60m',
        fetch: async () => {
          throw new RateLimitError('429 from upstream')
        },
      },
    ])
    await fridge.runDue()

    expect(await store.readSchedule('q')).toMatchObject({ nextRunAt: MINUTE, failCount: 1 })
  })
})
