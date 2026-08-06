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
  })
}
