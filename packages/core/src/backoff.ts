const BACKOFF_BASE_MS = 60_000
const JITTER_RATIO = 0.1

export function backoffMs(failCount: number, everyMs: number, random: () => number): number {
  const base = Math.min(everyMs, BACKOFF_BASE_MS * 2 ** (failCount - 1))
  return Math.round(base + random() * JITTER_RATIO * base)
}

export function firstRunJitterMs(everyMs: number, random: () => number): number {
  return Math.round(random() * JITTER_RATIO * everyMs)
}

/**
 * An upstream that named its own retry time is obeyed rather than guessed at,
 * but every executor it turned away heard the same number, so the jitter still
 * applies: without it they would all come back in the same millisecond.
 */
export function retryAfterMs(retryAfter: number, random: () => number): number {
  return Math.round(retryAfter + random() * JITTER_RATIO * retryAfter)
}

// Reconcile treats nextRunAt within [fetchedAt + every, fetchedAt + every * (1 + jitter)]
// as consistent with the current `every`; anything outside means `every` changed.
export const MAX_JITTER_RATIO = JITTER_RATIO
