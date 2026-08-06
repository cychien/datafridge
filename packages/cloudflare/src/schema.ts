/**
 * The D1 schema datafridge needs, as single statements.
 *
 * `d1()` applies these lazily before its first write, so applying the packaged
 * migration is optional. `migrations/0001_datafridge_init.sql` carries the same
 * statements for teams that would rather declare the schema in their own
 * pipeline; a test keeps the two from drifting.
 *
 * Deliberately free of Workers types so Node-side tooling can read it.
 */
export const D1_SCHEMA: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS datafridge_results (name TEXT PRIMARY KEY, envelope TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS datafridge_schedule (name TEXT PRIMARY KEY, ' +
    'next_run_at INTEGER NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0, ' +
    'lease_until INTEGER, version INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_datafridge_schedule_next_run_at ' +
    'ON datafridge_schedule (next_run_at)',
  'CREATE TABLE IF NOT EXISTS datafridge_quota (source TEXT PRIMARY KEY, ' +
    'window_start INTEGER NOT NULL, used INTEGER NOT NULL, version INTEGER NOT NULL)',
]
