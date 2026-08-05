import type { ResolvedQuery, ScheduleRow, SourceBudget } from './types.js'

export interface Candidate {
  query: ResolvedQuery
  row: ScheduleRow
}

export interface TickPlan {
  toRun: Candidate[]
  deferredBudget: string[]
}

export function virtualRow(name: string, now: number): ScheduleRow {
  return { name, nextRunAt: now, failCount: 0, leaseUntil: null, version: 0 }
}

export function planTick(
  queries: readonly ResolvedQuery[],
  rowsByName: ReadonlyMap<string, ScheduleRow | null>,
  now: number,
  sources: Readonly<Record<string, SourceBudget>> | undefined,
): TickPlan {
  const due: Array<Candidate & { overdueRatio: number }> = []
  for (const query of queries) {
    const row = rowsByName.get(query.name) ?? virtualRow(query.name, now)
    if (row.nextRunAt > now) continue
    due.push({ query, row, overdueRatio: (now - row.nextRunAt) / query.everyMs })
  }
  due.sort((a, b) => b.overdueRatio - a.overdueRatio)

  const usedPerSource = new Map<string, number>()
  const toRun: Candidate[] = []
  const deferredBudget: string[] = []
  for (const { query, row } of due) {
    const budget = sources?.[query.source]?.maxPerTick ?? Infinity
    const used = usedPerSource.get(query.source) ?? 0
    if (used < budget) {
      usedPerSource.set(query.source, used + 1)
      toRun.push({ query, row })
    } else {
      deferredBudget.push(query.name)
    }
  }
  return { toRun, deferredBudget }
}
