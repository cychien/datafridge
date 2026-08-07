import { describe, expect, it } from 'vitest'

import { defineQueries, memoryStore } from '../src/index.js'
import type { QueryDef, SourcePolicy, Store } from '../src/index.js'
import { makeHarness } from './helpers.js'

function tracing(inner: Store, log: string[]): Store {
  const note = <T>(op: string, name: string, run: () => Promise<T>): Promise<T> => {
    log.push(`${op}:${name}`)
    return run()
  }
  return {
    capabilities: inner.capabilities,
    readResult: (name) => note('readResult', name, () => inner.readResult(name)),
    writeResult: (name, env) => note('writeResult', name, () => inner.writeResult(name, env)),
    deleteResult: (name) => note('deleteResult', name, () => inner.deleteResult(name)),
    readSchedule: (name) => note('readSchedule', name, () => inner.readSchedule(name)),
    writeSchedule: (row) => note('writeSchedule', row.name, () => inner.writeSchedule(row)),
    deleteSchedule: (name) => note('deleteSchedule', name, () => inner.deleteSchedule(name)),
    claim: (name, expectedVersion, leaseUntil, now) =>
      note('claim', name, () => inner.claim(name, expectedVersion, leaseUntil, now)),
    takeQuota: (source, limit, windowMs, now) =>
      note('takeQuota', source, () => inner.takeQuota(source, limit, windowMs, now)),
    releaseQuota: (source, windowMs, takenAt) =>
      note('releaseQuota', source, () => inner.releaseQuota(source, windowMs, takenAt)),
    listDue: (now, limit) => note('listDue', '*', () => inner.listDue!(now, limit)),
  }
}

/** From the claim that opens a dispatch to the schedule row that closes it. */
function dispatchOf(log: string[]): string[] {
  return log.slice(log.indexOf('claim:q'), log.indexOf('writeSchedule:q') + 1)
}

const query = (fetch: () => Promise<string>): QueryDef[] => [
  { name: 'q', every: '5m', timeout: '30s', fetch },
]

/**
 * Rate limiting, coalescing and backoff are about to grow in one place, so what
 * has to hold is that there is only one place: a scheduled refresh and a read
 * miss must be the same work arriving through different doors, not two code
 * paths that happen to agree today.
 */
describe('the dispatcher is the only exit to upstream', () => {
  it('a scheduled tick and a read miss share one claim and write-back sequence', async () => {
    const scheduledLog: string[] = []
    const scheduled = makeHarness(defineQueries(query(async () => 'v1')), {
      store: tracing(memoryStore(), scheduledLog),
    })
    expect((await scheduled.fridge.runDue()).ran).toEqual(['q'])

    const demandLog: string[] = []
    const demand = makeHarness(defineQueries(query(async () => 'v1')), {
      store: tracing(memoryStore(), demandLog),
    })
    const read = demand.fridge.read<string>('q')
    await demand.clock.advance(0)
    expect(await read).toMatchObject({ data: 'v1' })

    expect(dispatchOf(scheduledLog)).toEqual([
      'claim:q',
      'readSchedule:q',
      'writeResult:q',
      'writeSchedule:q',
    ])
    expect(dispatchOf(demandLog)).toEqual(dispatchOf(scheduledLog))
    expect(demandLog.filter((op) => op === 'claim:q')).toHaveLength(1)
  })

  it('meters both doors at the same gate, before either takes a lease', async () => {
    const sources: Record<string, SourcePolicy> = {
      posthog: { limit: { requests: 5, per: '1m' } },
    }
    const metered = (fetch: () => Promise<string>): QueryDef[] => [
      { ...query(fetch)[0]!, source: 'posthog' },
    ]

    const scheduledLog: string[] = []
    const scheduled = makeHarness(defineQueries(metered(async () => 'v1')), {
      store: tracing(memoryStore(), scheduledLog),
      sources,
    })
    await scheduled.fridge.runDue()

    const demandLog: string[] = []
    const demand = makeHarness(defineQueries(metered(async () => 'v1')), {
      store: tracing(memoryStore(), demandLog),
      sources,
    })
    const read = demand.fridge.read('q')
    await demand.clock.advance(0)
    await read

    for (const log of [scheduledLog, demandLog]) {
      expect(log.filter((op) => op === 'takeQuota:posthog')).toHaveLength(1)
      expect(log.indexOf('takeQuota:posthog')).toBeLessThan(log.indexOf('claim:q'))
    }
  })

  it('a failed read miss backs off exactly as a failed tick does', async () => {
    const down = async (): Promise<string> => {
      throw new Error('upstream down')
    }
    const scheduled = makeHarness(defineQueries(query(down)))
    await scheduled.fridge.runDue()

    const demand = makeHarness(defineQueries(query(down)))
    const read = demand.fridge.read('q')
    await demand.clock.advance(0)
    expect(await read).toBeNull()

    expect(await demand.store.readSchedule('q')).toEqual(await scheduled.store.readSchedule('q'))
  })
})
