import type { Envelope, ScheduleRow, Store } from '@datafridge/core'
import { D1_SCHEMA } from './schema.js'

// D1's documented maximum string/BLOB/row size (developers.cloudflare.com/d1/platform/limits).
const D1_MAX_ROW_BYTES = 2_000_000

type ScheduleRecord = {
  name: string
  next_run_at: number
  fail_count: number
  lease_until: number | null
  version: number
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
  }
}

export function d1(db: D1Database): Store {
  return {
    capabilities: { atomicClaim: true, listDue: true },

    // The read path never applies schema: staying a single SELECT is the whole
    // point. Before anything has been written the table may not exist, which is
    // the same answer as an empty one - but only that error is an empty answer.
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
      return withSchema(db, async () => {
        const record = await db
          .prepare('SELECT * FROM datafridge_schedule WHERE name = ?')
          .bind(name)
          .first<ScheduleRecord>()
        return record ? toScheduleRow(record) : null
      })
    },

    async writeSchedule(row) {
      return withSchema(db, async () => {
        await db
          .prepare(
            'INSERT INTO datafridge_schedule (name, next_run_at, fail_count, lease_until, version) ' +
              'VALUES (?, ?, ?, ?, ?) ' +
              'ON CONFLICT (name) DO UPDATE SET next_run_at = excluded.next_run_at, ' +
              'fail_count = excluded.fail_count, lease_until = excluded.lease_until, ' +
              'version = excluded.version',
          )
          .bind(row.name, row.nextRunAt, row.failCount, row.leaseUntil, row.version)
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
              'INSERT INTO datafridge_schedule (name, next_run_at, fail_count, lease_until, version) ' +
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
