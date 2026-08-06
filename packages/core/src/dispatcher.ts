import { backoffMs, firstRunJitterMs } from './backoff.js'
import type { Clock } from './clock.js'
import { withDeadline } from './deadline.js'
import { ConfigError } from './errors.js'
import type { Envelope, ResolvedQuery, SchedulePlane, ScheduleRow, Store } from './types.js'

export interface FetchTask {
  query: ResolvedQuery
  /** The schedule row as the caller observed it; its version is the CAS expectation. */
  row: ScheduleRow
  /** 'demand' means a reader is waiting on this call. */
  priority: 'demand' | 'scheduled'
}

export type DispatchOutcome =
  { status: 'ran' } | { status: 'leased' } | { status: 'failed'; message: string }

export interface DispatcherConfig {
  store: Store
  schedule: SchedulePlane
  clock: Clock
  random: () => number
}

/**
 * The single exit to upstream. Scheduled refreshes and read-miss fetches are
 * the same work arriving through different doors, so coalescing, execution,
 * write-back and backoff live here once and nowhere else - there is no second
 * path that could skip one of them.
 */
export interface Dispatcher {
  run(task: FetchTask, now: number): Promise<DispatchOutcome>
}

export function createDispatcher(config: DispatcherConfig): Dispatcher {
  const { store, schedule, clock, random } = config

  const isOwner = async (name: string, token: number): Promise<boolean> => {
    const current = await schedule.readSchedule(name)
    return current !== null && current.version === token
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
    return { status: 'failed', message }
  }

  return {
    async run({ query, row }: FetchTask, now: number): Promise<DispatchOutcome> {
      const { name } = query
      const claimed = await schedule.claim(name, row.version, now + query.leaseMs, now)
      if (!claimed) return { status: 'leased' }
      const token = row.version + 1
      try {
        const data = await withDeadline(clock, query.timeoutMs, `query '${name}'`, (signal) =>
          query.fetch({ signal, now, attempt: row.failCount + 1 }),
        )
        return await succeed(query, token, data, clock.now())
      } catch (err) {
        return await fail(query, row, token, err)
      }
    },
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
