import type { Envelope, FlightOutcome, QueryParams, ScheduleRow, Store } from '@datafridge/core'
import { D1_SCHEMA } from './schema.js'

// D1's documented maximum string/BLOB/row size (developers.cloudflare.com/d1/platform/limits).
const D1_MAX_ROW_BYTES = 2_000_000

// Enough for the handful of executors one source can realistically have racing
// on the same window; beyond that, refusing is the correct answer anyway.
const QUOTA_CAS_ATTEMPTS = 8

type ScheduleRecord = {
  name: string
  next_run_at: number
  fail_count: number
  lease_until: number | null
  version: number
  params: string | null
}

type QuotaRecord = {
  window_start: number
  used: number
  version: number
}

type FlightRecord = {
  generation: number
  expires_at: number
  running: number
  settled_generation: number | null
  outcome: string | null
  keep_until: number
}

// Applied once per binding per isolate, before the first write. Applying the
// packaged migration yourself makes this a no-op.
const schemaReady = new WeakMap<D1Database, Promise<void>>()

function ensureSchema(db: D1Database): Promise<void> {
  const pending = schemaReady.get(db)
  if (pending) return pending
  const ready = db.batch(D1_SCHEMA.map((statement) => db.prepare(statement))).then(() => undefined)
  // A failed attempt must not be remembered, or one bad moment would break
  // this binding for the rest of the isolate's life.
  ready.catch(() => schemaReady.delete(db))
  schemaReady.set(db, ready)
  return ready
}

function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message)
}

/**
 * Runs a statement with the schema in place. Remembering one success is not
 * enough: a database dropped or destructively migrated under a warm isolate
 * would otherwise keep failing until that isolate recycles, and the alarm loop
 * absorbs those errors - the exact silent failure this schema handling exists to
 * remove. So a missing table re-applies the schema and retries once.
 */
async function withSchema<T>(db: D1Database, run: () => Promise<T>): Promise<T> {
  await ensureSchema(db)
  try {
    return await run()
  } catch (err) {
    if (!isMissingTable(err)) throw err
    schemaReady.delete(db)
    await ensureSchema(db)
    return run()
  }
}

function toScheduleRow(record: ScheduleRecord): ScheduleRow {
  return {
    name: record.name,
    nextRunAt: record.next_run_at,
    failCount: record.fail_count,
    leaseUntil: record.lease_until,
    version: record.version,
    ...(record.params !== null ? { params: JSON.parse(record.params) as QueryParams } : {}),
  }
}

