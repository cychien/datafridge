import type { Clock } from './clock.js'
import { ConfigError } from './errors.js'
import { systemClock } from './system-clock.js'
import type { Envelope, ReadResult, ResultStore } from './types.js'

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
  results: ResultStore
  clock?: Clock
}

export interface Reader {
  read<T = unknown>(name: string): Promise<ReadResult<T> | null>
}

export function createReader(config: ReaderConfig): Reader {
  const { results, clock = systemClock } = config
  if (!results) throw new ConfigError('createReader requires a results store')
  return {
    async read<T>(name: string): Promise<ReadResult<T> | null> {
      return shapeRead<T>(await results.readResult(name), clock.now())
    },
  }
}
