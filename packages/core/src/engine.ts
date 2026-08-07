import { backoffMs, MAX_JITTER_RATIO } from './backoff.js'
import type { Clock } from './clock.js'
import { defineQueries, Queries, resolveVariantsWithin } from './define-queries.js'
import type { DynamicVariants } from './define-queries.js'
import { createDispatcher } from './dispatcher.js'
import type { DispatchOutcome } from './dispatcher.js'
import { ConfigError } from './errors.js'
import { planTick } from './planner.js'
import type { Candidate } from './planner.js'
import { variantBaseOf } from './query-key.js'
import { createReadPath } from './read-path.js'
import { resolveSources } from './sources.js'
import type { ResolvedSources } from './sources.js'
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
  SourcePolicy,
  Store,
  ThrottledRead,
} from './types.js'

/**
 * How many rows one tick reads, how many departed ones it removes, and how many
 * calls it lets fly between two looks at a source's ceiling. These are
 * implementation limits, not policy: what a tick actually takes on is decided by
 * dueness, the source's remaining window and the invocation's remaining wall
 * clock. They exist so that a single tick's cost has an upper bound no registry
 * size can raise, and everything they leave behind is still due the moment the
 * next tick starts.
 */
const SCHEDULE_PAGE = 512
const RECONCILE_DELETES_PER_TICK = 64
const DISPATCH_CHUNK = 32
const FLIGHT_SWEEP_PER_TICK = 128
const ROW_FILL_CHUNK = 32
// A flight is only swept once no leader could still be writing to it. A leader
// is bounded by its own deadline, which is well inside the flight's expiry;
// this margin on top is what keeps generations climbing, because a deleted
// flight is one the next caller would restart at generation one.
const FLIGHT_SWEEP_GRACE_MS = 60_000

export interface FridgeConfig {
  queries: Queries | readonly QueryDefinition[]
  driver: Driver
  store: Store
  clock?: Clock
  sources?: Record<string, SourcePolicy>
  random?: () => number
}

export interface Fridge {
  runDue(now?: number): Promise<RunReport>
  read<T = unknown>(
    name: string,
    params?: QueryParams,
  ): Promise<ReadResult<T> | ThrottledRead | null>
}

