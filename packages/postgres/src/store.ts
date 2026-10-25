import type { Envelope, FlightOutcome, QueryParams, ScheduleRow, Store } from '@datafridge/core'
import { resolveClient } from './queryable.js'
import type { PostgresClient } from './queryable.js'
import { ensureSchemaOnce, forgetSchema } from './schema.js'

const UNDEFINED_TABLE = '42P01'

// A row swept between the upsert and the read means that flight ended: try once more to lead.
const FLIGHT_JOIN_ATTEMPTS = 2

// node-postgres hands BIGINT and COUNT back as strings; other drivers may not.
type Numeric = string | number

type ScheduleRecord = {
  name: string
  next_run_at: Numeric
  fail_count: Numeric
  lease_until: Numeric | null
  version: Numeric
  params: string | null
}

type FlightRecord = {
  generation: Numeric
  expires_at: Numeric
  running: boolean
  settled_generation: Numeric | null
  outcome: string | null
  keep_until: Numeric
}

const SCHEDULE_COLUMNS = 'name, next_run_at, fail_count, lease_until, version, params'

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNDEFINED_TABLE
  )
}

function toScheduleRow(record: ScheduleRecord): ScheduleRow {
  return {
    name: record.name,
    nextRunAt: Number(record.next_run_at),
    failCount: Number(record.fail_count),
    leaseUntil: record.lease_until === null ? null : Number(record.lease_until),
    version: Number(record.version),
    ...(record.params !== null ? { params: JSON.parse(record.params) as QueryParams } : {}),
  }
}

/**
 * A full datafridge Store over Postgres. Every operation is a single statement
 * whose atomicity comes from Postgres row locks, so `db` can be the pool or
 * Drizzle database the rest of the app already uses; the store never opens a
 * connection of its own. Tables are created before the first write (see
 * `ensureSchema`); reads never create anything.
 */
