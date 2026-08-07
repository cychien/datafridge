import { backoffMs, firstRunJitterMs, retryAfterMs } from './backoff.js'
import type { Clock } from './clock.js'
import { withDeadline } from './deadline.js'
import { RateLimitError, ConfigError } from './errors.js'
import { windowStartOf } from './sources.js'
import type { ResolvedSource, ResolvedSources } from './sources.js'
import type { Envelope, ResolvedQuery, SchedulePlane, ScheduleRow, Store } from './types.js'

export type FetchTask = {
  query: ResolvedQuery
  /** The schedule row as the caller observed it; its version is the CAS expectation. */
  row: ScheduleRow
} & (
  | { priority: 'scheduled' }
  /** A reader is waiting, and stops waiting at `deadline`. */
  | { priority: 'demand'; deadline: number }
)

export type DispatchOutcome =
  | { status: 'ran' }
  | { status: 'leased' }
  | { status: 'throttled'; retryAt: number }
  | { status: 'failed'; message: string }

export interface DispatcherConfig {
  store: Store
  schedule: SchedulePlane
  clock: Clock
  random: () => number
  sources: ResolvedSources
}

/**
 * The single exit to upstream. Scheduled refreshes and read-miss fetches are
 * the same work arriving through different doors, so rate limiting, coalescing,
 * write-back and backoff live here once and nowhere else - there is no second
 * path that could skip one of them.
 */
export interface Dispatcher {
  run(task: FetchTask, now: number): Promise<DispatchOutcome>
}

/** Runs a wait with this call's concurrency slot handed back for the duration. */
type Unslotted = <T>(wait: () => Promise<T>) => Promise<T>

/** Instantaneous smoothing inside this instance; it bounds concurrency, not volume. */
function makeSemaphores(sources: ResolvedSources) {
  const inFlight = new Map<string, number>()
  const waiting = new Map<string, Array<() => void>>()

  return {
    async acquire(source: string): Promise<void> {
      const max = sources.get(source)?.maxConcurrent ?? Infinity
      if (max === Infinity) return
      const running = inFlight.get(source) ?? 0
      if (running < max) {
        inFlight.set(source, running + 1)
        return
      }
      await new Promise<void>((resolve) => {
        const queue = waiting.get(source) ?? []
        queue.push(resolve)
        waiting.set(source, queue)
      })
    },

    release(source: string): void {
      const max = sources.get(source)?.maxConcurrent ?? Infinity
      if (max === Infinity) return
      const next = waiting.get(source)?.shift()
      // The slot is handed straight over rather than counted down and up again,
      // so a released slot cannot be taken by a newcomer ahead of the queue.
      if (next) next()
      else inFlight.set(source, Math.max(0, (inFlight.get(source) ?? 1) - 1))
    },
  }
}

