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

      it('counts a new result as read when it lands, so retain does not start expired', async () => {
        await store.writeResult('@df/v1/q/aaa', envelope({ fetchedAt: 5_000 }))
        expect(await store.evictIdleResults('@df/v1/q/', 5_000)).toEqual([])
        expect(await store.readResult('@df/v1/q/aaa')).not.toBeNull()
      })

      it('touchResult moves the entry past an eviction it would otherwise fail', async () => {
        await store.writeResult('@df/v1/q/aaa', envelope({ fetchedAt: 1_000 }))
        await store.touchResult('@df/v1/q/aaa', 9_000)
        expect(await store.evictIdleResults('@df/v1/q/', 5_000)).toEqual([])
        expect(await store.readResult('@df/v1/q/aaa')).not.toBeNull()
      })

      it('touchResult on a result that is not there is not an error', async () => {
        await expect(store.touchResult('missing', 1_000)).resolves.not.toThrow()
        expect(await store.readResult('missing')).toBeNull()
      })

      it('does not preserve last_read_at across a rewrite of the same entry', async () => {
        await store.writeResult('@df/v1/q/aaa', envelope({ fetchedAt: 1_000 }))
        await store.touchResult('@df/v1/q/aaa', 9_000)
        // A refresh is not a read: the stamp stays where the reader put it.
        await store.writeResult('@df/v1/q/aaa', envelope({ fetchedAt: 2_000 }))
        expect(await store.evictIdleResults('@df/v1/q/', 5_000)).toEqual([])
      })

      it('evictIdleResults removes only idle entries under the prefix, and names them', async () => {
        await store.writeResult('@df/v1/q/idle', envelope())
        await store.touchResult('@df/v1/q/idle', 1_000)
        await store.writeResult('@df/v1/q/warm', envelope())
        await store.touchResult('@df/v1/q/warm', 9_000)
        await store.writeResult('@df/v1/other/idle', envelope())
        await store.touchResult('@df/v1/other/idle', 1_000)
        await store.writeResult('plain', envelope())
        await store.touchResult('plain', 1_000)

        expect(await store.evictIdleResults('@df/v1/q/', 5_000)).toEqual(['@df/v1/q/idle'])
        expect(await store.readResult('@df/v1/q/idle')).toBeNull()
        expect(await store.readResult('@df/v1/q/warm')).not.toBeNull()
        expect(await store.readResult('@df/v1/other/idle')).not.toBeNull()
        expect(await store.readResult('plain')).not.toBeNull()
      })

      it('evictIdleResults leaves the schedule row alone: the caller owns that half', async () => {
        await store.writeResult('@df/v1/q/idle', envelope())
        await store.touchResult('@df/v1/q/idle', 1_000)
        await store.writeSchedule({
          name: '@df/v1/q/idle',
          nextRunAt: 1_000,
          failCount: 0,
          leaseUntil: null,
          version: 1,
        })
        await store.evictIdleResults('@df/v1/q/', 5_000)
        expect(await store.readSchedule('@df/v1/q/idle')).not.toBeNull()
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
    })
  })
}
