import type { Envelope, FlightOutcome, ScheduleRow, Store } from './types.js'

interface FlightRecord {
  generation: number
  expiresAt: number
  running: boolean
  settledGeneration: number | null
  outcome: FlightOutcome | null
  keepUntil: number
}

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
  const rows = new Map<string, ScheduleRow>()
  const quota = new Map<string, { windowStart: number; used: number }>()
  const permits = new Map<string, { source: string; expiresAt: number }>()
  const flights = new Map<string, FlightRecord>()

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
      return row ? cloneRow(row) : null
    },

    async readSchedules(names) {
      return names.map((name) => {
        const row = rows.get(name)
        return row ? cloneRow(row) : null
      })
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

    async acquirePermit(source, limit, holder, expiresAt, now) {
      let live = 0
      let soonest = Infinity
      for (const [key, permit] of [...permits]) {
        if (permit.expiresAt <= now) {
          permits.delete(key)
          continue
        }
        if (permit.source !== source) continue
        live += 1
        soonest = Math.min(soonest, permit.expiresAt)
      }
      // One id is one call's claim on one permit. Two callers arriving with the
      // same id are still two callers, so the second is refused rather than
      // sharing a row - and told the source itself has room.
      if (permits.has(holder)) return { granted: false, retryAt: now }
      if (live >= limit) {
        return { granted: false, retryAt: soonest === Infinity ? now : soonest }
      }
      permits.set(holder, { source, expiresAt })
      return { granted: true }
    },

    async releasePermit(_source, holder) {
      permits.delete(holder)
    },

    async joinFlight(key, expiresAt, now) {
      const record = flights.get(key)
      if (record !== undefined && record.running && record.expiresAt > now) {
        return { role: 'follower', generation: record.generation }
      }
      const generation = (record?.generation ?? 0) + 1
      flights.set(key, {
        generation,
        expiresAt,
        running: true,
        // A settled answer outlives the flight that produced it, so the cohort
        // still reading it is not cut off by the next caller starting a new one.
        settledGeneration: record?.settledGeneration ?? null,
        outcome: record?.outcome ?? null,
        keepUntil: record?.keepUntil ?? 0,
      })
      return { role: 'leader', generation }
    },

    async readFlight(key, now) {
      const record = flights.get(key)
      if (record === undefined) return null
      return {
        running: record.running && record.expiresAt > now ? record.generation : null,
        settled:
          record.settledGeneration !== null && record.outcome !== null && record.keepUntil > now
            ? {
                generation: record.settledGeneration,
                outcome: JSON.parse(JSON.stringify(record.outcome)) as FlightOutcome,
              }
            : null,
      }
    },

    async settleFlight(key, generation, outcome, keepUntil) {
      const record = flights.get(key)
      if (record === undefined || record.generation !== generation || !record.running) return false
      flights.set(key, {
        ...record,
        running: false,
        settledGeneration: generation,
        outcome: JSON.parse(JSON.stringify(outcome)) as FlightOutcome,
        keepUntil,
      })
      return true
    },

    async sweepFlights(before, limit) {
      let swept = 0
      for (const [key, record] of [...flights]) {
        if (swept >= limit) break
        if (record.running && record.expiresAt > before) continue
        if (record.keepUntil > before) continue
        flights.delete(key)
        swept += 1
      }
      return swept
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
