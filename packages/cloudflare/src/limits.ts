import { ConfigError, Queries } from '@datafridge/core'

// Cron Triggers and Durable Object alarms both get 15 minutes of wall time
// (developers.cloudflare.com/workers/platform/limits, Duration).
export const INVOCATION_WALL_CLOCK_LIMIT_MS = 900_000

export function assertTimeoutsFitInvocation(queries: Queries, invocation: string): void {
  for (const query of queries.all) {
    if (query.timeoutMs >= INVOCATION_WALL_CLOCK_LIMIT_MS) {
      throw new ConfigError(
        `query '${query.name}': timeout (${query.timeoutMs}ms) must be shorter than the ` +
          `${INVOCATION_WALL_CLOCK_LIMIT_MS}ms wall-clock limit of a Cloudflare ${invocation} ` +
          'invocation; lower the timeout',
      )
    }
  }
}
