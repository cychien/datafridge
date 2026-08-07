import type { Clock } from './clock.js'
import { Queries, resolveMemberBy } from './define-queries.js'
import type { Dispatcher, DispatchOutcome } from './dispatcher.js'
import { ConfigError } from './errors.js'
import { virtualRow } from './planner.js'
import { queryKey } from './query-key.js'
import { decodeRead, shapeRead, waitForEnvelope } from './reader-core.js'
import type {
  QueryCodec,
  QueryParams,
  ReadResult,
  ResolvedQuery,
  SchedulePlane,
  Store,
  ThrottledRead,
} from './types.js'

/** All a passive reader needs; the optional halves are what let it do more. */
export type ReadableStore = Pick<Store, 'readResult'> & Partial<Pick<Store, 'readSchedule'>>

export interface ReadPathConfig {
  store: ReadableStore
  /**
   * Present together, these turn a reader into one that can fetch. Without them
   * a read that finds nothing can only wait for an executor to write it.
   */
  schedule?: SchedulePlane
  dispatcher?: Dispatcher
  queries?: Queries
  clock: Clock
  defer: (promise: Promise<unknown>) => void
}

export type ReadFn = <T>(
  name: string,
  params?: QueryParams,
) => Promise<ReadResult<T> | ThrottledRead | null>

/**
 * One read path, wherever the read comes from. `createFridge` and a
 * `createReader` holding a full store both land here, so what a read does -
 * serve what is stored, coalesce one fetch behind a lease, or make one fresh
 * call for params no entry exists for - cannot drift between them.
 */
export function createReadPath(config: ReadPathConfig): ReadFn {
  const { store, schedule, dispatcher, queries, clock, defer } = config
  const canFetch = schedule !== undefined && dispatcher !== undefined

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
  ): Promise<ReadResult<T> | ThrottledRead | null> => {
    const start = clock.now()
    const row = (await schedule!.readSchedule(key)) ?? virtualRow(key, start)
    const leaseHeld = row.leaseUntil !== null && row.leaseUntil > start

    if (!leaseHeld) {
      // Backoff after a failed attempt: nothing is running and nothing is due,
      // so waiting would only spend the budget.
      if (row.nextRunAt > start) return null

      let outcome: DispatchOutcome | undefined
      const running = dispatcher!
        .run({ query, row, priority: 'demand', deadline }, start)
        .then((result) => {
          outcome = result
        })
        .catch(() => {})
      defer(running)
      const settled = await within(running, deadline)
      if (!settled || outcome === undefined || outcome.status === 'failed') return null
      if (outcome.status === 'ran') {
        return shapeRead<T>(await store.readResult(key), clock.now())
      }
      // The source is spent for this window. The row stays due, so the next
      // tick picks the work up and the reader after this one finds it there.
      if (outcome.status === 'throttled') return { status: 'throttled', retryAt: outcome.retryAt }
      // Lost the claim to an executor that got there first: wait for it.
    }

    return shapeRead<T>(
      await waitForEnvelope((k) => store.readResult(k), key, deadline, clock),
      clock.now(),
    )
  }

  /**
   * Waiting is for a fetch that is happening or about to. A row scheduled into
   * the future with no live lease means the query is backing off after a
   * failure, so nothing will land inside this budget.
   */
  const waitForSomeoneElse = async <T>(
    key: string,
    deadline: number,
  ): Promise<ReadResult<T> | null> => {
    if (store.readSchedule) {
      const now = clock.now()
      const row = await store.readSchedule(key)
      const leaseHeld = row !== null && row.leaseUntil !== null && row.leaseUntil > now
      if (row !== null && !leaseHeld && row.nextRunAt > now) return null
    }
    return shapeRead<T>(
      await waitForEnvelope((k) => store.readResult(k), key, deadline, clock),
      clock.now(),
    )
  }

  return async function read<T>(
    name: string,
    params?: QueryParams,
  ): Promise<ReadResult<T> | ThrottledRead | null> {
    const key = queryKey(name, params)
    const query = queries?.getByKey(key)
    const dynamic = query || !queries ? undefined : queries.dynamicFor(name)
    const open = query || dynamic || !queries ? undefined : queries.openFor(name)
    if (queries && !query && !dynamic && !open) throw new ConfigError(`unknown query '${name}'`)

    // An open base has no entries, so there is nothing stored to consult and
    // nothing to wait for: every read is its own call. Reading it without params
    // names no combination at all.
    if (open) {
      if (params === undefined) {
        throw new ConfigError(
          `query '${name}': anyParams names no list, so a read must pass params`,
        )
      }
      if (!canFetch) {
        throw new ConfigError(
          `query '${name}': anyParams is answered by a fresh call, so this reader needs a ` +
            'store that can claim and meter - pass the full store, not a results-only one',
        )
      }
      const now = clock.now()
      const outcome = await dispatcher!.runEphemeral(
        open.instantiate(params),
        now + open.timeoutMs,
        now,
      )
      if (outcome.status === 'throttled') {
        return { status: 'throttled', retryAt: outcome.retryAt }
      }
      if (outcome.status === 'failed') return null
      const at = clock.now()
      return { data: outcome.data as T, fetchedAt: at, isStale: false, age: 0, status: 'ok' }
    }

    const codec: QueryCodec | undefined = query?.codec ?? dynamic?.codec
    const shaped = shapeRead<T>(await store.readResult(key), clock.now())
    // A hit never waits and never touches upstream, however stale or expired it
    // is: refreshing that is the scheduler's job. A miss fetches, or waits for
    // whoever already is, bounded by this query's own timeout - one budget,
    // shared with resolving membership when the variant is dynamic. A dynamic
    // hit skips that resolution entirely; reconcile is the enforcer that removes
    // departed variants.
    if (shaped !== null) return decodeRead(shaped, codec)
    if (!queries) return null

    const deadline = clock.now() + (query?.timeoutMs ?? dynamic!.timeoutMs)
    let entry = query
    if (!entry) {
      entry = await resolveMemberBy(dynamic!, key, clock, deadline)
      if (!entry) throw new ConfigError(`unknown query '${name}'`)
    }
    if (!canFetch) return decodeRead(await waitForSomeoneElse<T>(key, deadline), codec)
    const fetched = await readThrough<T>(entry, key, deadline)
    if (fetched !== null && fetched.status === 'throttled') return fetched
    return decodeRead(fetched, codec)
  }
}
