import type { ResolvedQuery, ScheduleRow } from './types.js'

export interface Candidate {
  query: ResolvedQuery
  row: ScheduleRow
}

export function virtualRow(name: string, now: number): ScheduleRow {
  return { name, nextRunAt: now, failCount: 0, leaseUntil: null, version: 0 }
}

/**
 * The tick's due work, most overdue first. Priority is the overdue *ratio*
 * `(now - nextRunAt) / every`, so a query squeezed out by a source's quota
 * climbs every tick it waits and cannot starve behind a faster-cycling one.
 * How much of that work upstream will actually accept is the dispatcher's
 * question, not this one's.
 */
export function planTick(
  queries: readonly ResolvedQuery[],
  rowsByName: ReadonlyMap<string, ScheduleRow | null>,
  now: number,
): Candidate[] {
  const due: Array<Candidate & { overdueRatio: number }> = []
  for (const query of queries) {
    const row = rowsByName.get(query.name) ?? virtualRow(query.name, now)
    if (row.nextRunAt > now) continue
    due.push({ query, row, overdueRatio: (now - row.nextRunAt) / query.everyMs })
  }
  due.sort((a, b) => b.overdueRatio - a.overdueRatio)
  return due.map(({ query, row }) => ({ query, row }))
}