export function createFridge(config: FridgeConfig): Fridge {
  const queries = config.queries instanceof Queries ? config.queries : defineQueries(config.queries)
  const driver = validateDriver(config.driver)
  const clock = validateClock(config.clock ?? systemClock)
  const sources = resolveSources(config.sources)
  const { store, schedule } = resolveStores(config, driver)
  const random = config.random ?? systemRandom
  const dispatcher = createDispatcher({ store, schedule, clock, random, sources })

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
   * Every row this tick has already paid to read, so nothing reads one twice.
   * Writes go through it too, which is what lets planning and the next-wake
   * calculation work from what the tick did rather than asking storage again.
   */
  class Rows {
    readonly #known = new Map<string, ScheduleRow | null>()

    remember(name: string, row: ScheduleRow | null): void {
      this.#known.set(name, row)
    }

    get(name: string): ScheduleRow | null | undefined {
      return this.#known.get(name)
    }

    async read(name: string): Promise<ScheduleRow | null> {
      const seen = this.#known.get(name)
      if (seen !== undefined) return seen
      const row = await schedule.readSchedule(name)
      this.#known.set(name, row)
      return row
    }

    async write(row: ScheduleRow): Promise<void> {
      await schedule.writeSchedule(row)
      this.#known.set(row.name, row)
    }

    async delete(name: string): Promise<void> {
      await schedule.deleteSchedule(name)
      this.#known.set(name, null)
    }
  }

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
  const resolveEffective = async (now: number, rows: Rows): Promise<EffectiveRegistry> => {
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
      await rows.write({
        name: dynamic.baseName,
        nextRunAt: clock.now() + backoffMs(failCount, dynamic.everyMs, random),
        failCount,
        leaseUntil: null,
        version: (row?.version ?? 0) + 1,
      })
    }

    const attempts = await Promise.all(
      queries.dynamic.map(async (dynamic): Promise<Attempt> => {
        const row = await rows.read(dynamic.baseName)
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
        if (row) await rows.delete(dynamic.baseName)
      } catch (err) {
        await failBase(attempt, errorMessage(err))
      }
    }
    return { list, byKey, failures, unresolvedBases }
  }

  /**
   * The earliest page of rows, which is the whole of what one tick reads.
   * `listDue` orders by `nextRunAt`, so a page holds every due row before any
   * future one, and a row nothing refreshes only climbs towards the front. A
   * full page means there may be more behind it, and the tick says so by asking
   * to be woken again immediately rather than by reading further.
   *
   * `listed` is whether a page was read at all. A plane without `listDue` reads
   * none, and an empty page from a plane that cannot list is not evidence that
   * the table is empty - it is evidence of nothing.
   */
  const listRows = async (): Promise<{ listed: boolean; page: ScheduleRow[] }> =>
    schedule.capabilities.listDue && schedule.listDue
      ? { listed: true, page: await schedule.listDue(Number.MAX_SAFE_INTEGER, SCHEDULE_PAGE) }
      : { listed: false, page: [] }

  /**
   * Rows the registry no longer names lose their row and their result. Bounded
   * per tick, because a list that dropped ten thousand variants at once is a
   * deployment, not an emergency: the rest go on the next tick, still departed.
   */
  const reconcile = async (
    now: number,
    effective: EffectiveRegistry,
    page: readonly ScheduleRow[],
    rows: Rows,
  ): Promise<{ moreToRemove: boolean }> => {
    let removed = 0
    let moreToRemove = false
    for (const row of page) {
      if (effective.byKey.has(row.name)) continue
      // A dynamic base's own row is backoff bookkeeping, not a departed variant.
      if (queries.dynamicFor(row.name)) continue
      const base = variantBaseOf(row.name)
      if (base !== undefined && effective.unresolvedBases.has(base)) continue
      if (rows.get(row.name) === null) continue
      if (removed >= RECONCILE_DELETES_PER_TICK) {
        moreToRemove = true
        break
      }
      removed += 1
      await rows.delete(row.name)
      await store.deleteResult(row.name)
    }

    for (const query of effective.list) {
      const row = rows.get(query.name)
      if (row === undefined || row === null || row.failCount > 0) continue
      if (row.leaseUntil !== null && row.leaseUntil > now) continue
      // Only an `every` shrink needs fixing here; growth self-heals with one
      // early run that reschedules at the new period.
      if (row.nextRunAt <= now + query.everyMs * (1 + MAX_JITTER_RATIO)) continue
      const env = await store.readResult(query.name)
      await rows.write({ ...row, nextRunAt: (env ? env.fetchedAt : now) + query.everyMs })
    }
    return { moreToRemove }
  }

  /**
   * The page is the bound on scanning a table nobody declared the size of. The
   * registry is declared, though, so a name the page did not reach is looked up
   * by name rather than guessed at: without this a registry larger than one page
   * could never tell "no row yet" from "a row the page did not reach", and would
   * either re-claim rows that exist or never start queries that do not.
   * Costs nothing until a registry outgrows a page.
   */
  const fillMissingRows = async (
    list: readonly ResolvedQuery[],
    rows: Rows,
    pageHeldEveryRow: boolean,
  ): Promise<void> => {
    const missing = list.filter((query) => rows.get(query.name) === undefined)
    if (missing.length === 0) return
    // A page read with no upper bound on `nextRunAt` that came back short is
    // the whole table: a name missing from it provably has no row, and looking
    // it up would only confirm that at the cost of a round trip per never-run
    // query, every tick. A page nobody read proves nothing at all.
    if (pageHeldEveryRow) {
      for (const query of missing) rows.remember(query.name, null)
      return
    }
    for (let start = 0; start < missing.length; start += ROW_FILL_CHUNK) {
      const batch = missing.slice(start, start + ROW_FILL_CHUNK)
      if (schedule.readSchedules) {
        const found = await schedule.readSchedules(batch.map((query) => query.name))
        batch.forEach((query, index) => rows.remember(query.name, found[index] ?? null))
      } else {
        await Promise.all(batch.map((query) => rows.read(query.name)))
      }
    }
  }

  /**
   * What this invocation will still take on. A call is admitted only while its
   * own timeout fits in the wall clock the driver says is left, and only while
   * its source has not already refused this tick - both ceilings are read from
   * the store's own answer rather than guessed at, and one refusal per source
   * per tick is enough to learn it. Everything turned away here is untouched, so it
   * is still due, and more overdue, the moment the next tick starts.
   */
  const dispatchDue = async (
    plan: readonly Candidate[],
    now: number,
    startedAt: number,
    onOutcome: (candidate: Candidate, outcome: DispatchOutcome) => void,
    /** `null` means "as soon as there is an invocation", not "at some time". */
    onDeferred: (name: string, retryAt: number | null) => void,
  ): Promise<void> => {
    const fits = (query: ResolvedQuery): boolean =>
      driver.budgetMs === undefined || clock.now() + query.timeoutMs <= startedAt + driver.budgetMs

    const bySource = new Map<string, Candidate[]>()
    for (const candidate of plan) {
      const list = bySource.get(candidate.query.source)
      if (list) list.push(candidate)
      else bySource.set(candidate.query.source, [candidate])
    }

    await Promise.allSettled(
      [...bySource].map(async ([source, candidates]) => {
        const chunk = chunkFor(sources, source)
        // Once a source has refused, the rest of its work this tick waits for
        // the same moment the refusal named rather than asking again.
        let closedUntil: number | null = null
        let closed = false
        for (let start = 0; start < candidates.length; start += chunk) {
          const admitted: Candidate[] = []
          for (const candidate of candidates.slice(start, start + chunk)) {
            if (closed) onDeferred(candidate.query.name, closedUntil)
            // Out of wall clock, not out of ceiling: the next invocation has a
            // fresh budget, so this one asks to be followed immediately.
            else if (!fits(candidate.query)) onDeferred(candidate.query.name, null)
            else admitted.push(candidate)
          }
          if (admitted.length === 0) continue
          await Promise.allSettled(
            admitted.map(async (candidate) => {
              const outcome = await dispatcher.run({ ...candidate, priority: 'scheduled' }, now)
              // One refusal is the whole answer for this source this tick,
              // whether the window is spent or its calls are all in flight.
              if (outcome.status === 'throttled' || outcome.status === 'deferred') {
                closed = true
                closedUntil =
                  closedUntil === null ? outcome.retryAt : Math.min(closedUntil, outcome.retryAt)
              }
              onOutcome(candidate, outcome)
            }),
          )
        }
      }),
    )
  }

  const sweepSettledFlights = async (now: number): Promise<void> => {
    try {
      await schedule.sweepFlights(now - FLIGHT_SWEEP_GRACE_MS, FLIGHT_SWEEP_PER_TICK)
    } catch {
      // Housekeeping: a sweep that does not land leaves rows that expire on
      // their own terms and are answered as dead by the next caller.
    }
  }

  const read = createReadPath({
    store,
    schedule,
    dispatcher,
    queries,
    clock,
    defer: (promise) => driver.defer(promise),
  })

  return {
    async runDue(nowArg?: number): Promise<RunReport> {
      const startedAt = clock.now()
      const { listed, page } = await listRows()
      const rows = new Rows()
      for (const row of page) rows.remember(row.name, row)
      const effective = await resolveEffective(nowArg ?? clock.now(), rows)
      // Resolution can legitimately spend a base's whole timeout, so dueness,
      // reconciliation and leases work from a timestamp taken after it. A
      // caller who supplied one owns the tick's clock and is never overridden.
      const now = nowArg ?? clock.now()
      // A page that filled up while its rows were still due is the tick saying
      // "there was more due than I read". A page that filled up and ran into
      // future-dated rows is not: `listDue` orders by `nextRunAt`, so everything
      // behind that last row is later still. Reading the count alone would make
      // every registry past one page look permanently behind.
      const moreDueBehindPage =
        page.length >= SCHEDULE_PAGE && page[page.length - 1]!.nextRunAt <= now
      await fillMissingRows(effective.list, rows, listed && page.length < SCHEDULE_PAGE)
      const { moreToRemove } = await reconcile(now, effective, page, rows)
      // Flights are transient by construction, but nothing else would ever
      // collect the settled ones; the tick is the only thing that runs anyway.
      driver.defer(sweepSettledFlights(now))

      const report = emptyReport()
      report.failed.push(...effective.failures)

      const plan = planTick(effective.list, rows, now)
      const dispatched = new Set<string>()
      let soonest: number | null = null
      const consider = (at: number): void => {
        soonest = soonest === null ? at : Math.min(soonest, at)
      }

      await dispatchDue(
        plan,
        now,
        startedAt,
        (candidate, outcome) => {
          dispatched.add(candidate.query.name)
          recordOutcome(report, candidate.query.name, outcome)
          if (outcome.status === 'throttled' || outcome.status === 'deferred') {
            consider(outcome.retryAt)
          } else if (outcome.status === 'leased') consider(candidate.row.leaseUntil ?? now)
          else if (outcome.nextRunAt !== undefined) consider(outcome.nextRunAt)
        },
        (name, retryAt) => {
          report.deferred.push(name)
          // A ceiling names the moment it could give way; running out of wall
          // clock names nothing, because the next invocation is the answer.
          consider(retryAt ?? now)
        },
      )

      // Work this tick could not even look at is due right now; the driver's
      // own floor is what keeps that from becoming a hot loop.
      if (moreToRemove || moreDueBehindPage) consider(now)
      for (const query of effective.list) {
        if (dispatched.has(query.name)) continue
        const row = rows.get(query.name)
        if (row) consider(row.nextRunAt)
        else if (row === null) consider(now)
      }
      for (const entry of queries.dynamic) {
        const row = rows.get(entry.baseName)
        // A base with no variants and no backoff row has nothing in the table
        // to be woken by, so it is woken on its own period.
        if (row) consider(row.nextRunAt)
        else if (!effective.list.some((query) => query.baseName === entry.baseName)) {
          consider(now + entry.everyMs)
        }
      }
      report.nextRunAt = soonest
      return report
    },

    read,
  }
}

