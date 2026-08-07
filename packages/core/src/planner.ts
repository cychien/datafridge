import type { ResolvedQuery, ScheduleRow } from './types.js'

export interface Candidate {
  query: ResolvedQuery
  row: ScheduleRow
}

/**
 * What the tick knows about a row: the row itself, `null` for one it has
 * established does not exist, `undefined` for one it never read.
 */
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
 * A query the tick never read a row for is due now only when the tick read
 * every row there is (`pageWasFull` false). Once the page is full, an unread
 * name is a name whose row sorts after everything read, and treating it as
 * never-run would claim against a version that has moved on.
 *
 * How much of this work upstream and the invocation will actually accept is
 * decided after it, not here.
 */
export function planTick(
  queries: readonly ResolvedQuery[],
  rows: RowLookup,
  now: number,
  pageWasFull: boolean,
): Candidate[] {
  const due: Array<Candidate & { overdueRatio: number }> = []
  for (const query of queries) {
    const known = rows.get(query.name)
    if (known === undefined && pageWasFull) continue
    const row = known ?? virtualRow(query.name, now)
    if (row.nextRunAt > now) continue
    due.push({ query, row, overdueRatio: (now - row.nextRunAt) / query.everyMs })
  }
  due.sort((a, b) => b.overdueRatio - a.overdueRatio)
  return due.map(({ query, row }) => ({ query, row }))
}
