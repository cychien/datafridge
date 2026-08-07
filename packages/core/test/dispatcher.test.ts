import { describe, expect, it } from 'vitest'

import { defineQueries, FakeClock, memoryStore } from '../src/index.js'
import type { QueryDef, SourcePolicy, Store } from '../src/index.js'
import { deferred, makeHarness } from './helpers.js'

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
    acquirePermit: (source, limit, holder, expiresAt, now) =>
      note('acquirePermit', source, () =>
        inner.acquirePermit(source, limit, holder, expiresAt, now),
      ),
    releasePermit: (source, holder) =>
      note('releasePermit', source, () => inner.releasePermit(source, holder)),
    joinFlight: (key, expiresAt, now) =>
      note('joinFlight', key, () => inner.joinFlight(key, expiresAt, now)),
    readFlight: (key, now) => note('readFlight', key, () => inner.readFlight(key, now)),
    settleFlight: (key, generation, outcome, keepUntil) =>
      note('settleFlight', key, () => inner.settleFlight(key, generation, outcome, keepUntil)),
    sweepFlights: (before, limit) =>
      note('sweepFlights', '*', () => inner.sweepFlights(before, limit)),
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

describe('the lease a dispatch writes', () => {
  it('outlives the call by the whole margin declared, however slow the claim is', async () => {
    const clock = new FakeClock(0)
    const inner = memoryStore()
    const roundTrip = deferred<void>()
    let leasedUntil = 0
    const slowClaim: Store = {
      ...inner,
      claim: async (name, expectedVersion, leaseUntil, now) => {
        leasedUntil = leaseUntil
        await roundTrip.promise
        return inner.claim(name, expectedVersion, leaseUntil, now)
      },
    }
    let abortedAt = -1
    const hangs: QueryDef[] = [
      {
        name: 'q',
        every: '5m',
        timeout: '30s',
        lease: '35s',
        fetch: async ({ signal }) => {
          signal.addEventListener('abort', () => {
            abortedAt = clock.now()
          })
          return new Promise<string>(() => {})
        },
      },
    ]
    const { fridge } = makeHarness(hangs, { store: slowClaim, clock })

    const run = fridge.runDue()
    await clock.advance(0)
    // The claim round trip alone outlasts the five seconds between this query's
    // timeout and its lease.
    await clock.advance(10_000)
    roundTrip.resolve()
    await clock.advance(0)
    expect(leasedUntil).toBe(35_000)

    await clock.advance(20_000)
    // The claim's own latency came out of the call's budget, not out of the
    // margin: the call is over with the whole declared margin still to run, so
    // no peer can reclaim this row while it is still talking to upstream.
    expect(abortedAt).toBe(30_000)
    expect(leasedUntil - abortedAt).toBe(5_000)
    expect((await run).failed).toHaveLength(1)
  })
})

describe('a store that fails a dispatch before it reaches upstream', () => {
  const metered = (store: Store, sources: Record<string, SourcePolicy>) =>
    makeHarness([{ name: 'q', every: '5m', source: 'posthog', fetch: async () => 'v1' }], {
      store,
      sources,
    })

  it('is reported, not lost between the dispatch and the tick', async () => {
    const inner = memoryStore()
    const brittle: Store = {
      ...inner,
      takeQuota: async () => {
        throw new Error('D1_ERROR: network connection lost')
      },
    }
    const { fridge } = metered(brittle, { posthog: { limit: { requests: 5, per: '1m' } } })

    const report = await fridge.runDue()

    expect(report.failed).toEqual([{ name: 'q', message: 'D1_ERROR: network connection lost' }])
    expect(report.ran).toEqual([])
    // Nothing was claimed, so the row is exactly as due as it was.
    expect(await inner.readSchedule('q')).toBeNull()
  })

  it('hands back the quota it took on the way to failing', async () => {
    const inner = memoryStore()
    const brittle: Store = {
      ...inner,
      acquirePermit: async () => {
        throw new Error('D1_ERROR: network connection lost')
      },
    }
    const { fridge } = metered(brittle, {
      posthog: { limit: { requests: 1, per: '1m' }, maxConcurrent: 1 },
    })

    const report = await fridge.runDue()

    expect(report.failed).toEqual([{ name: 'q', message: 'D1_ERROR: network connection lost' }])
    // Nothing reached upstream, so the window's single call is still there.
    expect(await inner.takeQuota('posthog', 1, 60_000, 0)).toBe(true)
  })
})
