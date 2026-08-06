import type { Clock } from './clock.js'
import { TimeoutError } from './errors.js'

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {})
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * Runs application code under a deadline. A promise cannot be killed, so the
 * race only stops datafridge waiting; the signal is what lets the application
 * cancel the work it started. Every call into user code goes through here.
 */
export async function withDeadline<T>(
  clock: Clock,
  timeoutMs: number,
  what: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const handle = clock.setTimeout(
    () => controller.abort(new TimeoutError(`${what} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  )
  try {
    return await raceAbort(run(controller.signal), controller.signal)
  } finally {
    clock.clearTimeout(handle)
  }
}
