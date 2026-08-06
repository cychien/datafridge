import { backoffMs, MAX_JITTER_RATIO } from './backoff.js'
import type { Clock } from './clock.js'
import { defineQueries, Queries, resolveMemberBy, resolveVariantsWithin } from './define-queries.js'
import type { DynamicVariants } from './define-queries.js'
import { createDispatcher } from './dispatcher.js'
import type { DispatchOutcome } from './dispatcher.js'
import { ConfigError } from './errors.js'
import { planTick, virtualRow } from './planner.js'
import { queryKey, variantBaseOf } from './query-key.js'
import { decodeRead, shapeRead, waitForEnvelope } from './reader.js'
import { systemClock, systemRandom } from './system-clock.js'
import type {
  Driver,
  QueryDefinition,
  QueryParams,
  ReadResult,
  ResolvedQuery,
  RunReport,
  SchedulePlane,
  ScheduleRow,
  SourceBudget,
  Store,
} from './types.js'

export interface FridgeConfig {
  queries: Queries | readonly QueryDefinition[]
  driver: Driver
  store: Store
  clock?: Clock
  sources?: Record<string, SourceBudget>
  random?: () => number
}

export interface Fridge {
  runDue(now?: number): Promise<RunReport>
  read<T = unknown>(name: string, params?: QueryParams): Promise<ReadResult<T> | null>
}

