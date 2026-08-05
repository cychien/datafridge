import { backoffMs, firstRunJitterMs, MAX_JITTER_RATIO } from './backoff.js'
import type { Clock } from './clock.js'
import { defineQueries, Queries } from './define-queries.js'
import { ConfigError, TimeoutError } from './errors.js'
import type { Candidate } from './planner.js'
import { planTick, virtualRow } from './planner.js'
import { shapeRead } from './reader.js'
import { systemClock, systemRandom } from './system-clock.js'
import type {
  Driver,
  Envelope,
  QueryDef,
  ReadResult,
  ResultStore,
  RunReport,
  ScheduleStore,
  SourceBudget,
  Store,
} from './types.js'

export interface PollerConfig {
  queries: Queries | readonly QueryDef[]
  driver: Driver
  clock?: Clock
  store?: Store
  results?: ResultStore
  schedule?: ScheduleStore
  sources?: Record<string, SourceBudget>
  random?: () => number
}

export interface PollerReadOptions {
  swrRefresh?: (refresh: Promise<void>) => void
}

export interface Poller {
  runDue(now?: number): Promise<RunReport>
  read<T = unknown>(name: string, options?: PollerReadOptions): Promise<ReadResult<T> | null>
}

export function createPoller(config: PollerConfig): Poller {
  const queries = config.queries instanceof Queries ? config.queries : defineQueries(config.queries)
  const driver = validateDriver(config.driver)
  const clock = validateClock(config.clock ?? systemClock)
  const sources = validateSources(config.sources)
  const { results, schedule } = resolveStores(config, driver)
  const random = config.random ?? systemRandom

  const isOwner = async (name: string, token: number): Promise<boolean> => {
    const current = await schedule.readSchedule(name)
    return current !== null && current.version === token
  }

  const executeOne = async (
    { query, row }: Candidate,
    now: number,
    report: RunReport,
  ): Promise<void> => {
    const { name } = query
    const claimed = await schedule.claim(name, row.version, now + query.leaseMs, now)
    if (!claimed) {
      report.skippedLeased.push(name)
      return
    }
    const token = row.version + 1
    const controller = new AbortController()
    const handle = clock.setTimeout(
      () =>
        controller.abort(new TimeoutError(`query '${name}' timed out after ${query.timeoutMs}ms`)),
      query.timeoutMs,
    )
    try {
      const data = await raceAbort(
        query.fetch({ signal: controller.signal, now, attempt: row.failCount + 1 }),
        controller.signal,
      )
      clock.clearTimeout(handle)
      const done = clock.now()
      if (!(await isOwner(name, token))) {
        report.failed.push({ name, message: 'write discarded (lease reclaimed)' })
        return
      }
      const envelope: Envelope = { data, fetchedAt: done, freshUntil: done + query.everyMs }
      await results.writeResult(name, envelope)
      const jitter = token === 1 ? firstRunJitterMs(query.everyMs, random) : 0
      await schedule.writeSchedule({
        name,
        nextRunAt: done + query.everyMs + jitter,
        failCount: 0,
        leaseUntil: null,
        version: token,
      })
      report.ran.push(name)
    } catch (err) {
      clock.clearTimeout(handle)
      const done = clock.now()
      let message = errorMessage(err)
      try {
        if (await isOwner(name, token)) {
          const failCount = row.failCount + 1
          const old = await results.readResult(name)
          if (old) {
            await results.writeResult(name, {
              ...old,
              lastError: { at: done, message, count: failCount },
            })
          }
          await schedule.writeSchedule({
            name,
            nextRunAt: done + backoffMs(failCount, query.everyMs, random),
            failCount,
            leaseUntil: null,
            version: token,
          })
        } else {
          message = `write discarded (lease reclaimed): ${message}`
        }
      } catch {
        // Store write failed mid-run; the lease expires and a later tick re-claims.
      }
      report.failed.push({ name, message })
    }
  }

  const reconcile = async (now: number): Promise<void> => {
    if (schedule.capabilities.listDue && schedule.listDue) {
      const all = await schedule.listDue(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      for (const row of all) {
        if (queries.get(row.name)) continue
        await schedule.deleteSchedule(row.name)
        await results.deleteResult(row.name)
      }
    }
    for (const query of queries.all) {
      const row = await schedule.readSchedule(query.name)
      if (!row || row.failCount > 0) continue
      if (row.leaseUntil !== null && row.leaseUntil > now) continue
      // Only an `every` shrink needs fixing here; growth self-heals with one
      // early run that reschedules at the new period.
      if (row.nextRunAt <= now + query.everyMs * (1 + MAX_JITTER_RATIO)) continue
      const env = await results.readResult(query.name)
      await schedule.writeSchedule({
        ...row,
        nextRunAt: (env ? env.fetchedAt : now) + query.everyMs,
      })
    }
  }

  const refreshOne = async (name: string): Promise<void> => {
    const query = queries.get(name)
    if (!query) return
    const now = clock.now()
    const row = (await schedule.readSchedule(name)) ?? virtualRow(name, now)
    if (row.nextRunAt > now) return
    await executeOne({ query, row }, now, emptyReport())
  }

  return {
    async runDue(nowArg?: number): Promise<RunReport> {
      const now = nowArg ?? clock.now()
      await reconcile(now)
      const rowsByName = new Map(
        await Promise.all(
          queries.all.map(async (q) => [q.name, await schedule.readSchedule(q.name)] as const),
        ),
      )
      const { toRun, deferredBudget } = planTick(queries.all, rowsByName, now, sources)
      const report = emptyReport()
      report.deferredBudget.push(...deferredBudget)
      await Promise.allSettled(toRun.map((candidate) => executeOne(candidate, now, report)))
      return report
    },

    async read<T>(name: string, options?: PollerReadOptions): Promise<ReadResult<T> | null> {
      if (!queries.get(name)) throw new ConfigError(`unknown query '${name}'`)
      const env = await results.readResult(name)
      const shaped = shapeRead<T>(env, clock.now())
      if (options?.swrRefresh && (shaped === null || shaped.isStale)) {
        options.swrRefresh(refreshOne(name))
      }
      return shaped
    },
  }
}

function emptyReport(): RunReport {
  return { ran: [], skippedLeased: [], deferredBudget: [], failed: [] }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {})
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function validateDriver(driver: Driver): Driver {
  if (!driver || typeof driver !== 'object') {
    throw new ConfigError('createPoller requires a driver')
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
  config: PollerConfig,
  driver: Driver,
): { results: ResultStore; schedule: ScheduleStore } {
  if (config.store && config.results) {
    throw new ConfigError('pass either store or results, not both')
  }
  const results = config.store ?? config.results
  if (!results) {
    throw new ConfigError('createPoller requires a result store (results or store)')
  }

  if (config.schedule) {
    requireClaimSafety(config.schedule, driver, 'the explicit schedule store')
    return { results, schedule: config.schedule }
  }
  if (driver.schedule) {
    requireClaimSafety(driver.schedule, driver, "the driver's schedule store")
    return { results, schedule: driver.schedule }
  }
  if (isScheduleStore(results)) {
    if (results.capabilities.atomicClaim || driver.serialized) {
      return { results, schedule: results }
    }
    throw new ConfigError(
      'no valid schedule plane: the store implements ScheduleStore but lacks atomicClaim ' +
        'and the driver is not serialized; use a store with atomic claims, a serialized ' +
        'driver, or an explicit schedule store',
    )
  }
  throw new ConfigError(
    'no valid schedule plane: pass an explicit schedule store, use a driver that provides ' +
      'one, or use a full Store (with atomicClaim, or under a serialized driver); ' +
      'refusing to silently degrade',
  )
}

function requireClaimSafety(schedule: ScheduleStore, driver: Driver, which: string): void {
  if (!schedule.capabilities.atomicClaim && !driver.serialized) {
    throw new ConfigError(
      `${which} lacks atomicClaim and the driver is not serialized; ` +
        'concurrent runDue calls could double-fetch',
    )
  }
}

function isScheduleStore(value: object): value is ScheduleStore {
  const candidate = value as Partial<ScheduleStore>
  return (
    typeof candidate.readSchedule === 'function' &&
    typeof candidate.writeSchedule === 'function' &&
    typeof candidate.deleteSchedule === 'function' &&
    typeof candidate.claim === 'function' &&
    typeof candidate.capabilities === 'object' &&
    candidate.capabilities !== null
  )
}
