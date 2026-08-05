import { describe, expect, it } from 'vitest'

import { defineQueries } from '../src/index.js'
import { planTick } from '../src/planner.js'
import type { ScheduleRow } from '../src/index.js'

const fetch = async () => 'data'

function row(name: string, nextRunAt: number): [string, ScheduleRow] {
  return [name, { name, nextRunAt, failCount: 0, leaseUntil: null, version: 1 }]
}

describe('planTick', () => {
  it('treats missing rows as immediately due and skips future rows', () => {
    const queries = defineQueries([
      { name: 'new', every: '5m', fetch },
      { name: 'future', every: '5m', fetch },
    ])
    const rows = new Map([
      ['future', row('future', 2_000)[1]],
      ['new', null],
    ])
    const plan = planTick(queries.all, rows, 1_000, undefined)
    expect(plan.toRun.map((c) => c.query.name)).toEqual(['new'])
    expect(plan.toRun[0]!.row).toEqual({
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
    const rows = new Map([row('hourly', now - 300_000), row('fast', now - 240_000)])
    const plan = planTick(queries.all, rows, now, undefined)
    expect(plan.toRun.map((c) => c.query.name)).toEqual(['fast', 'hourly'])
  })

  it('keeps registration order on ties', () => {
    const queries = defineQueries([
      { name: 'a', every: '5m', fetch },
      { name: 'b', every: '5m', fetch },
    ])
    const rows = new Map([row('a', 0), row('b', 0)])
    const plan = planTick(queries.all, rows, 0, undefined)
    expect(plan.toRun.map((c) => c.query.name)).toEqual(['a', 'b'])
  })

  it('applies per-source budgets independently', () => {
    const queries = defineQueries([
      { name: 'p1', every: '5m', source: 'posthog', fetch },
      { name: 'p2', every: '5m', source: 'posthog', fetch },
      { name: 'p3', every: '5m', source: 'posthog', fetch },
      { name: 's1', every: '5m', source: 'stripe', fetch },
    ])
    const now = 300_000
    const rows = new Map([row('p1', 0), row('p2', 100), row('p3', 200), row('s1', 300)])
    const plan = planTick(queries.all, rows, now, { posthog: { maxPerTick: 2 } })
    expect(plan.toRun.map((c) => c.query.name)).toEqual(['p1', 'p2', 's1'])
    expect(plan.deferredBudget).toEqual(['p3'])
  })
})
