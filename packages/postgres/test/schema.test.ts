import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createReader, defineQueries } from '@datafridge/core'
import type { Store } from '@datafridge/core'
import pg from 'pg'
import { beforeEach, describe, expect, it } from 'vitest'

import { ensureSchema, POSTGRES_SCHEMA, postgresStore } from '../src/index.js'
import type { PostgresQueryable } from '../src/index.js'
import { DATABASE_URL, eachBackend, withPostgres } from './backends.js'

const ALL_TABLES = [
  'datafridge_flight',
  'datafridge_permit',
  'datafridge_quota',
  'datafridge_results',
  'datafridge_schedule',
]

const migration = readFileSync(
  fileURLToPath(new URL('../migrations/0001_datafridge_init.sql', import.meta.url)),
  'utf8',
)

const migrationStatements = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean)

const normalize = (sql: string) =>
  sql
    .replace(/\s+/g, ' ')
    .replace(/\s*([()])\s*/g, '$1')
    .trim()

function readOnly(store: Store): Pick<Store, 'readResult' | 'readSchedule'> {
  return {
    readResult: (name) => store.readResult(name),
    readSchedule: (name) => store.readSchedule(name),
  }
}

describe('the packaged migration and the schema postgresStore() applies stay identical', () => {
  it('declares exactly the same statements, in the same order', () => {
    expect(migrationStatements.map(normalize)).toEqual(POSTGRES_SCHEMA.map(normalize))
  })
})

eachBackend((backend) => {
  beforeEach(async () => {
    await backend().drop()
  })

  describe('postgresStore applies its own schema', () => {
    it('the first write creates every table it needs', async () => {
      await postgresStore(backend().db).writeResult('q', { data: 1, fetchedAt: 0, freshUntil: 1 })
      expect(await backend().tables()).toEqual(ALL_TABLES)
    })

    it('reads before any table exists answer empty and create nothing', async () => {
      const store = postgresStore(backend().db)
      expect(await store.readResult('q')).toBeNull()
      expect(await store.readSchedule('q')).toBeNull()
      expect(await store.readSchedules!(['a', 'b'])).toEqual([null, null])
      expect(await backend().tables()).toEqual([])
    })

    it('a cold read through a read-only reader creates nothing', async () => {
      const reader = createReader({
        store: readOnly(postgresStore(backend().db)),
        queries: defineQueries([
          { name: 'metrics', every: '5m', timeout: '50ms', fetch: async () => ({ ok: true }) },
        ]),
      })
      expect(await reader.read('metrics')).toBeNull()
      expect(await backend().tables()).toEqual([])
    })

    it('recovers when the tables disappear under a warm process', async () => {
      const store = postgresStore(backend().db)
      await store.writeResult('q', { data: 'before', fetchedAt: 0, freshUntil: 1 })
      // The schema is already remembered as applied for this client.
      await backend().drop()
      await store.writeResult('q', { data: 'after', fetchedAt: 0, freshUntil: 1 })
      expect((await store.readResult('q'))?.data).toBe('after')
    })

    it('treats the shipped migration, applied by hand, as already done', async () => {
      for (const statement of migrationStatements) await backend().db.query(statement)
      await ensureSchema(backend().db)
      await ensureSchema(backend().db)
      const store = postgresStore(backend().db)
      expect(await store.claim('q', 0, 5_000, 1_000)).toBe(true)
      expect(await backend().tables()).toEqual(ALL_TABLES)
    })
  })
})

describe('postgresStore failures', () => {
  it('a real read failure still propagates', async () => {
    const broken: PostgresQueryable = {
      query: async () => {
        throw Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' })
      },
    }
    await expect(postgresStore(broken).readResult('q')).rejects.toThrow(/connection terminated/)
  })

  it('a schema that cannot be applied fails the write, and is tried again next time', async () => {
    let healthy = false
    const statements: string[] = []
    const flaky: PostgresQueryable = {
      query: async (text) => {
        statements.push(text)
        if (!healthy) throw new Error('could not connect to server')
        return { rows: [] }
      },
    }
    const store = postgresStore(flaky)
    await expect(store.deleteResult('q')).rejects.toThrow(/could not connect/)
    healthy = true
    statements.length = 0
    await store.deleteResult('q')
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^DO /)
  })
})

withPostgres((backend) => {
  describe('schema under real Postgres', () => {
    beforeEach(async () => {
      await backend().drop()
    })

    it('many processes applying it at once all succeed', async () => {
      const clients = await Promise.all(Array.from({ length: 8 }, () => backend().connect()))
      await Promise.all(clients.map((client) => ensureSchema(client)))
      expect(await backend().tables()).toEqual(ALL_TABLES)
    })

    it('a role that may not create tables runs against tables someone else migrated', async () => {
      await ensureSchema(backend().pool)
      const role = `datafridge_app_${randomBytes(4).toString('hex')}`
      const { schema } = backend()
      await backend().pool.query(`CREATE ROLE ${role}`)
      try {
        await backend().pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
        await backend().pool.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
        )
        const client = await backend().connect()
        await client.query(`SET ROLE ${role}`)
        await expect(client.query('CREATE TABLE datafridge_probe (id int)')).rejects.toThrow(
          /permission denied/,
        )

        const store = postgresStore(client)
        expect(await store.claim('q', 0, 5_000, 1_000)).toBe(true)
        await store.writeResult('q', { data: 'ok', fetchedAt: 1_000, freshUntil: 2_000 })
        expect((await store.readResult('q'))?.data).toBe('ok')
        await client.query('RESET ROLE')
      } finally {
        await backend().pool.query(`DROP OWNED BY ${role}`)
        await backend().pool.query(`DROP ROLE ${role}`)
      }
    })

    it('lands in whatever schema the connection puts first on its search_path', async () => {
      const client = new pg.Client({ connectionString: DATABASE_URL })
      await client.connect()
      try {
        const { rows } = await client.query<{ count: string }>(
          "SELECT count(*) FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'datafridge%'",
          [backend().schema],
        )
        expect(Number(rows[0]!.count)).toBe(0)
        await postgresStore(backend().pool).writeResult('q', {
          data: 1,
          fetchedAt: 0,
          freshUntil: 1,
        })
        const after = await client.query<{ count: string }>(
          "SELECT count(*) FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'datafridge%'",
          [backend().schema],
        )
        expect(Number(after.rows[0]!.count)).toBe(ALL_TABLES.length)
      } finally {
        await client.end()
      }
    })
  })
})
