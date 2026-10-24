import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { drizzle as drizzleNodePostgres } from 'drizzle-orm/node-postgres'
import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'

import { postgresStore } from '../src/index.js'
import type { PostgresQueryable } from '../src/index.js'
import { eachBackend, pgliteBackend, withPostgres } from './backends.js'

/** Records every statement a store sends, which is the thing under test here. */
function counting(db: PostgresQueryable): { db: PostgresQueryable; statements: string[] } {
  const statements: string[] = []
  return {
    statements,
    db: {
      query: (text, params) => {
        statements.push(text)
        return db.query(text, params)
      },
    },
  }
}

describe('what postgresStore accepts', () => {
  it('refuses something that is neither a client nor a Drizzle database, at construction', () => {
    expect(() => postgresStore({} as PostgresQueryable)).toThrow(/needs a client with query/)
    expect(() => postgresStore({ $client: {} } as unknown as PostgresQueryable)).toThrow(
      /needs a client with query/,
    )
  })

  it('takes a Drizzle database over PGlite as it is', async () => {
    const backend = await pgliteBackend()
    try {
      const store = postgresStore(drizzlePglite(backend.db as PGlite))
      expect(await store.claim('q', 0, 5_000, 1_000)).toBe(true)
      expect(await store.readSchedule('q')).toMatchObject({ version: 1, leaseUntil: 5_000 })
    } finally {
      await backend.close()
    }
  })

  it('reads $client again for every statement, so a scoped database follows its scope', async () => {
    const [first, second] = await Promise.all([pgliteBackend(), pgliteBackend()])
    try {
      let current = first.db
      const scoped = {
        get $client() {
          return current
        },
      }
      const store = postgresStore(scoped)
      await store.writeResult('q', { data: 'first', fetchedAt: 0, freshUntil: 1 })
      current = second.db
      expect(await store.readResult('q')).toBeNull()
      await store.writeResult('q', { data: 'second', fetchedAt: 0, freshUntil: 1 })
      current = first.db
      expect((await store.readResult('q'))?.data).toBe('first')
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })
})

withPostgres((backend) => {
  it('takes a Drizzle database over a node-postgres pool as it is', async () => {
    const store = postgresStore(drizzleNodePostgres(backend().pool))
    expect(await store.takeQuota('posthog', 1, 60_000, 120_000)).toBe(true)
    expect(await store.takeQuota('posthog', 1, 60_000, 120_001)).toBe(false)
  })
})

eachBackend((backend) => {
  beforeEach(async () => {
    await backend().wipe()
  })

  describe('postgresStore concurrency permits', () => {
    it('costs one statement to be refused, and only pays for a reason on request', async () => {
      const { db, statements } = counting(backend().db)
      const store = postgresStore(db)
      // The schema is applied lazily, so warm it before anything is counted.
      await store.acquirePermit('posthog', 1, 'held', 90_000, 1_000)

      statements.length = 0
      expect(await store.acquirePermit('posthog', 1, 'poll', 90_000, 1_000, false)).toEqual({
        granted: false,
        retryAt: null,
      })
      expect(statements).toHaveLength(1)

      statements.length = 0
      expect(await store.acquirePermit('posthog', 1, 'poll', 90_000, 1_000, true)).toEqual({
        granted: false,
        retryAt: 90_000,
      })
      expect(statements).toHaveLength(2)

      await store.releasePermit('posthog', 'held')
      expect(await store.acquirePermit('posthog', 1, 'poll', 90_000, 1_000, false)).toEqual({
        granted: true,
      })
    })

    it('drops the permits of holders that died when it grants the next one', async () => {
      const store = postgresStore(backend().db)
      await store.acquirePermit('posthog', 2, 'gone', 5_000, 1_000)
      await store.acquirePermit('posthog', 2, 'next', 90_000, 6_000)
      const { rows } = await backend().db.query(
        "SELECT holders FROM datafridge_permit WHERE source = 'posthog'",
      )
      expect(rows).toEqual([{ holders: { next: 90_000 } }])
    })
  })

  describe('postgresStore round trips', () => {
    it('keeps an envelope byte for byte, key order and all', async () => {
      const store = postgresStore(backend().db)
      const data = { zeta: 1, alpha: { b: 2, a: 1 }, text: 'nul \u0000 and emoji \u{1F9CA}' }
      await store.writeResult('q', { data, fetchedAt: 1, freshUntil: 2 })
      const read = await store.readResult('q')
      expect(JSON.stringify(read?.data)).toBe(JSON.stringify(data))
    })

    it('keeps epoch timestamps exact, including ones that are not whole milliseconds', async () => {
      const store = postgresStore(backend().db)
      const row = {
        name: 'q',
        nextRunAt: 1_761_350_400_123.5,
        failCount: 0,
        leaseUntil: Number.MAX_SAFE_INTEGER,
        version: 2 ** 40,
      }
      await store.writeSchedule(row)
      expect(await store.readSchedule('q')).toEqual(row)
      expect(await store.listDue!(Number.MAX_SAFE_INTEGER, 10)).toEqual([row])
    })
  })
})
