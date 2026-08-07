import { beforeEach, describe, expect, it } from 'vitest'

import type { Envelope, Store } from './types.js'

export type StoreFactory = () => Store | Promise<Store>

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    data: { rows: [1, 2, 3], nested: { label: 'hello' } },
    fetchedAt: 1_000,
    freshUntil: 301_000,
    ...overrides,
  }
}

/**
 * Compatibility suite every Store adapter must pass. Adapters call this from
 * their own vitest file:
 *
 *   storeContractSuite('d1', () => d1(env.DB))
 *
 * Contract points beyond the type signatures:
 * - reads return isolated copies; mutating a returned object never mutates the store
 * - envelopes survive a pure-JSON round trip
 * - claim(name, 0, ...) on a missing row atomically creates and claims it (version 1)
 * - a successful claim bumps version by exactly 1 and sets leaseUntil
 * - claim fails on version mismatch or a live lease; a lease at or before `now` is expired
 * - when capabilities.atomicClaim: concurrent claims admit exactly one winner
 * - when capabilities.listDue: listDue returns rows with nextRunAt <= now, honoring limit
 * - takeQuota counts per source in fixed epoch-aligned windows and never exceeds the limit
 *   it was passed, which varies per call and is therefore never stored
 * - releaseQuota credits back a slot taken in the window the ledger is still on, never
 *   one it has moved past, and never drives usage below zero
 * - listDue is the only enumeration core performs, and it is always given a limit
 * - acquirePermit grants at most `limit` live permits per source and never waits; an
 *   expired permit stops counting, which is how a holder that died is recovered from,
 *   a holder id already holding one is refused rather than sharing or overwriting it,
 *   and a refusal names the soonest a permit could free (or `now` when the source has
 *   room and only the id was in the way)
 * - sweepFlights removes settled flights past their handoff window and running ones past
 *   their expiry, and never a running flight whose expiry is still ahead
 * - joinFlight makes one caller the leader and everyone overlapping it a follower; an
 *   answer is handed only to the generation that waited for it, a caller arriving after
 *   a flight settles starts a new one, and a dead leader is taken over
 */
