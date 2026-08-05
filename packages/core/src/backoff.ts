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

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