export function postgresStore(db: PostgresClient): Store {
  resolveClient(db)

  const rows = async <T>(text: string, params: unknown[]): Promise<T[]> =>
    (await resolveClient(db).query(text, params)).rows as T[]

  // A table dropped under a warm process is re-created once instead of failing until restart.
  const withSchema = async <T>(run: () => Promise<T>): Promise<T> => {
    await ensureSchemaOnce(resolveClient(db))
    try {
      return await run()
    } catch (err) {
      if (!isUndefinedTable(err)) throw err
      forgetSchema(resolveClient(db))
      await ensureSchemaOnce(resolveClient(db))
      return run()
    }
  }

  // Reads never create schema: a missing table reads as empty.
  const readOrEmpty = async <T>(run: () => Promise<T>, missing: () => T): Promise<T> => {
    try {
      return await run()
    } catch (err) {
      if (isUndefinedTable(err)) return missing()
      throw err
    }
  }

  return {
    capabilities: { atomicClaim: true, listDue: true },

    readResult: (name) =>
      readOrEmpty(
        async () => {
          const [record] = await rows<{ envelope: string }>(
            'SELECT envelope FROM datafridge_results WHERE name = $1',
            [name],
          )
          return record ? (JSON.parse(record.envelope) as Envelope) : null
        },
        () => null,
      ),

    writeResult: (name, env) =>
      withSchema(async () => {
        await rows(
          'INSERT INTO datafridge_results (name, envelope) VALUES ($1, $2) ' +
            'ON CONFLICT (name) DO UPDATE SET envelope = excluded.envelope',
          [name, JSON.stringify(env)],
        )
      }),

    deleteResult: (name) =>
      withSchema(async () => {
        await rows('DELETE FROM datafridge_results WHERE name = $1', [name])
      }),

    readSchedule: (name) =>
      readOrEmpty(
        async () => {
          const [record] = await rows<ScheduleRecord>(
            `SELECT ${SCHEDULE_COLUMNS} FROM datafridge_schedule WHERE name = $1`,
            [name],
          )
          return record ? toScheduleRow(record) : null
        },
        () => null,
      ),

    readSchedules: (names) => {
      if (names.length === 0) return Promise.resolve([])
      return readOrEmpty(
        async () => {
          const placeholders = names.map((_, i) => `$${i + 1}`).join(', ')
          const found = new Map(
            (
              await rows<ScheduleRecord>(
                `SELECT ${SCHEDULE_COLUMNS} FROM datafridge_schedule WHERE name IN (${placeholders})`,
                [...names],
              )
            ).map((record) => [record.name, toScheduleRow(record)]),
          )
          return names.map((name) => found.get(name) ?? null)
        },
        () => names.map(() => null),
      )
    },

    writeSchedule: (row) =>
      withSchema(async () => {
        await rows(
          `INSERT INTO datafridge_schedule (${SCHEDULE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6) ` +
            'ON CONFLICT (name) DO UPDATE SET next_run_at = excluded.next_run_at, ' +
            'fail_count = excluded.fail_count, lease_until = excluded.lease_until, ' +
            'version = excluded.version, params = excluded.params',
          [
            row.name,
            row.nextRunAt,
            row.failCount,
            row.leaseUntil,
            row.version,
            row.params === undefined ? null : JSON.stringify(row.params),
          ],
        )
      }),

    deleteSchedule: (name) =>
      withSchema(async () => {
        await rows('DELETE FROM datafridge_schedule WHERE name = $1', [name])
      }),

    // UPDATE re-checks its WHERE on the newest row once locked, so one racing claim wins.
    claim: (name, expectedVersion, leaseUntil, now) =>
      withSchema(async () => {
        if (expectedVersion === 0) {
          const created = await rows(
            'INSERT INTO datafridge_schedule (name, next_run_at, fail_count, lease_until, version) ' +
              'VALUES ($1, $2, 0, $3, 1) ON CONFLICT (name) DO NOTHING RETURNING 1',
            [name, now, leaseUntil],
          )
          return created.length === 1
        }
        const claimed = await rows(
          'UPDATE datafridge_schedule SET version = version + 1, lease_until = $1 ' +
            'WHERE name = $2 AND version = $3 AND (lease_until IS NULL OR lease_until <= $4) ' +
            'RETURNING 1',
          [leaseUntil, name, expectedVersion, now],
        )
        return claimed.length === 1
      }),

    // The conflict branch locks the ledger row so takes queue; the window never rewinds.
    takeQuota: (source, limit, windowMs, now) =>
      withSchema(async () => {
        const taken = await rows(
          'INSERT INTO datafridge_quota AS q (source, window_start, used) ' +
            'SELECT $1::text, $2::double precision, 1 WHERE $3::integer >= 1 ' +
            'ON CONFLICT (source) DO UPDATE SET ' +
            'window_start = GREATEST(q.window_start, excluded.window_start), ' +
            'used = CASE WHEN excluded.window_start > q.window_start THEN 1 ELSE q.used + 1 END ' +
            'WHERE CASE WHEN excluded.window_start > q.window_start THEN 0 ELSE q.used END ' +
            '< $3::integer RETURNING 1',
          [source, Math.floor(now / windowMs) * windowMs, limit],
        )
        return taken.length === 1
      }),

    releaseQuota: (source, windowMs, takenAt) =>
      withSchema(async () => {
        await rows(
          'UPDATE datafridge_quota SET used = used - 1 ' +
            'WHERE source = $1 AND window_start = $2 AND used > 0',
          [source, Math.floor(takenAt / windowMs) * windowMs],
        )
      }),

    // One row per source: a per-holder COUNT-then-INSERT is not atomic under READ COMMITTED.
    acquirePermit: (source, limit, holder, expiresAt, now, explainRefusal = true) =>
      withSchema(async () => {
        const taken = await rows(
          'INSERT INTO datafridge_permit AS p (source, holders) ' +
            'SELECT $1::text, jsonb_build_object($2::text, $3::double precision) ' +
            'WHERE $4::integer >= 1 ' +
            'ON CONFLICT (source) DO UPDATE SET holders = (' +
            "SELECT COALESCE(jsonb_object_agg(live.key, live.value), '{}'::jsonb) " +
            'FROM jsonb_each(p.holders) AS live ' +
            'WHERE (live.value)::double precision > $5::double precision' +
            ') || jsonb_build_object($2::text, $3::double precision) ' +
            'WHERE (SELECT count(*) FROM jsonb_each(p.holders) AS live ' +
            'WHERE (live.value)::double precision > $5::double precision) < $4::integer ' +
            'AND COALESCE((p.holders -> $2::text)::double precision <= $5::double precision, true) ' +
            'RETURNING 1',
          [source, holder, expiresAt, limit, now],
        )
        if (taken.length === 1) return { granted: true }
        if (!explainRefusal) return { granted: false, retryAt: null }
        const [live] = await rows<{ held: Numeric; soonest: Numeric | null }>(
          'SELECT count(*) AS held, min((live.value)::double precision) AS soonest ' +
            'FROM datafridge_permit AS p, jsonb_each(p.holders) AS live ' +
            'WHERE p.source = $1 AND (live.value)::double precision > $2::double precision',
          [source, now],
        )
        // Room to spare means the holder id was the only thing in the way.
        if (!live || Number(live.held) < limit) return { granted: false, retryAt: now }
        return { granted: false, retryAt: live.soonest === null ? now : Number(live.soonest) }
      }),

    releasePermit: (source, holder) =>
      withSchema(async () => {
        await rows(
          'UPDATE datafridge_permit SET holders = holders - $2::text ' +
            'WHERE source = $1 AND (holders -> $2::text) IS NOT NULL',
          [source, holder],
        )
      }),

    joinFlight: (key, expiresAt, now) =>
      withSchema(async () => {
        for (let attempt = 0; attempt < FLIGHT_JOIN_ATTEMPTS; attempt += 1) {
          const [led] = await rows<{ generation: Numeric }>(
            'INSERT INTO datafridge_flight AS f (name, generation, expires_at, running, keep_until) ' +
              'VALUES ($1, 1, $2, true, 0) ' +
              'ON CONFLICT (name) DO UPDATE SET generation = f.generation + 1, ' +
              'expires_at = excluded.expires_at, running = true ' +
              'WHERE NOT f.running OR f.expires_at <= $3 RETURNING generation',
            [key, expiresAt, now],
          )
          if (led) return { role: 'leader', generation: Number(led.generation) }
          const [running] = await rows<{ generation: Numeric }>(
            'SELECT generation FROM datafridge_flight WHERE name = $1',
            [key],
          )
          if (running) return { role: 'follower', generation: Number(running.generation) }
        }
        return { role: 'leader', generation: 1 }
      }),

    readFlight: (key, now) =>
      withSchema(async () => {
        const [record] = await rows<FlightRecord>(
          'SELECT generation, expires_at, running, settled_generation, outcome, keep_until ' +
            'FROM datafridge_flight WHERE name = $1',
          [key],
        )
        if (!record) return null
        return {
          running:
            record.running && Number(record.expires_at) > now ? Number(record.generation) : null,
          settled:
            record.settled_generation !== null &&
            record.outcome !== null &&
            Number(record.keep_until) > now
              ? {
                  generation: Number(record.settled_generation),
                  outcome: JSON.parse(record.outcome) as FlightOutcome,
                }
              : null,
        }
      }),

    settleFlight: (key, generation, outcome, keepUntil) =>
      withSchema(async () => {
        const settled = await rows(
          'UPDATE datafridge_flight SET running = false, settled_generation = $1, outcome = $2, ' +
            'keep_until = $3 WHERE name = $4 AND generation = $1 AND running RETURNING 1',
          [generation, JSON.stringify(outcome), keepUntil, key],
        )
        return settled.length === 1
      }),

    // SKIP LOCKED leaves alone a flight a peer is re-leading right now.
    sweepFlights: (before, limit) =>
      withSchema(async () => {
        const swept = await rows(
          'DELETE FROM datafridge_flight WHERE name IN (' +
            'SELECT name FROM datafridge_flight ' +
            'WHERE keep_until <= $1 AND (NOT running OR expires_at <= $1) ' +
            'LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING 1',
          [before, limit],
        )
        return swept.length
      }),

    listDue: (now, limit) =>
      withSchema(async () => {
        const due = await rows<ScheduleRecord>(
          `SELECT ${SCHEDULE_COLUMNS} FROM datafridge_schedule WHERE next_run_at <= $1 ` +
            'ORDER BY next_run_at, name LIMIT $2',
          [now, limit],
        )
        return due.map(toScheduleRow)
      }),
  }
}
