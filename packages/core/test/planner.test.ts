import { describe, expect, it } from 'vitest'

import { defineQueries } from '../src/index.js'
import { planTick } from '../src/planner.js'
import type { RowLookup } from '../src/planner.js'
import type { ScheduleRow } from '../src/index.js'

const fetch = async () => 'data'

function row(name: string, nextRunAt: number): [string, ScheduleRow] {
  return [name, { name, nextRunAt, failCount: 0, leaseUntil: null, version: 1 }]
}

function lookup(entries: Iterable<readonly [string, ScheduleRow | null]>): RowLookup {
  const known = new Map(entries)
  return { get: (name) => known.get(name) }
}

describe('planTick', () => {
  it('treats a row it knows is absent as immediately due, and skips future rows', () => {
    const queries = defineQueries([
      { name: 'new', every: '5m', fetch },
      { name: 'future', every: '5m', fetch },
    ])
    const rows = lookup([row('future', 2_000), ['new', null]])
    const plan = planTick(queries.all, rows, 1_000)
    expect(plan.map((c) => c.query.name)).toEqual(['new'])
    expect(plan[0]!.row).toEqual({
      name: 'new',
      nextRunAt: 1_000,
      failCount: 0,
      leaseUntil: null,
      version: 0,
    })
  })

  it('orders by overdue ratio, not absolute lateness', () => {
    const queries = defineQueries([
      { name: 'hourly', every: '60m', fetch },
      { name: 'fast', every: '5m', fetch },
    ])
    const now = 1_000_000
    const rows = lookup([row('hourly', now - 300_000), row('fast', now - 240_000)])
    expect(planTick(queries.all, rows, now).map((c) => c.query.name)).toEqual(['fast', 'hourly'])
  })

  it('keeps registration order on ties', () => {
    const queries = defineQueries([
      { name: 'a', every: '5m', fetch },
      { name: 'b', every: '5m', fetch },
    ])
    const rows = lookup([row('a', 0), row('b', 0)])
    expect(planTick(queries.all, rows, 0).map((c) => c.query.name)).toEqual(['a', 'b'])
  })

  it('treats a query with no row as never-run, so a new one starts at once', () => {
    const queries = defineQueries([{ name: 'fresh', every: '5m', fetch }])
    expect(
      planTick(queries.all, lookup([['fresh', null]]), 1_000).map((c) => c.query.name),
    ).toEqual(['fresh'])
  })
})
