import type { Clock } from './clock.js'
import type { Envelope, QueryCodec, ReadResult } from './types.js'

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
