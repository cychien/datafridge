import type { ReadResult, Store, ThrottledRead } from '@datafridge/core'

/**
 * What a read-only consumer gets: it can serve what is stored and tell a
 * backoff from a fetch in flight, and it can do nothing else. A reader over
 * this cannot claim, so it never fetches and never applies schema.
 */
export function readOnly(store: Store): Pick<Store, 'readResult' | 'readSchedule'> {
  return {
    readResult: (name) => store.readResult(name),
    readSchedule: (name) => store.readSchedule(name),
  }
}

/**
 * Narrows a read to the stored case. Tests that are not about rate limiting say
 * so by using this: being throttled there is a failure, not a branch to handle.
 */
export function stored<T>(result: ReadResult<T> | ThrottledRead | null): ReadResult<T> | null {
  if (result !== null && result.status === 'throttled') {
    throw new Error(`expected a stored read, got throttled until ${result.retryAt}`)
  }
  return result
}
