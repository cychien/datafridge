import type { Envelope, ScheduleRow, Store } from '@datafridge/core'

// D1's documented maximum string/BLOB/row size (developers.cloudflare.com/d1/platform/limits).
const D1_MAX_ROW_BYTES = 2_000_000

type ScheduleRecord = {
  name: string
  next_run_at: number
  fail_count: number
  lease_until: number | null
  version: number
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

    async readResult(name) {
      const record = await db
        .prepare('SELECT envelope FROM datafridge_results WHERE name = ?')
        .bind(name)
        .first<{ envelope: string }>()
      return record ? (JSON.parse(record.envelope) as Envelope) : null
    },

    async writeResult(name, env) {
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
    },

    async deleteResult(name) {
      await db.prepare('DELETE FROM datafridge_results WHERE name = ?').bind(name).run()
    },

    async readSchedule(name) {
      const record = await db
        .prepare('SELECT * FROM datafridge_schedule WHERE name = ?')
        .bind(name)
        .first<ScheduleRecord>()
      return record ? toScheduleRow(record) : null
    },

    async writeSchedule(row) {
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
    },

    async deleteSchedule(name) {
      await db.prepare('DELETE FROM datafridge_schedule WHERE name = ?').bind(name).run()
    },

    async claim(name, expectedVersion, leaseUntil, now) {
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
    },

    async listDue(now, limit) {
      const { results } = await db
        .prepare(
          'SELECT * FROM datafridge_schedule WHERE next_run_at <= ? ' +
            'ORDER BY next_run_at, name LIMIT ?',
        )
        .bind(now, limit)
        .run<ScheduleRecord>()
      return results.map(toScheduleRow)
    },
  }
}
