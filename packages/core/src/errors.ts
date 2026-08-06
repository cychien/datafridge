export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError'
}

/**
 * Thrown by a fetcher that upstream turned away for rate reasons. Carrying the
 * vendor's own `Retry-After` beats guessing: the retry is scheduled for when the
 * vendor said, instead of the generic backoff curve. This is also the seam where
 * per-source retry strategies for specific algorithms will attach.
 */
export class RateLimitError extends Error {
  override readonly name = 'RateLimitError'
  readonly retryAfterMs?: number

  constructor(message: string, options: { retryAfterMs?: number } = {}) {
    super(message)
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}
