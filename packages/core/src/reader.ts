import type { Clock } from './clock.js'
import { defineQueries, Queries } from './define-queries.js'
import { ConfigError } from './errors.js'
import { queryKey } from './query-key.js'
import { systemClock } from './system-clock.js'
import type { Envelope, QueryDefinition, QueryParams, ReadResult, Store } from './types.js'

// How often a waiting read looks for an envelope another executor is fetching.
// Cheap enough to poll, long enough not to hammer the store.
export const MISS_WAIT_POLL_INTERVAL_MS = 50

export function shapeRead<T>(env: Envelope | null, now: number): ReadResult<T> | null {
  if (!env) return null
  return {
    data: env.data as T,
    fetchedAt: env.fetchedAt,
    isStale: now >= env.freshUntil,
    age: now - env.fetchedAt,
    ...(env.lastError ? { lastError: env.lastError } : {}),
  }
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
  for (;;) {
    const remaining = deadline - clock.now()
    if (remaining <= 0) return null
    await sleep(clock, Math.min(MISS_WAIT_POLL_INTERVAL_MS, remaining))
    const env = await readResult(key)
    if (env) return env
  }
}

export interface ReaderConfig {
  /** Only readResult is ever called, so a read-only consumer can supply just that. */
  store: Pick<Store, 'readResult'>
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
      if (registry && !query) throw new ConfigError(`unknown query '${name}'`)
      const shaped = shapeRead<T>(await store.readResult(key), clock.now())
      // A hit never waits. A miss waits for whichever executor is fetching, for
      // as long as that query may take - but only a registry knows how long.
      if (shaped !== null || !query) return shaped
      const deadline = clock.now() + query.timeoutMs
      const waited = await waitForEnvelope((k) => store.readResult(k), key, deadline, clock)
      return shapeRead<T>(waited, clock.now())
    },
  }
}
