import { backoffMs, firstRunJitterMs, MAX_JITTER_RATIO } from './backoff.js'
import type { Clock } from './clock.js'
import { defineQueries, Queries } from './define-queries.js'
import { ConfigError, TimeoutError } from './errors.js'
import type { Candidate } from './planner.js'
import { planTick, virtualRow } from './planner.js'
import { queryKey } from './query-key.js'
import { shapeRead, waitForEnvelope } from './reader.js'
import { systemClock, systemRandom } from './system-clock.js'
import type {
  Driver,
  Envelope,
  QueryDefinition,
  QueryParams,
  ReadResult,
  ResolvedQuery,
  RunReport,
  SchedulePlane,
  SourceBudget,
  Store,
} from './types.js'

export interface PollerConfig {
  queries: Queries | readonly QueryDefinition[]
  driver: Driver
  store: Store
  clock?: Clock
  sources?: Record<string, SourceBudget>
  random?: () => number
}

export interface PollerReadOptions {
  /** Hand the returned refresh somewhere that outlives the read, e.g. ctx.waitUntil. */
  swrRefresh?: (refresh: Promise<void>) => void
}

export interface Poller {
  runDue(now?: number): Promise<RunReport>
  read<T = unknown>(
    name: string,
    params?: QueryParams,
    options?: PollerReadOptions,
  ): Promise<ReadResult<T> | null>
}

export function createPoller(config: PollerConfig): Poller {
  const queries = config.queries instanceof Queries ? config.queries : defineQueries(config.queries)
  const driver = validateDriver(config.driver)
  const clock = validateClock(config.clock ?? systemClock)
  const sources = validateSources(config.sources)
  const { store, schedule } = resolveStores(config, driver)
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
      await store.writeResult(name, envelope)
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
          const old = await store.readResult(name)
          if (old) {
            await store.writeResult(name, {
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
        if (queries.getByKey(row.name)) continue
        await schedule.deleteSchedule(row.name)
        await store.deleteResult(row.name)
      }
    }
    for (const query of queries.all) {
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

  const refreshOne = async (key: string): Promise<void> => {
    const query = queries.getByKey(key)
    if (!query) return
    const now = clock.now()
    const row = (await schedule.readSchedule(key)) ?? virtualRow(key, now)
    if (row.nextRunAt > now) return
    await executeOne({ query, row }, now, emptyReport())
  }

  /**
   * Nothing is stored yet and the caller is willing to wait. Fetch it here when
   * nobody else is on it, otherwise wait for whoever is - the lease keeps that
   * to one upstream call however many readers arrive at once. The query's own
   * timeout bounds the wait; a fetch that outlives it keeps going and lands for
   * the next read.
   */
  const readThrough = async <T>(
    query: ResolvedQuery,
    key: string,
  ): Promise<ReadResult<T> | null> => {
    const start = clock.now()
    const deadline = start + query.timeoutMs
    const row = (await schedule.readSchedule(key)) ?? virtualRow(key, start)
    const leaseHeld = row.leaseUntil !== null && row.leaseUntil > start

    if (!leaseHeld) {
      // Backoff after a failed attempt: nothing is running and nothing is due,
      // so waiting would only spend the budget.
      if (row.nextRunAt > start) return null

      const report = emptyReport()
      let threw = false
      const refresh = executeOne({ query, row }, start, report).catch(() => {
        threw = true
      })
      driver.defer(refresh)
      const settled = await within(refresh, deadline)
      if (!settled || threw || report.failed.length > 0) return null
      if (report.ran.length > 0) {
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

    async read<T>(
      name: string,
      params?: QueryParams,
      options?: PollerReadOptions,
    ): Promise<ReadResult<T> | null> {
      const key = queryKey(name, params)
      const query = queries.getByKey(key)
      if (!query) throw new ConfigError(`unknown query '${name}'`)
      const shaped = shapeRead<T>(await store.readResult(key), clock.now())
      // Only staleness needs a background refresh: a miss is served by the read
      // itself below, so handing out a second refresh would be redundant.
      if (options?.swrRefresh && shaped?.isStale) {
        options.swrRefresh(refreshOne(key))
      }
      // A hit never waits; a miss fetches or waits for whoever is, bounded by
      // this query's own timeout.
      if (shaped !== null) return shaped
      return readThrough<T>(query, key)
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
): { store: Store; schedule: SchedulePlane } {
  const store = config.store
  if (!store || typeof store.readResult !== 'function' || typeof store.claim !== 'function') {
    throw new ConfigError('createPoller requires a store that holds results and schedule rows')
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