function chunkFor(sources: ResolvedSources, source: string): number {
  const maxConcurrent = sources.get(source)?.maxConcurrent
  return maxConcurrent !== undefined && Number.isFinite(maxConcurrent)
    ? maxConcurrent
    : DISPATCH_CHUNK
}

function recordOutcome(report: RunReport, name: string, outcome: DispatchOutcome): void {
  if (outcome.status === 'ran') report.ran.push(name)
  else if (outcome.status === 'leased') report.skippedLeased.push(name)
  else if (outcome.status === 'throttled') report.throttled.push(name)
  else if (outcome.status === 'deferred') report.deferred.push(name)
  else report.failed.push({ name, message: outcome.message })
}

function emptyReport(): RunReport {
  return {
    ran: [],
    skippedLeased: [],
    throttled: [],
    deferred: [],
    failed: [],
    nextRunAt: null,
  }
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
  if (
    driver.budgetMs !== undefined &&
    (!Number.isFinite(driver.budgetMs) || driver.budgetMs <= 0)
  ) {
    throw new ConfigError('driver budgetMs must be a positive number of milliseconds')
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

function resolveStores(
  config: FridgeConfig,
  driver: Driver,
): { store: Store; schedule: SchedulePlane } {
  const store = config.store
  if (!store || typeof store.readResult !== 'function' || typeof store.claim !== 'function') {
    throw new ConfigError('createFridge requires a store that holds results and schedule rows')
  }
  // A stateful serialized driver keeps its own bookkeeping; then the store's
  // schedule half simply goes unused.
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
