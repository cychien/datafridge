import type { ResolvedQuery, ScheduleRow } from './types.js'

export interface Candidate {
  query: ResolvedQuery
  row: ScheduleRow
}

export interface TickPlan {
  toRun: Candidate[]
  /** Due, but past this tick's capacity. Untouched, so still due next tick. */
  deferred: string[]
}

export function virtualRow(name: string, now: number): ScheduleRow {
  return { name, nextRunAt: now, failCount: 0, leaseUntil: null, version: 0 }
}

/**
 * The tick's due work, most overdue first, up to `limit` of it. Priority is the
 * overdue *ratio* `(now - nextRunAt) / every`, so a query squeezed out by a
 * source's quota or by this tick's capacity climbs every tick it waits and
 * cannot starve behind a faster-cycling one. How much of that work upstream
 * will actually accept is the dispatcher's question, not this one's.
 */
export function planTick(
  queries: readonly ResolvedQuery[],
  rowsByName: ReadonlyMap<string, ScheduleRow | null>,
  now: number,
  limit: number,
): TickPlan {
  const due: Array<Candidate & { overdueRatio: number }> = []
  for (const query of queries) {
    const row = rowsByName.get(query.name) ?? virtualRow(query.name, now)
    if (row.nextRunAt > now) continue
    due.push({ query, row, overdueRatio: (now - row.nextRunAt) / query.everyMs })
  }
  due.sort((a, b) => b.overdueRatio - a.overdueRatio)
  return {
    toRun: due.slice(0, limit).map(({ query, row }) => ({ query, row })),
    deferred: due.slice(limit).map(({ query }) => query.name),
  }
}
