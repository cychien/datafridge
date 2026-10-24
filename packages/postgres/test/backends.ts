import { randomBytes } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { afterAll, beforeAll, describe } from 'vitest'

import type { PostgresQueryable } from '../src/index.js'

/** A real Postgres the suite may create and drop schemas in; unset skips those runs. */
export const DATABASE_URL = process.env.DATAFRIDGE_TEST_DATABASE_URL

export interface Backend {
  label: string
  db: PostgresQueryable
  /** Empties datafridge's tables, leaving the schema in place. */
  wipe(): Promise<void>
  /** Takes the schema away entirely, so the next write has to put it back. */
  drop(): Promise<void>
  /** Names of datafridge's tables that currently exist. */
  tables(): Promise<string[]>
  close(): Promise<void>
}

export interface PostgresBackend extends Backend {
  pool: pg.Pool
  /** The isolated schema this file runs in, already first on every connection's search_path. */
  schema: string
  /** A dedicated connection, for tests that need to hold a transaction open. */
  connect(): Promise<pg.Client>
  /** Another pool on the same schema: what a second process would hold. */
  openPool(): pg.Pool
}

const TABLES_SQL =
  'SELECT tablename FROM pg_tables ' +
  "WHERE schemaname = current_schema() AND tablename LIKE 'datafridge\\_%' ORDER BY tablename"

function operations(db: PostgresQueryable) {
  const tables = async () =>
    ((await db.query(TABLES_SQL)).rows as Array<{ tablename: string }>).map((row) => row.tablename)
  return {
    tables,
    async wipe() {
      const names = await tables()
      if (names.length > 0) await db.query(`TRUNCATE ${names.join(', ')}`)
    },
    async drop() {
      const names = await tables()
      if (names.length > 0) await db.query(`DROP TABLE ${names.join(', ')}`)
    },
  }
}

export async function pgliteBackend(): Promise<Backend> {
  const db = await PGlite.create()
  return { label: 'PGlite', db, ...operations(db), close: () => db.close() }
}

export async function postgresBackend(url: string): Promise<PostgresBackend> {
  const schema = `datafridge_test_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
  } finally {
    await admin.end()
  }
  const config = { connectionString: url, options: `-c search_path=${schema}` }
  const pool = new pg.Pool({ ...config, max: 20 })
  const clients = new Set<pg.Client>()
  const pools = new Set<pg.Pool>()
  return {
    label: 'Postgres',
    db: pool,
    pool,
    schema,
    ...operations(pool),
    async connect() {
      const client = new pg.Client(config)
      await client.connect()
      clients.add(client)
      return client
    },
    openPool() {
      const extra = new pg.Pool({ ...config, max: 4 })
      pools.add(extra)
      return extra
    },
    async close() {
      await Promise.all([...clients].map((client) => client.end().catch(() => {})))
      await Promise.all([...pools].map((extra) => extra.end().catch(() => {})))
      await pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await pool.end()
    },
  }
}

function describeWith<B extends Backend>(
  label: string,
  open: () => Promise<B>,
  body: (backend: () => B, label: string) => void,
  enabled = true,
): void {
  describe.runIf(enabled)(label, () => {
    let backend: B | undefined
    beforeAll(async () => {
      backend = await open()
    })
    afterAll(async () => {
      await backend?.close()
    })
    body(() => {
      if (!backend) throw new Error(`${label} backend is not open`)
      return backend
    }, label)
  })
}

/**
 * Declares `body` once per available backend: PGlite always, and a real
 * Postgres when DATAFRIDGE_TEST_DATABASE_URL names one.
 */
export function eachBackend(body: (backend: () => Backend, label: string) => void): void {
  describeWith('PGlite', pgliteBackend, body)
  describeWith('Postgres', () => postgresBackend(DATABASE_URL!), body, DATABASE_URL !== undefined)
}

/** For what only a real server with several connections can express. */
export function withPostgres(body: (backend: () => PostgresBackend) => void): void {
  describeWith('Postgres', () => postgresBackend(DATABASE_URL!), body, DATABASE_URL !== undefined)
}