export function createFridge(config: FridgeConfig): Fridge {
  const queries = config.queries instanceof Queries ? config.queries : defineQueries(config.queries)
  const driver = validateDriver(config.driver)
  const clock = validateClock(config.clock ?? systemClock)
  const sources = validateSources(config.sources)
  const { store, schedule } = resolveStores(config, driver)
  const random = config.random ?? systemRandom
  const dispatcher = createDispatcher({ store, schedule, clock, random })

  interface EffectiveRegistry {
    list: readonly ResolvedQuery[]
    byKey: ReadonlyMap<string, ResolvedQuery>
    failures: Array<{ name: string; message: string }>
    unresolvedBases: ReadonlySet<string>
  }

  type Attempt = { dynamic: DynamicVariants; row: ScheduleRow | null } & (
    | { kind: 'backoff' }
    | { kind: 'resolved'; params: readonly QueryParams[] }
    | { kind: 'failed'; message: string }
  )

  /**
   * The tick's working set: every static query plus each dynamic definition's
   * variant list as of right now. A resolution failure removes nothing - the
   * base keeps whatever it already has, the failure lands in the report, and
   * the base backs off in a schedule row of its own, exactly as a failed fetch
   * does. That row is keyed by the base name, which no variant key can collide
   * with: variants are minted under the reserved '@df/v1/' prefix.
   *
   * Bases resolve concurrently so three hung lists cost one timeout rather than
   * three, but they are expanded in registry order so which base is blamed for
   * a duplicate key does not depend on who answered first.
   */
  const resolveEffective = async (now: number): Promise<EffectiveRegistry> => {
    const list: ResolvedQuery[] = [...queries.all]
    const byKey = new Map(queries.all.map((query) => [query.name, query]))
    const failures: Array<{ name: string; message: string }> = []
    const unresolvedBases = new Set<string>()

    const failBase = async (attempt: Attempt, message: string): Promise<void> => {
      const { dynamic, row } = attempt
      failures.push({ name: dynamic.baseName, message })
      unresolvedBases.add(dynamic.baseName)
      const failCount = (row?.failCount ?? 0) + 1
      // Stamped when the row is written, not when the tick began: resolution
      // may have spent the base's whole timeout getting here, and a backoff
      // written into the past is no backoff at all.
      await schedule.writeSchedule({
        name: dynamic.baseName,
        nextRunAt: clock.now() + backoffMs(failCount, dynamic.everyMs, random),
        failCount,
        leaseUntil: null,
        version: (row?.version ?? 0) + 1,
      })
    }

    const attempts = await Promise.all(
      queries.dynamic.map(async (dynamic): Promise<Attempt> => {
        const row = await schedule.readSchedule(dynamic.baseName)
        if (row && row.nextRunAt > now) return { dynamic, row, kind: 'backoff' }
        try {
          return {
            dynamic,
            row,
            kind: 'resolved',
            params: await resolveVariantsWithin(dynamic, clock),
          }
        } catch (err) {
          return { dynamic, row, kind: 'failed', message: errorMessage(err) }
        }
      }),
    )

    for (const attempt of attempts) {
      const { dynamic, row } = attempt
      if (attempt.kind === 'backoff') {
        unresolvedBases.add(dynamic.baseName)
        continue
      }
      if (attempt.kind === 'failed') {
        await failBase(attempt, attempt.message)
        continue
      }
      try {
        const additions: ResolvedQuery[] = []
        const seen = new Set<string>()
        for (const params of attempt.params) {
          const query = dynamic.instantiate(params)
          if (byKey.has(query.name) || seen.has(query.name)) {
            throw new ConfigError(`query '${dynamic.baseName}': duplicate variant params`)
          }
          seen.add(query.name)
          additions.push(query)
        }
        for (const query of additions) {
          byKey.set(query.name, query)
          list.push(query)
        }
        if (row) await schedule.deleteSchedule(dynamic.baseName)
      } catch (err) {
        await failBase(attempt, errorMessage(err))
      }
    }
    return { list, byKey, failures, unresolvedBases }
  }

  const reconcile = async (now: number, effective: EffectiveRegistry): Promise<void> => {
    if (schedule.capabilities.listDue && schedule.listDue) {
      const all = await schedule.listDue(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      for (const row of all) {
        if (effective.byKey.has(row.name)) continue
        // A dynamic base's own row is backoff bookkeeping, not a departed variant.
        if (queries.dynamicFor(row.name)) continue
        const base = variantBaseOf(row.name)
        if (base !== undefined && effective.unresolvedBases.has(base)) continue
        await schedule.deleteSchedule(row.name)
        await store.deleteResult(row.name)
      }
    }
    for (const query of effective.list) {
      const row = await schedule.readSchedule(query.name)
      if (!row || row.failCount > 0) continue
      if (row.leaseUntil !== null && row.leaseUntil > now) continue
      // Only an `every` shrink needs fixing here; growth self-heals with one
      // early run that reschedules at the new period.
      if (row.nextRunAt <= now + query.everyMs * (1 + MAX_JITTER_RATIO)) continue
      const env = await store.readResult(query.name)
      await schedule.writeSchedule({
        ...row,
        nextRunAt: (env ? env.fetchedAt : now) + query.everyMs,
      })
    }
  }

  /**
   * Nothing is stored yet and the caller is willing to wait. Fetch it here when
   * nobody else is on it, otherwise wait for whoever is - the lease keeps that
   * to one upstream call however many readers arrive at once. The deadline is
   * the read's, already net of whatever membership resolution spent; a fetch
   * that outlives it keeps going and lands for the next read.
   */
  const readThrough = async <T>(
    query: ResolvedQuery,
    key: string,
    deadline: number,
  ): Promise<ReadResult<T> | null> => {
    const start = clock.now()
    const row = (await schedule.readSchedule(key)) ?? virtualRow(key, start)
    const leaseHeld = row.leaseUntil !== null && row.leaseUntil > start

    if (!leaseHeld) {
      // Backoff after a failed attempt: nothing is running and nothing is due,
      // so waiting would only spend the budget.
      if (row.nextRunAt > start) return null

      let outcome: DispatchOutcome | undefined
      const running = dispatcher
        .run({ query, row, priority: 'demand' }, start)
        .then((result) => {
          outcome = result
        })
        .catch(() => {})
      driver.defer(running)
      const settled = await within(running, deadline)
      if (!settled || outcome === undefined || outcome.status === 'failed') return null
      if (outcome.status === 'ran') {
        return shapeRead<T>(await store.readResult(key), clock.now())
      }
      // Lost the claim to an executor that got there first: wait for it.
    }

    const waited = await waitForEnvelope((k) => store.readResult(k), key, deadline, clock)
    return shapeRead<T>(waited, clock.now())
  }

  const within = (promise: Promise<unknown>, deadline: number): Promise<boolean> =>
    new Promise((resolve) => {
      let done = false
      const finish = (settled: boolean): void => {
        if (done) return
        done = true
        resolve(settled)
      }
      const handle = clock.setTimeout(() => finish(false), Math.max(0, deadline - clock.now()))
      promise.then(
        () => {
          clock.clearTimeout(handle)
          finish(true)
        },
        () => {
          clock.clearTimeout(handle)
          finish(true)
        },
      )
    })

  return {
    async runDue(nowArg?: number): Promise<RunReport> {
      const effective = await resolveEffective(nowArg ?? clock.now())
      // Resolution can legitimately spend a base's whole timeout, so dueness,
      // reconciliation and leases work from a timestamp taken after it. A
      // caller who supplied one owns the tick's clock and is never overridden.
      const now = nowArg ?? clock.now()
      await reconcile(now, effective)
      const rowsByName = new Map(
        await Promise.all(
          effective.list.map(async (q) => [q.name, await schedule.readSchedule(q.name)] as const),
        ),
      )
      const { toRun, deferredBudget } = planTick(effective.list, rowsByName, now, sources)
      const report = emptyReport()
      report.failed.push(...effective.failures)
      report.deferredBudget.push(...deferredBudget)
      await Promise.allSettled(
        toRun.map(async (candidate) => {
          const outcome = await dispatcher.run({ ...candidate, priority: 'scheduled' }, now)
          recordOutcome(report, candidate.query.name, outcome)
        }),
      )
      return report
    },

    async read<T>(name: string, params?: QueryParams): Promise<ReadResult<T> | null> {
      const key = queryKey(name, params)
      let query = queries.getByKey(key)
      const dynamic = query ? undefined : queries.dynamicFor(name)
      if (!query && !dynamic) throw new ConfigError(`unknown query '${name}'`)
      const codec = query?.codec ?? dynamic?.codec
      const shaped = shapeRead<T>(await store.readResult(key), clock.now())
      // A hit never waits and never touches upstream, however stale or expired
      // it is: refreshing that is the scheduler's job. A miss fetches, or waits
      // for whoever already is, bounded by this query's own timeout - one
      // budget, shared with resolving membership when the variant is dynamic. A
      // dynamic hit skips that resolution entirely; reconcile is the enforcer
      // that removes departed variants.
      if (shaped !== null) return decodeRead(shaped, codec)
      const deadline = clock.now() + (query?.timeoutMs ?? dynamic!.timeoutMs)
      if (!query) {
        query = await resolveMemberBy(dynamic!, key, clock, deadline)
        if (!query) throw new ConfigError(`unknown query '${name}'`)
      }
      return decodeRead(await readThrough<T>(query, key, deadline), codec)
    },
  }
}

function recordOutcome(report: RunReport, name: string, outcome: DispatchOutcome): void {
  if (outcome.status === 'ran') report.ran.push(name)
  else if (outcome.status === 'leased') report.skippedLeased.push(name)
  else report.failed.push({ name, message: outcome.message })
}

function emptyReport(): RunReport {
  return { ran: [], skippedLeased: [], deferredBudget: [], failed: [] }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function validateDriver(driver: Driver): Driver {
  if (!driver || typeof driver !== 'object') {
    throw new ConfigError('createFridge requires a driver')
  }
  if (typeof driver.serialized !== 'boolean') {
    throw new ConfigError('driver must declare serialized: boolean')
  }
  if (typeof driver.defer !== 'function') {
    throw new ConfigError('driver must provide defer(promise)')
  }
  return driver
}

function validateClock(clock: Clock): Clock {
  if (
    !clock ||
    typeof clock.now !== 'function' ||
    typeof clock.setTimeout !== 'function' ||
    typeof clock.clearTimeout !== 'function'
  ) {
    throw new ConfigError('clock must provide { now, setTimeout, clearTimeout }')
  }
  return clock
}

function validateSources(
  sources: Record<string, SourceBudget> | undefined,
): Record<string, SourceBudget> | undefined {
  for (const [source, budget] of Object.entries(sources ?? {})) {
    if (!Number.isInteger(budget.maxPerTick) || budget.maxPerTick < 1) {
      throw new ConfigError(`source '${source}': maxPerTick must be a positive integer`)
    }
  }
  return sources
}

function resolveStores(
  config: FridgeConfig,
  driver: Driver,
): { store: Store; schedule: SchedulePlane } {
  const store = config.store
  if (!store || typeof store.readResult !== 'function' || typeof store.claim !== 'function') {
    throw new ConfigError('createFridge requires a store that holds results and schedule rows')
  }
  // A stateful serialized driver keeps its own bookkeeping (a Durable Object's
  // SQLite, for example); then the store's schedule half simply goes unused.
  const schedule = driver.schedule ?? store
  requireClaimSafety(
    schedule,
    driver,
    driver.schedule ? "the driver's schedule bookkeeping" : 'the store',
  )
  return { store, schedule }
}

function requireClaimSafety(schedule: SchedulePlane, driver: Driver, which: string): void {
  if (!schedule.capabilities.atomicClaim && !driver.serialized) {
    throw new ConfigError(
      `${which} lacks atomicClaim and the driver is not serialized, so concurrent runDue ` +
        'calls could double-fetch; use a store with atomic claims or a serialized driver',
    )
  }
}
