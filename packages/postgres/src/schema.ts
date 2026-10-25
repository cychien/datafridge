import { resolveClient } from './queryable.js'
import type { PostgresClient, PostgresQueryable } from './queryable.js'

interface SchemaObject {
  relation: string
  statement: string
}

const OBJECTS: readonly SchemaObject[] = [
  {
    relation: 'datafridge_results',
    statement:
      'CREATE TABLE IF NOT EXISTS datafridge_results (name TEXT PRIMARY KEY, envelope TEXT NOT NULL)',
  },
  {
    relation: 'datafridge_schedule',
    statement:
      'CREATE TABLE IF NOT EXISTS datafridge_schedule (name TEXT COLLATE "C" PRIMARY KEY, ' +
      'next_run_at DOUBLE PRECISION NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0, ' +
      'lease_until DOUBLE PRECISION, version BIGINT NOT NULL, params TEXT)',
  },
  {
    relation: 'datafridge_schedule_next_run_at_idx',
    statement:
      'CREATE INDEX IF NOT EXISTS datafridge_schedule_next_run_at_idx ' +
      'ON datafridge_schedule (next_run_at, name)',
  },
  {
    relation: 'datafridge_quota',
    statement:
      'CREATE TABLE IF NOT EXISTS datafridge_quota (source TEXT PRIMARY KEY, ' +
      'window_start DOUBLE PRECISION NOT NULL, used INTEGER NOT NULL)',
  },
  {
    relation: 'datafridge_permit',
    statement:
      'CREATE TABLE IF NOT EXISTS datafridge_permit (source TEXT PRIMARY KEY, ' +
      'holders JSONB NOT NULL)',
  },
  {
    relation: 'datafridge_flight',
    statement:
      'CREATE TABLE IF NOT EXISTS datafridge_flight (name TEXT PRIMARY KEY, ' +
      'generation BIGINT NOT NULL, expires_at DOUBLE PRECISION NOT NULL, ' +
      'running BOOLEAN NOT NULL, settled_generation BIGINT, outcome TEXT, ' +
      'keep_until DOUBLE PRECISION NOT NULL DEFAULT 0)',
  },
  {
    relation: 'datafridge_flight_keep_until_idx',
    statement:
      'CREATE INDEX IF NOT EXISTS datafridge_flight_keep_until_idx ' +
      'ON datafridge_flight (keep_until)',
  },
]

/**
 * The tables and indexes the Postgres store owns, as single statements, for
 * teams that declare schema in their own migration pipeline.
 * `migrations/0001_datafridge_init.sql` carries the same statements, and a test
 * keeps the two from drifting. Names are unqualified, so they land in the first
 * schema on the connection's `search_path`.
 */
export const POSTGRES_SCHEMA: readonly string[] = OBJECTS.map((object) => object.statement)

// Checking first lets a role without CREATE use pre-migrated tables; the handler absorbs concurrent creators.
const ENSURE_SCHEMA = [
  'DO $datafridge$',
  'BEGIN',
  ...OBJECTS.map(({ relation, statement }) =>
    [
      `  IF to_regclass('${relation}') IS NULL THEN`,
      '    BEGIN',
      `      ${statement};`,
      '    EXCEPTION WHEN duplicate_table OR duplicate_object OR unique_violation THEN NULL;',
      '    END;',
      '  END IF;',
    ].join('\n'),
  ),
  'END',
  '$datafridge$',
].join('\n')

/**
 * Creates every table and index the store needs, if missing. Idempotent, safe to
 * run from several processes at once, and one round trip. The store applies it
 * itself before its first write; running it at deploy time moves that cost out
 * of the first request.
 */
export async function ensureSchema(db: PostgresClient): Promise<void> {
  await resolveClient(db).query(ENSURE_SCHEMA)
}

const schemaReady = new WeakMap<PostgresQueryable, Promise<void>>()

export function ensureSchemaOnce(db: PostgresQueryable): Promise<void> {
  const pending = schemaReady.get(db)
  if (pending) return pending
  const ready = ensureSchema(db)
  // Forget a failure so one bad moment does not break this client for good.
  ready.catch(() => schemaReady.delete(db))
  schemaReady.set(db, ready)
  return ready
}

export function forgetSchema(db: PostgresQueryable): void {
  schemaReady.delete(db)
}
