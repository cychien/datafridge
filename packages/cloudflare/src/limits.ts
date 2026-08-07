import { ConfigError, Queries } from '@datafridge/core'

// Cron Triggers and Durable Object alarms both get 15 minutes of wall time
// (developers.cloudflare.com/workers/platform/limits, Duration).
export const INVOCATION_WALL_CLOCK_LIMIT_MS = 900_000

export function assertTimeoutsFitInvocation(queries: Queries, invocation: string): void {
  // Dynamic and on-demand bases are checked by name too: their entries only
  // exist as rows, so queries.all never carries them and an over-long timeout
  // would otherwise be found by the platform killing the invocation instead of
  // by construction.
  const named: Array<[string, number]> = [
    ...queries.all.map((query): [string, number] => [query.name, query.timeoutMs]),
    ...queries.dynamic.map((entry): [string, number] => [entry.baseName, entry.timeoutMs]),
    ...queries.onDemand.map((entry): [string, number] => [entry.baseName, entry.timeoutMs]),
  ]
  for (const [name, timeoutMs] of named) {
    if (timeoutMs >= INVOCATION_WALL_CLOCK_LIMIT_MS) {
      throw new ConfigError(
        `query '${name}': timeout (${timeoutMs}ms) must be shorter than the ` +
          `${INVOCATION_WALL_CLOCK_LIMIT_MS}ms wall-clock limit of a Cloudflare ${invocation} ` +
          'invocation; lower the timeout',
      )
    }
  }
}