export function d1(db: D1Database): Store {
  return {
    capabilities: { atomicClaim: true, listDue: true },

    // Neither read applies schema: a read-only consumer must never create
    // tables, and a reader consults the schedule row on a miss. Before anything
    // has been written the table may not exist, which is the same answer as an
    // empty one - but only that error is an empty answer.
    async readResult(name) {
      try {
        const record = await db
          .prepare('SELECT envelope FROM datafridge_results WHERE name = ?')
          .bind(name)
          .first<{ envelope: string }>()
        return record ? (JSON.parse(record.envelope) as Envelope) : null
      } catch (err) {
        if (isMissingTable(err)) return null
        throw err
      }
    },

    async writeResult(name, env) {
      return withSchema(db, async () => {
        const envelope = JSON.stringify(env)
        const bytes = new TextEncoder().encode(envelope).byteLength
        if (bytes > D1_MAX_ROW_BYTES) {
          throw new Error(
            `datafridge: envelope for query "${name}" is ${bytes} bytes, ` +
              `exceeding D1's ${D1_MAX_ROW_BYTES}-byte row limit; the previous envelope is kept`,
          )
        }
        await db
          .prepare(
            'INSERT INTO datafridge_results (name, envelope) VALUES (?, ?) ' +
              'ON CONFLICT (name) DO UPDATE SET envelope = excluded.envelope',
          )
          .bind(name, envelope)
          .run()
      })
    },

    async deleteResult(name) {
      return withSchema(db, async () => {
        await db.prepare('DELETE FROM datafridge_results WHERE name = ?').bind(name).run()
      })
    },

    async readSchedule(name) {
      try {
        const record = await db
          .prepare('SELECT * FROM datafridge_schedule WHERE name = ?')
          .bind(name)
          .first<ScheduleRecord>()
        return record ? toScheduleRow(record) : null
      } catch (err) {
        if (isMissingTable(err)) return null
        throw err
      }
    },

    // One statement for a bounded batch, keyed by the primary key. Reads apply
    // no schema, exactly as the single-row read above does not.
    async readSchedules(names) {
      if (names.length === 0) return []
      try {
        const { results } = await db
          .prepare(
            `SELECT * FROM datafridge_schedule WHERE name IN (${names.map(() => '?').join(', ')})`,
          )
          .bind(...names)
          .all<ScheduleRecord>()
        const found = new Map(results.map((record) => [record.name, toScheduleRow(record)]))
        return names.map((name) => found.get(name) ?? null)
      } catch (err) {
        if (isMissingTable(err)) return names.map(() => null)
        throw err
      }
    },

    async writeSchedule(row) {
      return withSchema(db, async () => {
        await db
          .prepare(
            'INSERT INTO datafridge_schedule ' +
              '(name, next_run_at, fail_count, lease_until, version, params) ' +
              'VALUES (?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT (name) DO UPDATE SET next_run_at = excluded.next_run_at, ' +
              'fail_count = excluded.fail_count, lease_until = excluded.lease_until, ' +
              'version = excluded.version, params = excluded.params',
          )
          .bind(
            row.name,
            row.nextRunAt,
            row.failCount,
            row.leaseUntil,
            row.version,
            row.params === undefined ? null : JSON.stringify(row.params),
          )
          .run()
      })
    },

    async deleteSchedule(name) {
      return withSchema(db, async () => {
        await db.prepare('DELETE FROM datafridge_schedule WHERE name = ?').bind(name).run()
      })
    },

    async claim(name, expectedVersion, leaseUntil, now) {
      return withSchema(db, async () => {
        if (expectedVersion === 0) {
          const result = await db
            .prepare(
              'INSERT INTO datafridge_schedule ' +
                '(name, next_run_at, fail_count, lease_until, version) ' +
                'VALUES (?, ?, 0, ?, 1) ON CONFLICT (name) DO NOTHING',
            )
            .bind(name, now, leaseUntil)
            .run()
          return result.meta.changes === 1
        }
        const result = await db
          .prepare(
            'UPDATE datafridge_schedule SET version = version + 1, lease_until = ? ' +
              'WHERE name = ? AND version = ? AND (lease_until IS NULL OR lease_until <= ?)',
          )
          .bind(leaseUntil, name, expectedVersion, now)
          .run()
        return result.meta.changes === 1
      })
    },

    async takeQuota(source, limit, windowMs, now) {
      return withSchema(db, async () => {
        const windowStart = Math.floor(now / windowMs) * windowMs
        // Same CAS as claim: read, decide, then write only if nobody moved. A
        // lost race means a peer took a slot, so the count has to be re-read
        // rather than retried blindly, and running out of attempts refuses the
        // call - the safe direction for a ceiling.
        for (let attempt = 0; attempt < QUOTA_CAS_ATTEMPTS; attempt += 1) {
          const record = await db
            .prepare('SELECT window_start, used, version FROM datafridge_quota WHERE source = ?')
            .bind(source)
            .first<QuotaRecord>()
          if (!record) {
            if (limit < 1) return false
            const created = await db
              .prepare(
                'INSERT INTO datafridge_quota (source, window_start, used, version) ' +
                  'VALUES (?, ?, 1, 1) ON CONFLICT (source) DO NOTHING',
              )
              .bind(source, windowStart)
              .run()
            if (created.meta.changes === 1) return true
            continue
          }
          // A window is never rewound: an executor whose clock lags must not
          // reopen one its peers have already closed and hand out the quota
          // twice.
          const openWindow = Math.max(record.window_start, windowStart)
          const used = record.window_start === openWindow ? record.used : 0
          if (used >= limit) return false
          const taken = await db
            .prepare(
              'UPDATE datafridge_quota SET window_start = ?, used = ?, version = version + 1 ' +
                'WHERE source = ? AND version = ?',
            )
            .bind(openWindow, used + 1, source, record.version)
            .run()
          if (taken.meta.changes === 1) return true
        }
        return false
      })
    },

    // A relative decrement guarded by the window it belongs to, so it needs no
    // CAS loop: a peer taking a slot at the same moment cannot make this credit
    // the wrong one, and a window that has rolled matches nothing.
    async releaseQuota(source, windowMs, takenAt) {
      return withSchema(db, async () => {
        await db
          .prepare(
            'UPDATE datafridge_quota SET used = used - 1, version = version + 1 ' +
              'WHERE source = ? AND window_start = ? AND used > 0',
          )
          .bind(source, Math.floor(takenAt / windowMs) * windowMs)
          .run()
      })
    },

    // One statement decides and takes: the count and the insert cannot be
    // separated by a peer, so two Workers cannot both read "one slot left". A
    // holder id already in the table is a different caller wearing the same
    // name, so the insert is skipped rather than allowed to overwrite it.
    async acquirePermit(source, limit, holder, expiresAt, now) {
      return withSchema(db, async () => {
        const taken = await db
          .prepare(
            'INSERT INTO datafridge_permit (holder, source, expires_at) SELECT ?, ?, ? ' +
              'WHERE (SELECT COUNT(*) FROM datafridge_permit ' +
              'WHERE source = ? AND expires_at > ?) < ? ' +
              'ON CONFLICT (holder) DO NOTHING',
          )
          .bind(holder, source, expiresAt, source, now, limit)
          .run()
        if (taken.meta.changes === 1) return { granted: true }
        // Refused: this is the moment worth paying to collect the permits of
        // holders that died, so the next caller sees the real count.
        await db.prepare('DELETE FROM datafridge_permit WHERE expires_at <= ?').bind(now).run()
        const live = await db
          .prepare(
            'SELECT COUNT(*) AS held, MIN(expires_at) AS soonest FROM datafridge_permit ' +
              'WHERE source = ? AND expires_at > ?',
          )
          .bind(source, now)
          .first<{ held: number; soonest: number | null }>()
        // Room to spare means the holder id was the only thing in the way.
        if (!live || live.held < limit) return { granted: false, retryAt: now }
        return { granted: false, retryAt: live.soonest ?? now }
      })
    },

    async releasePermit(_source, holder) {
      return withSchema(db, async () => {
        await db.prepare('DELETE FROM datafridge_permit WHERE holder = ?').bind(holder).run()
      })
    },

    async joinFlight(key, expiresAt, now) {
      return withSchema(db, async () => {
        // Leading is the conditional write; following is what is left when it
        // does not apply, so the winner pays one round trip and nobody races.
        const led = await db
          .prepare(
            'INSERT INTO datafridge_flight ' +
              '(name, generation, expires_at, running, keep_until) VALUES (?, 1, ?, 1, 0) ' +
              'ON CONFLICT (name) DO UPDATE SET generation = datafridge_flight.generation + 1, ' +
              'expires_at = excluded.expires_at, running = 1 ' +
              'WHERE datafridge_flight.running = 0 OR datafridge_flight.expires_at <= ? ' +
              'RETURNING generation',
          )
          .bind(key, expiresAt, now)
          .first<{ generation: number }>()
        if (led) return { role: 'leader', generation: led.generation }
        const record = await db
          .prepare('SELECT generation FROM datafridge_flight WHERE name = ?')
          .bind(key)
          .first<{ generation: number }>()
        // The row vanished between the two statements, so nothing is running.
        if (!record) return { role: 'leader', generation: 1 }
        return { role: 'follower', generation: record.generation }
      })
    },

    async readFlight(key, now) {
      return withSchema(db, async () => {
        const record = await db
          .prepare(
            'SELECT generation, expires_at, running, settled_generation, outcome, keep_until ' +
              'FROM datafridge_flight WHERE name = ?',
          )
          .bind(key)
          .first<FlightRecord>()
        if (!record) return null
        return {
          running: record.running === 1 && record.expires_at > now ? record.generation : null,
          settled:
            record.settled_generation !== null && record.outcome !== null && record.keep_until > now
              ? {
                  generation: record.settled_generation,
                  outcome: JSON.parse(record.outcome) as FlightOutcome,
                }
              : null,
        }
      })
    },

    async settleFlight(key, generation, outcome, keepUntil) {
      return withSchema(db, async () => {
        const settled = await db
          .prepare(
            'UPDATE datafridge_flight SET running = 0, settled_generation = ?, outcome = ?, ' +
              'keep_until = ? WHERE name = ? AND generation = ? AND running = 1',
          )
          .bind(generation, JSON.stringify(outcome), keepUntil, key, generation)
          .run()
        return settled.meta.changes === 1
      })
    },

    async sweepFlights(before, limit) {
      return withSchema(db, async () => {
        const swept = await db
          .prepare(
            'DELETE FROM datafridge_flight WHERE name IN (SELECT name FROM datafridge_flight ' +
              'WHERE keep_until <= ? AND (running = 0 OR expires_at <= ?) LIMIT ?)',
          )
          .bind(before, before, limit)
          .run()
        return swept.meta.changes
      })
    },

    async listDue(now, limit) {
      return withSchema(db, async () => {
        const { results } = await db
          .prepare(
            'SELECT * FROM datafridge_schedule WHERE next_run_at <= ? ' +
              'ORDER BY next_run_at, name LIMIT ?',
          )
          .bind(now, limit)
          .run<ScheduleRecord>()
        return results.map(toScheduleRow)
      })
    },
  }
}
