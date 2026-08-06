import { parseDuration } from './duration.js'
import { ConfigError } from './errors.js'
import type { SourcePolicy } from './types.js'

export interface ResolvedSource {
  /** Ceiling for a fetch a reader is waiting on. */
  demandLimit: number
  /** Ceiling for a scheduled refresh: the same window, minus what is held back. */
  scheduledLimit: number
  windowMs: number
  maxConcurrent: number
}

export type ResolvedSources = ReadonlyMap<string, ResolvedSource>

function positiveInteger(value: unknown, at: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ConfigError(`${at} must be a positive integer`)
  }
  return value as number
}

/**
 * Turns declared source policies into the numbers the dispatcher gates on.
 * Adapters call this to reject bad configuration at their own construction time
 * rather than on the first tick, which is where guarantee six lives.
 */
export function resolveSources(
  sources: Readonly<Record<string, SourcePolicy>> | undefined,
): ResolvedSources {
  const resolved = new Map<string, ResolvedSource>()
  for (const [source, policy] of Object.entries(sources ?? {})) {
    const at = `source '${source}'`
    if (!policy || typeof policy !== 'object') {
      throw new ConfigError(`${at}: must be an object with limit and/or maxConcurrent`)
    }
    const { limit, maxConcurrent } = policy
    if (limit === undefined && maxConcurrent === undefined) {
      throw new ConfigError(`${at}: declares neither limit nor maxConcurrent, so it limits nothing`)
    }
    let demandLimit = Infinity
    let scheduledLimit = Infinity
    let windowMs = Infinity
    if (limit !== undefined) {
      if (typeof limit !== 'object') throw new ConfigError(`${at}: limit must be an object`)
      demandLimit = positiveInteger(limit.requests, `${at}: limit.requests`)
      windowMs = parseDuration(limit.per, `${at}: limit.per`)
      const reserve = limit.reserve ?? 0
      if (!Number.isInteger(reserve) || reserve < 0) {
        throw new ConfigError(`${at}: limit.reserve must be a non-negative integer`)
      }
      if (reserve >= demandLimit) {
        throw new ConfigError(
          `${at}: limit.reserve (${reserve}) must be smaller than limit.requests ` +
            `(${demandLimit}), or scheduled refreshes could never run`,
        )
      }
      scheduledLimit = demandLimit - reserve
    }
    resolved.set(source, {
      demandLimit,
      scheduledLimit,
      windowMs,
      maxConcurrent:
        maxConcurrent === undefined
          ? Infinity
          : positiveInteger(maxConcurrent, `${at}: maxConcurrent`),
    })
  }
  return resolved
}

export function windowStartOf(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs
}