export function createDispatcher(config: DispatcherConfig): Dispatcher {
  const { store, schedule, clock, random, sources } = config
  const semaphores = makeSemaphores(sources)

  const isOwner = async (name: string, token: number): Promise<boolean> => {
    const current = await schedule.readSchedule(name)
    return current !== null && current.version === token
  }

  const sleepUntil = (at: number): Promise<void> =>
    new Promise((resolve) => {
      clock.setTimeout(() => resolve(), Math.max(0, at - clock.now()))
    })

  /**
   * Scheduled work takes what is left after the window's reserve and never
   * waits: refusing it leaves the row due, and the next tick brings it back
   * with a higher overdue ratio, so nothing starves. A demand fetch has someone
   * waiting, so it may take the reserve too and may wait for the window to roll
   * - but only for as long as that reader is still there.
   */
  const takeQuota = async (
    task: FetchTask,
    policy: ResolvedSource,
    source: string,
    unslotted: Unslotted,
  ): Promise<{ ok: true; takenAt: number } | { ok: false; retryAt: number }> => {
    const { windowMs } = policy
    const limit = task.priority === 'demand' ? policy.demandLimit : policy.scheduledLimit
    for (;;) {
      const now = clock.now()
      if (await schedule.takeQuota(source, limit, windowMs, now)) return { ok: true, takenAt: now }
      const retryAt = windowStartOf(now, windowMs) + windowMs
      if (task.priority !== 'demand' || retryAt >= task.deadline) return { ok: false, retryAt }
      // Waiting out a window is not a call in flight, so the concurrency slot
      // goes back for the duration: `maxConcurrent` bounds what upstream is
      // actually carrying, never what is queued behind a ceiling.
      await unslotted(() => sleepUntil(retryAt))
    }
  }

  /**
   * A slot taken for a call that never happened. Refusing to credit a window
   * that has already rolled leaves this one over-counting by one, which is the
   * safe direction for a ceiling, so a refund that cannot land is not an error.
   */
  const giveQuotaBack = async (
    source: string,
    windowMs: number,
    takenAt: number,
  ): Promise<void> => {
    try {
      await schedule.releaseQuota(source, windowMs, takenAt)
    } catch {
      // Over-counting one call is the safe direction, and the window rolls.
    }
  }

  const succeed = async (
    query: ResolvedQuery,
    token: number,
    data: unknown,
    done: number,
  ): Promise<DispatchOutcome> => {
    const { name } = query
    if (!(await isOwner(name, token))) {
      return { status: 'failed', message: 'write discarded (lease reclaimed)' }
    }
    const stored = query.codec ? query.codec.encode(data) : data
    const validUntil = query.validUntil?.(done)
    if (validUntil !== undefined && !Number.isFinite(validUntil)) {
      throw new ConfigError(`query '${name}': validUntil must return a finite epoch-ms timestamp`)
    }
    const envelope: Envelope = {
      data: stored,
      fetchedAt: done,
      freshUntil: done + query.everyMs,
      ...(validUntil !== undefined ? { validUntil } : {}),
    }
    await store.writeResult(name, envelope)
    const jitter = token === 1 ? firstRunJitterMs(query.everyMs, random) : 0
    // everyMs is a positive duration, so periodic is always past `done`: no
    // branch below can schedule a run that is due the moment it is written.
    const periodic = done + query.everyMs + jitter
    // Data with its own expiry re-fetches at the boundary, not a period later.
    // A boundary already behind us describes a window that has closed -
    // legitimate for a variant naming a past date - so it schedules nothing and
    // the ordinary period governs.
    const nextRunAt =
      validUntil !== undefined && validUntil > done ? Math.min(periodic, validUntil) : periodic
    await schedule.writeSchedule({
      name,
      nextRunAt,
      failCount: 0,
      leaseUntil: null,
      version: token,
      ...(query.params !== undefined ? { params: query.params } : {}),
    })
    return { status: 'ran' }
  }

  const fail = async (
    query: ResolvedQuery,
    row: ScheduleRow,
    token: number,
    err: unknown,
  ): Promise<DispatchOutcome> => {
    const { name } = query
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
          nextRunAt: done + retryDelayMs(err, failCount, query.everyMs, random),
          failCount,
          leaseUntil: null,
          version: token,
          ...(query.params !== undefined ? { params: query.params } : {}),
        })
      } else {
        message = `write discarded (lease reclaimed): ${message}`
      }
    } catch {
      // Store write failed mid-run; the lease expires and a later tick re-claims.
    }
    return { status: 'failed', message }
  }

  const dispatch = async (
    task: FetchTask,
    now: number,
    unslotted: Unslotted,
  ): Promise<DispatchOutcome> => {
    const { query, row } = task
    const { name, source } = query
    const policy = sources.get(source)
    // Quota is taken after the concurrency slot so a queued call is not holding
    // one, and before the claim so a call that has no quota never takes a lease
    // it would have to hand straight back.
    const metered = policy !== undefined && policy.windowMs !== Infinity
    let takenAt = 0
    if (metered) {
      const taken = await takeQuota(task, policy, source, unslotted)
      if (!taken.ok) return { status: 'throttled', retryAt: taken.retryAt }
      takenAt = taken.takenAt
    }
    const claimed = await schedule.claim(name, row.version, now + query.leaseMs, now)
    if (!claimed) {
      // Someone else is doing this work; nothing leaves for upstream here, so
      // the slot this call was counted for goes back to the window.
      if (metered) await giveQuotaBack(source, policy.windowMs, takenAt)
      return { status: 'leased' }
    }
    const token = row.version + 1
    try {
      const data = await withDeadline(clock, query.timeoutMs, `query '${name}'`, (signal) =>
        query.fetch({ signal, now, attempt: row.failCount + 1 }),
      )
      return await succeed(query, token, data, clock.now())
    } catch (err) {
      return await fail(query, row, token, err)
    }
  }

  return {
    async run(task: FetchTask, now: number): Promise<DispatchOutcome> {
      const { source } = task.query
      await semaphores.acquire(source)
      let held = true
      const unslotted = async <T>(wait: () => Promise<T>): Promise<T> => {
        held = false
        semaphores.release(source)
        try {
          return await wait()
        } finally {
          await semaphores.acquire(source)
          held = true
        }
      }
      try {
        return await dispatch(task, now, unslotted)
      } finally {
        if (held) semaphores.release(source)
      }
    },
  }
}

function retryDelayMs(
  err: unknown,
  failCount: number,
  everyMs: number,
  random: () => number,
): number {
  const retryAfter = err instanceof RateLimitError ? err.retryAfterMs : undefined
  return retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfterMs(retryAfter, random)
    : backoffMs(failCount, everyMs, random)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
