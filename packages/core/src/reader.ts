import type { Clock } from './clock.js'
import { ConfigError } from './errors.js'
import { queryKey } from './query-key.js'
import { systemClock } from './system-clock.js'
import type { Envelope, QueryParams, ReadResult, Store } from './types.js'

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

export interface ReaderConfig {
  /** Only readResult is ever called, so a read-only consumer can supply just that. */
  store: Pick<Store, 'readResult'>
  clock?: Clock
}

export interface Reader {
  read<T = unknown>(name: string, params?: QueryParams): Promise<ReadResult<T> | null>
}

export function createReader(config: ReaderConfig): Reader {
  const { store, clock = systemClock } = config
  if (!store) throw new ConfigError('createReader requires a store')
  return {
    async read<T>(name: string, params?: QueryParams): Promise<ReadResult<T> | null> {
      return shapeRead<T>(await store.readResult(queryKey(name, params)), clock.now())
    },
  }
}
