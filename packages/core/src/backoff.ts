const BACKOFF_BASE_MS = 60_000
const JITTER_RATIO = 0.1

export function backoffMs(failCount: number, everyMs: number, random: () => number): number {
  const base = Math.min(everyMs, BACKOFF_BASE_MS * 2 ** (failCount - 1))
  return Math.round(base + random() * JITTER_RATIO * base)
}

export function firstRunJitterMs(everyMs: number, random: () => number): number {
  return Math.round(random() * JITTER_RATIO * everyMs)
}

// Reconcile treats nextRunAt within [fetchedAt + every, fetchedAt + every * (1 + jitter)]
// as consistent with the current `every`; anything outside means `every` changed.
export const MAX_JITTER_RATIO = JITTER_RATIO
