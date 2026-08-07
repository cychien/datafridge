import type { ResolvedQuery, ScheduleRow } from './types.js'

export interface Candidate {
  query: ResolvedQuery
  row: ScheduleRow
}

/** What the tick knows about a row: the row itself, or `null` for no row. */
export interface RowLookup {
  get(name: string): ScheduleRow | null | undefined
}

export function virtualRow(name: string, now: number): ScheduleRow {
  return { name, nextRunAt: now, failCount: 0, leaseUntil: null, version: 0 }
}

/**
 * The tick's due work, most overdue first. Priority is the overdue *ratio*
 * `(now - nextRunAt) / every`, so a query squeezed out by a source's quota or
 * by an invocation running out of wall clock climbs every tick it waits and
 * cannot starve behind a faster-cycling one.
 *
 * A query with no row has never run, so it is due now. The tick establishes
 * that by name before planning - an unread name is never guessed at, because
 * guessing either re-claims a row that exists or never starts one that does not.
 *
 * How much of this work upstream and the invocation will actually accept is
 * decided after it, not here.
 */
export function planTick(
  queries: readonly ResolvedQuery[],
  rows: RowLookup,
  now: number,
): Candidate[] {
  const due: Array<Candidate & { overdueRatio: number }> = []
  for (const query of queries) {
    const row = rows.get(query.name) ?? virtualRow(query.name, now)
    if (row.nextRunAt > now) continue
    due.push({ query, row, overdueRatio: (now - row.nextRunAt) / query.everyMs })
  }
  due.sort((a, b) => b.overdueRatio - a.overdueRatio)
  return due.map(({ query, row }) => ({ query, row }))
}
