-- datafridge D1 schema: result plane + schedule plane + source quota ledger.
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
  version INTEGER NOT NULL,
  params TEXT
);

CREATE INDEX IF NOT EXISTS idx_datafridge_schedule_next_run_at
  ON datafridge_schedule (next_run_at);

CREATE TABLE IF NOT EXISTS datafridge_quota (
  source TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  used INTEGER NOT NULL,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS datafridge_permit (
  holder TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_datafridge_permit_source
  ON datafridge_permit (source, expires_at);

CREATE TABLE IF NOT EXISTS datafridge_flight (
  name TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  running INTEGER NOT NULL,
  settled_generation INTEGER,
  outcome TEXT,
  keep_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_datafridge_flight_keep_until
  ON datafridge_flight (keep_until);
