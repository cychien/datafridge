import type { Store } from '@datafridge/core'
import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureSchema, postgresStore } from '../src/index.js'
import { withPostgres } from './backends.js'
import type { PostgresBackend } from './backends.js'

const WINDOW = 60_000
const LIVE = 90_000

interface Session {
  client: pg.Client
  store: Store
  pid: number
}

async function session(backend: PostgresBackend): Promise<Session> {
  const client = await backend.connect()
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  return { client, store: postgresStore(client), pid: rows[0]!.pid }
}

/** A peer whose writes are in, row locks held, and not yet committed. */
async function openTransaction(backend: PostgresBackend): Promise<Session> {
  const peer = await session(backend)
  await peer.client.query('BEGIN')
  return peer
}

/** Resolves once `pid` is parked on a lock, which is what proves the race was real. */
async function blockedOnLock(backend: PostgresBackend, pid: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const { rows } = await backend.pool.query<{ wait_event_type: string | null }>(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
        [pid],
      )
      expect(rows[0]?.wait_event_type).toBe('Lock')
    },
    { timeout: 5_000, interval: 10 },
  )
}

withPostgres((backend) => {
  beforeEach(async () => {
    await ensureSchema(backend().pool)
    await backend().wipe()
  })

  describe('a write racing one that has not committed yet', () => {
    it('a claim waits for the peer that claimed first, then loses to it', async () => {
      const store = postgresStore(backend().pool)
      await store.writeSchedule({
        name: 'q',
        nextRunAt: 0,
        failCount: 0,
        leaseUntil: null,
        version: 3,
      })
      const first = await openTransaction(backend())
      expect(await first.store.claim('q', 3, 9_000, 2_000)).toBe(true)

      const second = await session(backend())
      const racing = second.store.claim('q', 3, 9_000, 2_000)
      await blockedOnLock(backend(), second.pid)
      await first.client.query('COMMIT')

      expect(await racing).toBe(false)
      expect(await store.readSchedule('q')).toMatchObject({ version: 4, leaseUntil: 9_000 })
    })

    it('a claim wins once the peer ahead of it rolls back', async () => {
      const store = postgresStore(backend().pool)
      await store.writeSchedule({
        name: 'q',
        nextRunAt: 0,
        failCount: 0,
        leaseUntil: null,
        version: 3,
      })
      const first = await openTransaction(backend())
      expect(await first.store.claim('q', 3, 9_000, 2_000)).toBe(true)

      const second = await session(backend())
      const racing = second.store.claim('q', 3, 7_000, 2_000)
      await blockedOnLock(backend(), second.pid)
      await first.client.query('ROLLBACK')

      expect(await racing).toBe(true)
      expect(await store.readSchedule('q')).toMatchObject({ version: 4, leaseUntil: 7_000 })
    })

    it('two executors creating the same row: one creates it, the other finds it taken', async () => {
      const first = await openTransaction(backend())
      expect(await first.store.claim('fresh', 0, 9_000, 1_000)).toBe(true)

      const second = await session(backend())
      const racing = second.store.claim('fresh', 0, 9_000, 1_000)
      await blockedOnLock(backend(), second.pid)
      await first.client.query('COMMIT')

      expect(await racing).toBe(false)
    })

    it('a quota take queues on the ledger row and sees the slot the peer spent', async () => {
      const first = await openTransaction(backend())
      expect(await first.store.takeQuota('posthog', 1, WINDOW, 120_000)).toBe(true)

      const second = await session(backend())
      const racing = second.store.takeQuota('posthog', 1, WINDOW, 120_001)
      await blockedOnLock(backend(), second.pid)
      await first.client.query('COMMIT')

      expect(await racing).toBe(false)
    })

    it('a quota take behind a peer opening the next window counts against that window', async () => {
      const store = postgresStore(backend().pool)
      expect(await store.takeQuota('posthog', 1, WINDOW, 120_000)).toBe(true)
      const first = await openTransaction(backend())
      expect(await first.store.takeQuota('posthog', 1, WINDOW, 180_000)).toBe(true)

      // Its clock lags into the window the peer just closed.
      const second = await session(backend())
      const racing = second.store.takeQuota('posthog', 2, WINDOW, 179_999)
      await blockedOnLock(backend(), second.pid)
      await first.client.query('COMMIT')

      expect(await racing).toBe(true)
      expect(await store.takeQuota('posthog', 2, WINDOW, 180_001)).toBe(false)
    })

    it('a permit acquire queues on the source and counts the permit just granted', async () => {
      const first = await openTransaction(backend())
      expect(await first.store.acquirePermit('posthog', 1, 'a', 50_000, 1_000)).toEqual({
        granted: true,
      })

      const second = await session(backend())
      const racing = second.store.acquirePermit('posthog', 1, 'b', LIVE, 1_000)
      await blockedOnLock(backend(), second.pid)
      await first.client.query('COMMIT')

      expect(await racing).toEqual({ granted: false, retryAt: 50_000 })
    })

    it('a flight join queues on the leader and follows its generation', async () => {
      const first = await openTransaction(backend())
      expect(await first.store.joinFlight('k', 9_000, 1_000)).toEqual({
        role: 'leader',
        generation: 1,
      })

      const second = await session(backend())
      const racing = second.store.joinFlight('k', 9_000, 1_000)
      await blockedOnLock(backend(), second.pid)
      await first.client.query('COMMIT')

      expect(await racing).toEqual({ role: 'follower', generation: 1 })
    })

    it('a sweep skips a flight a peer is re-leading, without waiting for it', async () => {
      const store = postgresStore(backend().pool)
      const cold = await store.joinFlight('k', 9_000, 1_000)
      await store.settleFlight('k', cold.generation, { status: 'ran', data: 1 }, 5_000)

      const first = await openTransaction(backend())
      expect(await first.store.joinFlight('k', 90_000, 12_000)).toEqual({
        role: 'leader',
        generation: 2,
      })

      // Settled and past its window as of the sweep's snapshot, but no longer.
      expect(await store.sweepFlights(6_000, 10)).toBe(0)
      await first.client.query('COMMIT')

      expect(await store.readFlight('k', 13_000)).toMatchObject({ running: 2 })
      expect(await store.settleFlight('k', 2, { status: 'ran', data: 2 }, 95_000)).toBe(true)
    })
  })

  describe('separate connections racing', () => {
    const contenders = (count: number) =>
      Promise.all(Array.from({ length: count }, () => session(backend())))

    it('admit exactly one claim', async () => {
      await postgresStore(backend().pool).writeSchedule({
        name: 'q',
        nextRunAt: 0,
        failCount: 0,
        leaseUntil: null,
        version: 1,
      })
      const peers = await contenders(12)
      const outcomes = await Promise.all(
        peers.map((peer) => peer.store.claim('q', 1, 9_000, 2_000)),
      )
      expect(outcomes.filter(Boolean)).toHaveLength(1)
    })

    it('admit exactly the quota limit, from a ledger row that did not exist', async () => {
      const peers = await contenders(12)
      const outcomes = await Promise.all(
        peers.map((peer) => peer.store.takeQuota('posthog', 5, WINDOW, 120_000)),
      )
      expect(outcomes.filter(Boolean)).toHaveLength(5)
    })

    it('grant exactly the permit limit, from a source row that did not exist', async () => {
      const peers = await contenders(12)
      const outcomes = await Promise.all(
        peers.map((peer, i) => peer.store.acquirePermit('posthog', 3, `h${i}`, LIVE, 1_000)),
      )
      expect(outcomes.filter((grant) => grant.granted)).toHaveLength(3)
    })

    it('elect exactly one flight leader, and every follower joins its generation', async () => {
      const peers = await contenders(12)
      const tickets = await Promise.all(
        peers.map((peer) => peer.store.joinFlight('k', 9_000, 1_000)),
      )
      expect(tickets.filter((ticket) => ticket.role === 'leader')).toHaveLength(1)
      expect(new Set(tickets.map((ticket) => ticket.generation))).toEqual(new Set([1]))
    })
  })
})
