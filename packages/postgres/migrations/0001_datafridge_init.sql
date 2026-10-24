-- datafridge Postgres schema: result plane, schedule plane, quota ledger,
-- concurrency permits and transient flights.
-- postgresStore() applies this itself before its first write, so running it is
-- optional. Copy it into your own migration pipeline to own the DDL instead;
-- names are unqualified and land in the first schema on the search_path.

CREATE TABLE IF NOT EXISTS datafridge_results (
  name TEXT PRIMARY KEY,
  envelope TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datafridge_schedule (
  name TEXT COLLATE "C" PRIMARY KEY,
  next_run_at DOUBLE PRECISION NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0,
  lease_until DOUBLE PRECISION,
  version BIGINT NOT NULL,
  params TEXT
);

CREATE INDEX IF NOT EXISTS datafridge_schedule_next_run_at_idx
  ON datafridge_schedule (next_run_at, name);

CREATE TABLE IF NOT EXISTS datafridge_quota (
  source TEXT PRIMARY KEY,
  window_start DOUBLE PRECISION NOT NULL,
  used INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS datafridge_permit (
  source TEXT PRIMARY KEY,
  holders JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS datafridge_flight (
  name TEXT PRIMARY KEY,
  generation BIGINT NOT NULL,
  expires_at DOUBLE PRECISION NOT NULL,
  running BOOLEAN NOT NULL,
  settled_generation BIGINT,
  outcome TEXT,
  keep_until DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS datafridge_flight_keep_until_idx
  ON datafridge_flight (keep_until);