export function storeContractSuite(label: string, makeStore: StoreFactory): void {
  describe(`store contract: ${label}`, () => {
    let store: Store

    beforeEach(async () => {
      store = await makeStore()
    })

    describe('result plane', () => {
      it('returns null for a result that was never written', async () => {
        expect(await store.readResult('missing')).toBeNull()
      })

      it('round-trips an envelope, including lastError', async () => {
        const env = envelope({ lastError: { at: 2_000, message: 'boom', count: 3 } })
        await store.writeResult('q', env)
        expect(await store.readResult('q')).toEqual(env)
      })

      it('overwrites an existing envelope', async () => {
        await store.writeResult('q', envelope({ data: 'old' }))
        await store.writeResult('q', envelope({ data: 'new', fetchedAt: 5_000 }))
        expect(await store.readResult('q')).toMatchObject({ data: 'new', fetchedAt: 5_000 })
      })

      it('preserves JSON-serializable data exactly', async () => {
        const data = { s: 'x', n: 1.5, b: true, nil: null, arr: [{ deep: [0] }] }
        await store.writeResult('q', envelope({ data }))
        expect((await store.readResult('q'))?.data).toEqual(data)
      })

      it('deleteResult removes the envelope and tolerates unknown names', async () => {
        await store.writeResult('q', envelope())
        await store.deleteResult('q')
        expect(await store.readResult('q')).toBeNull()
        await expect(store.deleteResult('never-existed')).resolves.not.toThrow()
      })

      it('returns isolated copies: mutating a read result does not mutate the store', async () => {
        await store.writeResult('q', envelope({ data: { count: 1 } }))
        const first = (await store.readResult('q'))!
        ;(first.data as { count: number }).count = 999
        first.fetchedAt = 0
        expect(await store.readResult('q')).toEqual(envelope({ data: { count: 1 } }))
      })

      it('keeps variant results apart, so one base cannot read another one', async () => {
        await store.writeResult('@df/v1/q/aaa', envelope({ data: 'mine' }))
        await store.writeResult('@df/v1/other/aaa', envelope({ data: 'theirs' }))
        expect((await store.readResult('@df/v1/q/aaa'))?.data).toBe('mine')
        await store.deleteResult('@df/v1/q/aaa')
        expect(await store.readResult('@df/v1/q/aaa')).toBeNull()
        expect((await store.readResult('@df/v1/other/aaa'))?.data).toBe('theirs')
      })
    })

    describe('schedule plane', () => {
      const row = (overrides: Partial<Parameters<Store['writeSchedule']>[0]> = {}) => ({
        name: 'q',
        nextRunAt: 1_000,
        failCount: 0,
        leaseUntil: null,
        version: 1,
        ...overrides,
      })

      it('returns null for a schedule row that was never written', async () => {
        expect(await store.readSchedule('missing')).toBeNull()
      })

      it('round-trips a schedule row, both leased and unleased', async () => {
        await store.writeSchedule(row())
        expect(await store.readSchedule('q')).toEqual(row())
        await store.writeSchedule(row({ leaseUntil: 9_000, failCount: 2, version: 4 }))
        expect(await store.readSchedule('q')).toEqual(
          row({ leaseUntil: 9_000, failCount: 2, version: 4 }),
        )
      })

      it('round-trips params, and omits them when absent', async () => {
        const params = { courseId: 'c-1', nested: [1, 'two', null, { deep: true }] }
        await store.writeSchedule(row({ params }))
        expect(await store.readSchedule('q')).toEqual(row({ params }))
        await store.writeSchedule(row())
        expect(await store.readSchedule('q')).toEqual(row())
      })

      it('deleteSchedule removes the row and tolerates unknown names', async () => {
        await store.writeSchedule(row())
        await store.deleteSchedule('q')
        expect(await store.readSchedule('q')).toBeNull()
        await expect(store.deleteSchedule('never-existed')).resolves.not.toThrow()
      })

      it('returns isolated copies: mutating a read row does not mutate the store', async () => {
        await store.writeSchedule(row())
        const first = (await store.readSchedule('q'))!
        first.version = 999
        first.nextRunAt = 0
        expect(await store.readSchedule('q')).toEqual(row())
      })

      it('claim with expectedVersion 0 creates and claims a missing row', async () => {
        expect(await store.claim('q', 0, 5_000, 1_000)).toBe(true)
        const created = await store.readSchedule('q')
        expect(created).toMatchObject({
          name: 'q',
          failCount: 0,
          leaseUntil: 5_000,
          version: 1,
        })
        expect(created!.nextRunAt).toBeLessThanOrEqual(1_000)
      })

      it('claim on a missing row fails for a nonzero expectedVersion', async () => {
        expect(await store.claim('q', 3, 5_000, 1_000)).toBe(false)
        expect(await store.readSchedule('q')).toBeNull()
      })

      it('a successful claim bumps version by exactly 1 and sets the lease', async () => {
        await store.writeSchedule(row({ version: 7 }))
        expect(await store.claim('q', 7, 9_000, 2_000)).toBe(true)
        expect(await store.readSchedule('q')).toMatchObject({ version: 8, leaseUntil: 9_000 })
      })

      it('claim fails on a version mismatch and leaves the row untouched', async () => {
        await store.writeSchedule(row({ version: 7 }))
        expect(await store.claim('q', 6, 9_000, 2_000)).toBe(false)
        expect(await store.claim('q', 8, 9_000, 2_000)).toBe(false)
        expect(await store.readSchedule('q')).toEqual(row({ version: 7 }))
      })

      it('claim fails while the lease is live and succeeds once it expires', async () => {
        await store.writeSchedule(row({ leaseUntil: 5_000 }))
        expect(await store.claim('q', 1, 9_000, 4_999)).toBe(false)
        expect(await store.readSchedule('q')).toEqual(row({ leaseUntil: 5_000 }))
        expect(await store.claim('q', 1, 9_000, 5_000)).toBe(true)
        expect(await store.readSchedule('q')).toMatchObject({ version: 2, leaseUntil: 9_000 })
      })

      it('concurrent claims admit exactly one winner (atomicClaim stores)', async () => {
        if (!store.capabilities.atomicClaim) return
        await store.writeSchedule(row({ version: 3 }))
        const outcomes = await Promise.all(
          Array.from({ length: 16 }, () => store.claim('q', 3, 9_000, 2_000)),
        )
        expect(outcomes.filter(Boolean)).toHaveLength(1)
        expect(await store.readSchedule('q')).toMatchObject({ version: 4 })
      })

      it('declares listDue consistently with the implementation', () => {
        expect(store.capabilities.listDue).toBe(typeof store.listDue === 'function')
      })

      it('readSchedules answers in the order asked, with null for what is missing', async () => {
        if (!store.readSchedules) return
        await store.writeSchedule(row({ name: 'one', nextRunAt: 100 }))
        await store.writeSchedule(row({ name: 'two', nextRunAt: 200 }))

        expect(await store.readSchedules(['two', 'missing', 'one'])).toEqual([
          row({ name: 'two', nextRunAt: 200 }),
          null,
          row({ name: 'one', nextRunAt: 100 }),
        ])
        expect(await store.readSchedules([])).toEqual([])
      })

      it('listDue returns only due rows, ordered, honoring the limit (listDue stores)', async () => {
        if (!store.capabilities.listDue || !store.listDue) return
        await store.writeSchedule(row({ name: 'late', nextRunAt: 100 }))
        await store.writeSchedule(row({ name: 'later', nextRunAt: 200 }))
        await store.writeSchedule(row({ name: 'due-now', nextRunAt: 1_000 }))
        await store.writeSchedule(row({ name: 'future', nextRunAt: 1_001 }))

        const due = await store.listDue(1_000, 10)
        expect(due.map((r) => r.name)).toEqual(['late', 'later', 'due-now'])

        const limited = await store.listDue(1_000, 2)
        expect(limited.map((r) => r.name)).toEqual(['late', 'later'])
      })
    })

    describe('quota ledger', () => {
      const WINDOW = 60_000

      it('admits up to the limit within one window and refuses beyond it', async () => {
        for (let i = 0; i < 3; i += 1) {
          expect(await store.takeQuota('posthog', 3, WINDOW, 120_000 + i)).toBe(true)
        }
        expect(await store.takeQuota('posthog', 3, WINDOW, 150_000)).toBe(false)
      })

      it('refuses everything at a limit of zero without recording usage', async () => {
        expect(await store.takeQuota('posthog', 0, WINDOW, 120_000)).toBe(false)
        expect(await store.takeQuota('posthog', 1, WINDOW, 120_000)).toBe(true)
      })

      it('opens the next window at zero, on the epoch-aligned boundary', async () => {
        expect(await store.takeQuota('posthog', 1, WINDOW, 179_999)).toBe(true)
        expect(await store.takeQuota('posthog', 1, WINDOW, 179_999)).toBe(false)
        expect(await store.takeQuota('posthog', 1, WINDOW, 180_000)).toBe(true)
      })

      it('never rewinds a window a later clock has already opened', async () => {
        expect(await store.takeQuota('posthog', 1, WINDOW, 180_000)).toBe(true)
        // An executor whose clock lags must not reopen the previous window and
        // hand the same slot out twice.
        expect(await store.takeQuota('posthog', 1, WINDOW, 179_999)).toBe(false)
      })

      it('honours the limit it is given on each call, rather than remembering one', async () => {
        expect(await store.takeQuota('posthog', 10, WINDOW, 120_000)).toBe(true)
        expect(await store.takeQuota('posthog', 10, WINDOW, 120_000)).toBe(true)
        // Scheduled work sees a lower ceiling than a waiting reader does.
        expect(await store.takeQuota('posthog', 2, WINDOW, 120_000)).toBe(false)
        expect(await store.takeQuota('posthog', 3, WINDOW, 120_000)).toBe(true)
      })

      it('counts each source separately', async () => {
        expect(await store.takeQuota('posthog', 1, WINDOW, 120_000)).toBe(true)
        expect(await store.takeQuota('posthog', 1, WINDOW, 120_000)).toBe(false)
        expect(await store.takeQuota('stripe', 1, WINDOW, 120_000)).toBe(true)
      })

      it('admits exactly the limit under concurrent takes (atomicClaim stores)', async () => {
        if (!store.capabilities.atomicClaim) return
        const outcomes = await Promise.all(
          Array.from({ length: 16 }, () => store.takeQuota('posthog', 5, WINDOW, 120_000)),
        )
        expect(outcomes.filter(Boolean)).toHaveLength(5)
      })

      it('releaseQuota hands a slot back to the window it was taken in', async () => {
        expect(await store.takeQuota('posthog', 1, WINDOW, 120_000)).toBe(true)
        expect(await store.takeQuota('posthog', 1, WINDOW, 120_001)).toBe(false)
        await store.releaseQuota('posthog', WINDOW, 120_000)
        expect(await store.takeQuota('posthog', 1, WINDOW, 120_002)).toBe(true)
      })

      it('releaseQuota leaves a window that has already rolled alone', async () => {
        expect(await store.takeQuota('posthog', 1, WINDOW, 120_000)).toBe(true)
        expect(await store.takeQuota('posthog', 1, WINDOW, 180_000)).toBe(true)
        // The slot belongs to the window it was taken in; the new one keeps its
        // own count rather than being credited with someone else's.
        await store.releaseQuota('posthog', WINDOW, 120_000)
        expect(await store.takeQuota('posthog', 1, WINDOW, 180_001)).toBe(false)
      })

      it('releaseQuota never drives usage below zero, and tolerates an unknown source', async () => {
        await expect(store.releaseQuota('never-used', WINDOW, 120_000)).resolves.not.toThrow()
        expect(await store.takeQuota('posthog', 1, WINDOW, 120_000)).toBe(true)
        await store.releaseQuota('posthog', WINDOW, 120_000)
        await store.releaseQuota('posthog', WINDOW, 120_000)
        expect(await store.takeQuota('posthog', 1, WINDOW, 120_000)).toBe(true)
        expect(await store.takeQuota('posthog', 1, WINDOW, 120_000)).toBe(false)
      })
    })

    describe('concurrency permits', () => {
      const LIVE = 90_000

      it('grants up to the limit and refuses beyond it, per source', async () => {
        expect(await store.acquirePermit('posthog', 2, 'a', LIVE, 1_000)).toEqual({ granted: true })
        expect(await store.acquirePermit('posthog', 2, 'b', LIVE, 1_000)).toEqual({ granted: true })
        expect(await store.acquirePermit('posthog', 2, 'c', LIVE, 1_000)).toEqual({
          granted: false,
          retryAt: LIVE,
        })
        expect(await store.acquirePermit('stripe', 2, 'd', LIVE, 1_000)).toEqual({ granted: true })
      })

      it('names the soonest a permit could free when it refuses', async () => {
        await store.acquirePermit('posthog', 2, 'early', 20_000, 1_000)
        await store.acquirePermit('posthog', 2, 'late', 50_000, 1_000)
        expect(await store.acquirePermit('posthog', 2, 'third', LIVE, 1_000)).toEqual({
          granted: false,
          retryAt: 20_000,
        })
      })

      it('refuses a holder id that is already holding one, and says the source has room', async () => {
        expect(await store.acquirePermit('posthog', 4, 'same', LIVE, 1_000)).toEqual({
          granted: true,
        })
        // One id is one call's claim. A second caller wearing it is still a
        // second caller: it must neither share the row nor overwrite it.
        expect(await store.acquirePermit('posthog', 4, 'same', LIVE, 1_000)).toEqual({
          granted: false,
          retryAt: 1_000,
        })
        // The first holder still has exactly one permit, and releasing once
        // frees exactly one.
        await store.releasePermit('posthog', 'same')
        expect(await store.acquirePermit('posthog', 1, 'other', LIVE, 1_000)).toEqual({
          granted: true,
        })
      })

      it('frees the slot when the holder gives it back', async () => {
        expect(await store.acquirePermit('posthog', 1, 'a', LIVE, 1_000)).toEqual({ granted: true })
        expect(await store.acquirePermit('posthog', 1, 'b', LIVE, 1_000)).toMatchObject({
          granted: false,
        })
        await store.releasePermit('posthog', 'a')
        expect(await store.acquirePermit('posthog', 1, 'b', LIVE, 1_000)).toEqual({ granted: true })
      })

      it('stops counting a holder that died, once its permit expires', async () => {
        expect(await store.acquirePermit('posthog', 1, 'gone', 5_000, 1_000)).toEqual({
          granted: true,
        })
        expect(await store.acquirePermit('posthog', 1, 'next', LIVE, 4_999)).toEqual({
          granted: false,
          retryAt: 5_000,
        })
        // Nobody released it; the expiry is what recovers the slot.
        expect(await store.acquirePermit('posthog', 1, 'next', LIVE, 5_000)).toEqual({
          granted: true,
        })
      })

      it('releasing a permit nobody holds is not an error', async () => {
        await expect(store.releasePermit('posthog', 'never-held')).resolves.not.toThrow()
      })

      it('grants exactly the limit under concurrent acquires (atomicClaim stores)', async () => {
        if (!store.capabilities.atomicClaim) return
        const outcomes = await Promise.all(
          Array.from({ length: 16 }, (_, i) =>
            store.acquirePermit('posthog', 5, `h${i}`, LIVE, 1_000),
          ),
        )
        expect(outcomes.filter((grant) => grant.granted)).toHaveLength(5)
      })

      it('grants exactly one permit to a colliding id under concurrent acquires', async () => {
        if (!store.capabilities.atomicClaim) return
        const outcomes = await Promise.all(
          Array.from({ length: 8 }, () => store.acquirePermit('posthog', 8, 'same', LIVE, 1_000)),
        )
        expect(outcomes.filter((grant) => grant.granted)).toHaveLength(1)
      })
    })

    describe('transient flights', () => {
      const ANSWER = { status: 'ran', data: { rows: 1 } } as const

      it('makes the first caller the leader and everyone overlapping a follower', async () => {
        const first = await store.joinFlight('k', 9_000, 1_000)
        expect(first).toEqual({ role: 'leader', generation: 1 })
        expect(await store.joinFlight('k', 9_000, 1_000)).toEqual({
          role: 'follower',
          generation: 1,
        })
      })

      it('hands the answer to the generation that waited for it', async () => {
        const { generation } = await store.joinFlight('k', 9_000, 1_000)
        expect(await store.readFlight('k', 1_000)).toEqual({ running: generation, settled: null })
        expect(await store.settleFlight('k', generation, ANSWER, 11_000)).toBe(true)
        expect(await store.readFlight('k', 2_000)).toEqual({
          running: null,
          settled: { generation, outcome: ANSWER },
        })
      })

      it('starts a new flight for a caller that arrives after the last one settled', async () => {
        const first = await store.joinFlight('k', 9_000, 1_000)
        await store.settleFlight('k', first.generation, ANSWER, 11_000)
        // A settled answer belongs to the cohort that waited for it.
        const second = await store.joinFlight('k', 20_000, 12_000)
        expect(second).toEqual({ role: 'leader', generation: 2 })
        // And it does not cut off a follower still collecting the old one.
        expect(await store.readFlight('k', 2_000)).toMatchObject({
          running: 2,
          settled: { generation: 1 },
        })
      })

      it('lets the next caller take over a flight whose leader died', async () => {
        const first = await store.joinFlight('k', 5_000, 1_000)
        expect(await store.joinFlight('k', 9_000, 4_999)).toMatchObject({ role: 'follower' })
        expect(await store.joinFlight('k', 20_000, 5_000)).toEqual({
          role: 'leader',
          generation: 2,
        })
        // The flight it lost can no longer hand anybody an answer.
        expect(await store.settleFlight('k', first.generation, ANSWER, 30_000)).toBe(false)
      })

      it('forgets a settled answer once its handoff window closes', async () => {
        const { generation } = await store.joinFlight('k', 9_000, 1_000)
        await store.settleFlight('k', generation, ANSWER, 11_000)
        expect(await store.readFlight('k', 11_000)).toEqual({ running: null, settled: null })
      })

      it('sweeps settled flights past their window, bounded, and keeps live ones', async () => {
        const cold = await store.joinFlight('cold', 9_000, 1_000)
        await store.settleFlight('cold', cold.generation, ANSWER, 5_000)
        await store.joinFlight('live', 90_000, 1_000)

        expect(await store.sweepFlights(6_000, 10)).toBe(1)
        expect(await store.readFlight('cold', 6_000)).toBeNull()
        expect(await store.readFlight('live', 6_000)).toMatchObject({ running: 1 })
        expect(await store.sweepFlights(6_000, 0)).toBe(0)
      })

      it('keeps a running flight until its expiry is behind the sweep', async () => {
        await store.joinFlight('k', 9_000, 1_000)
        // A leader is still entitled to settle right up to its expiry, and the
        // row is the only thing keeping its generation from being handed out
        // again to somebody else.
        expect(await store.sweepFlights(8_999, 10)).toBe(0)
        expect(await store.readFlight('k', 2_000)).toMatchObject({ running: 1 })
        expect(await store.sweepFlights(9_000, 10)).toBe(1)
      })

      it('answers null for a flight nobody has ever joined', async () => {
        expect(await store.readFlight('never', 1_000)).toBeNull()
        expect(await store.settleFlight('never', 1, ANSWER, 9_000)).toBe(false)
      })
    })
  })
}
