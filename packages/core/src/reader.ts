import type { Clock } from './clock.js'
import { defineQueries, Queries } from './define-queries.js'
import { ConfigError } from './errors.js'
import { queryKey } from './query-key.js'
import { systemClock } from './system-clock.js'
import type {
  Envelope,
  QueryCodec,
  QueryDefinition,
  QueryParams,
  ReadResult,
  Store,
} from './types.js'

// How soon a waiting read first looks for an envelope another executor is
// fetching, and how far apart those looks are allowed to drift. The interval
// doubles up to the cap so a result that lands early is still seen almost at
// once, while a full-timeout wait costs a few dozen store reads rather than
// one per 50ms - on Cloudflare each of those is a billed subrequest against a
// per-invocation cap.
export const MISS_WAIT_POLL_INTERVAL_MS = 50
export const MAX_MISS_WAIT_POLL_INTERVAL_MS = 1_000

export function shapeRead<T>(env: Envelope | null, now: number): ReadResult<T> | null {
  if (!env) return null
  return {
    data: env.data as T,
    fetchedAt: env.fetchedAt,
    isStale: now >= env.freshUntil,
    age: now - env.fetchedAt,
    status: env.validUntil !== undefined && now >= env.validUntil ? 'invalid' : 'ok',
    ...(env.validUntil !== undefined ? { validUntil: env.validUntil } : {}),
    ...(env.lastError ? { lastError: env.lastError } : {}),
  }
}

export function decodeRead<T>(
  result: ReadResult<T> | null,
  codec: QueryCodec | undefined,
): ReadResult<T> | null {
  if (!result || !codec) return result
  return { ...result, data: codec.decode(result.data) as T }
}

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(() => resolve(), ms)
  })
}

/**
 * Polls the result store until an envelope appears or the deadline passes.
 * A promise cannot be shared across isolates, so waiting on someone else's
 * in-flight fetch means watching the store for its write-back.
 */
export async function waitForEnvelope(
  readResult: (name: string) => Promise<Envelope | null>,
  key: string,
  deadline: number,
  clock: Clock,
): Promise<Envelope | null> {
  let interval = MISS_WAIT_POLL_INTERVAL_MS
  for (;;) {
    const remaining = deadline - clock.now()
    if (remaining <= 0) return null
    await sleep(clock, Math.min(interval, remaining))
    const env = await readResult(key)
    if (env) return env
    interval = Math.min(interval * 2, MAX_MISS_WAIT_POLL_INTERVAL_MS)
  }
}

export interface ReaderConfig {
  /**
   * readResult is the only method a read needs. A store that also offers
   * readSchedule - `d1()` does - lets a miss tell "nothing is coming yet" from
   * "a retry is already scheduled for later" and answer the second one at once
   * instead of waiting it out.
   */
  store: Pick<Store, 'readResult'> & Partial<Pick<Store, 'readSchedule'>>
  /**
   * Rejects names outside it, and carries the timeout a miss waits for. Without
   * it a reader needs nothing but a store, and a miss answers null immediately
   * because there is no registry to say how long a first result may take.
   */
  queries?: Queries | readonly QueryDefinition[]
  clock?: Clock
}

export interface Reader {
  read<T = unknown>(name: string, params?: QueryParams): Promise<ReadResult<T> | null>
}

export function createReader(config: ReaderConfig): Reader {
  const { store, clock = systemClock } = config
  if (!store) throw new ConfigError('createReader requires a store')
  const registry =
    config.queries === undefined
      ? undefined
      : config.queries instanceof Queries
        ? config.queries
        : defineQueries(config.queries)

  return {
    async read<T>(name: string, params?: QueryParams): Promise<ReadResult<T> | null> {
      const key = queryKey(name, params)
      const query = registry?.getByKey(key)
      const dynamic = !query && registry ? registry.dynamicFor(name) : undefined
      if (registry && !query && !dynamic) throw new ConfigError(`unknown query '${name}'`)
      const codec = query?.codec ?? dynamic?.codec
      const shaped = shapeRead<T>(await store.readResult(key), clock.now())
      // A hit never waits. A miss waits for whichever executor is fetching, for
      // as long as that query may take - but only a registry knows how long.
      if (shaped !== null) return decodeRead(shaped, codec)
      if (!registry) return null
      let timeoutMs: number
      if (query) {
        timeoutMs = query.timeoutMs
      } else {
        const found = await dynamic!.member(key)
        if (!found) throw new ConfigError(`unknown query '${name}'`)
        timeoutMs = found.timeoutMs
      }
      // Waiting is for a fetch that is happening or about to. A row scheduled
      // into the future with no live lease means the query is backing off after
      // a failure, so nothing will land inside this budget.
      if (store.readSchedule) {
        const now = clock.now()
        const row = await store.readSchedule(key)
        const leaseHeld = row !== null && row.leaseUntil !== null && row.leaseUntil > now
        if (row !== null && !leaseHeld && row.nextRunAt > now) return null
      }
      const deadline = clock.now() + timeoutMs
      const waited = await waitForEnvelope((k) => store.readResult(k), key, deadline, clock)
      return decodeRead(shapeRead<T>(waited, clock.now()), codec)
    },
  }
}
