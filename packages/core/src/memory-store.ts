import type { Envelope, ScheduleRow, Store } from './types.js'

// JSON round-trips enforce the design rule that envelopes stay purely
// JSON-serializable, and give callers isolated copies.
function cloneEnvelope(env: Envelope): Envelope {
  return JSON.parse(JSON.stringify(env)) as Envelope
}

export function memoryStore(): Store {
  const results = new Map<string, Envelope>()
  const rows = new Map<string, ScheduleRow>()

  return {
    capabilities: { atomicClaim: true, listDue: true },

    async readResult(name) {
      const env = results.get(name)
      return env ? cloneEnvelope(env) : null
    },

    async writeResult(name, env) {
      results.set(name, cloneEnvelope(env))
    },

    async deleteResult(name) {
      results.delete(name)
    },

    async readSchedule(name) {
      const row = rows.get(name)
      return row ? { ...row } : null
    },

    async writeSchedule(row) {
      rows.set(row.name, { ...row })
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

    async listDue(now, limit) {
      return [...rows.values()]
        .filter((row) => row.nextRunAt <= now)
        .sort((a, b) => a.nextRunAt - b.nextRunAt)
        .slice(0, limit)
        .map((row) => ({ ...row }))
    },
  }
}
