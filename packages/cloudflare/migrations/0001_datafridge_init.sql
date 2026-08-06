-- datafridge D1 schema: result plane + schedule plane.
-- Apply with `wrangler d1 migrations apply <DB>` after pointing your database's
-- migrations_dir at this package's migrations/ directory, or copy this file
-- into your own migrations pipeline.

CREATE TABLE IF NOT EXISTS datafridge_results (
  name TEXT PRIMARY KEY,
  envelope TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datafridge_schedule (
  name TEXT PRIMARY KEY,
  next_run_at INTEGER NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  version INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_datafridge_schedule_next_run_at
  ON datafridge_schedule (next_run_at);
