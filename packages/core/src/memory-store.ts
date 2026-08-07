import type { Envelope, ScheduleRow, Store } from './types.js'

// JSON round-trips enforce the design rule that envelopes stay purely
// JSON-serializable, and give callers isolated copies.
function cloneEnvelope(env: Envelope): Envelope {
  return JSON.parse(JSON.stringify(env)) as Envelope
}

function cloneRow(row: ScheduleRow): ScheduleRow {
  return JSON.parse(JSON.stringify(row)) as ScheduleRow
}

export function memoryStore(): Store {
  const results = new Map<string, Envelope>()
  const lastReadAt = new Map<string, number>()
  const rows = new Map<string, ScheduleRow>()
  const quota = new Map<string, { windowStart: number; used: number }>()

  return {
    capabilities: { atomicClaim: true, listDue: true },

    async readResult(name) {
      const env = results.get(name)
      return env ? cloneEnvelope(env) : null
    },

    async writeResult(name, env) {
      results.set(name, cloneEnvelope(env))
      // A brand new entry counts as read when it lands, so a cold read that
      // creates one cannot lose it to eviction before anyone touches it.
      if (!lastReadAt.has(name)) lastReadAt.set(name, env.fetchedAt)
    },

    async deleteResult(name) {
      results.delete(name)
      lastReadAt.delete(name)
    },

    async touchResult(name, at) {
      if (results.has(name)) lastReadAt.set(name, at)
    },

    async evictIdleResults(keyPrefix, idleBefore) {
      const evicted: string[] = []
      for (const name of [...results.keys()]) {
        if (!name.startsWith(keyPrefix)) continue
        if ((lastReadAt.get(name) ?? 0) >= idleBefore) continue
        results.delete(name)
        lastReadAt.delete(name)
        evicted.push(name)
      }
      return evicted.sort()
    },

    async readSchedule(name) {
      const row = rows.get(name)
      return row ? cloneRow(row) : null
    },

    async writeSchedule(row) {
      rows.set(row.name, cloneRow(row))
    },

    async deleteSchedule(name) {
      rows.delete(name)
    },

    async claim(name, expectedVersion, leaseUntil, now) {
      const row = rows.get(name)
      if (!row) {
        if (expectedVersion !== 0) return false
        rows.set(name, { name, nextRunAt: now, failCount: 0, leaseUntil, version: 1 })
        return true
      }
      if (row.version !== expectedVersion) return false
      if (row.leaseUntil !== null && row.leaseUntil > now) return false
      row.version += 1
      row.leaseUntil = leaseUntil
      return true
    },

    async takeQuota(source, limit, windowMs, now) {
      const windowStart = Math.floor(now / windowMs) * windowMs
      const ledger = quota.get(source)
      // A window is never rewound: an executor whose clock lags must not reopen
      // one its peers have already closed and hand out the quota twice.
      const current =
        ledger !== undefined && ledger.windowStart >= windowStart
          ? ledger
          : { windowStart, used: 0 }
      if (current.used >= limit) return false
      quota.set(source, { windowStart: current.windowStart, used: current.used + 1 })
      return true
    },

    async releaseQuota(source, windowMs, takenAt) {
      const ledger = quota.get(source)
      if (ledger === undefined || ledger.used === 0) return
      // Usage belongs to the window it was taken in and cannot be moved out of
      // it, so a window that has already rolled keeps its count.
      if (ledger.windowStart !== Math.floor(takenAt / windowMs) * windowMs) return
      quota.set(source, { windowStart: ledger.windowStart, used: ledger.used - 1 })
    },

    async listDue(now, limit) {
      return [...rows.values()]
        .filter((row) => row.nextRunAt <= now)
        .sort((a, b) => a.nextRunAt - b.nextRunAt)
        .slice(0, limit)
        .map(cloneRow)
    },
  }
}
