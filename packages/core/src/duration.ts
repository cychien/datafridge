import { ConfigError } from './errors.js'

export type DurationString =
  `${number}ms` | `${number}s` | `${number}m` | `${number}h` | `${number}d`

export type Duration = number | DurationString

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/

export function parseDuration(value: Duration, field = 'duration'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`${field} must be a positive number of milliseconds, got ${value}`)
    }
    return value
  }
  if (typeof value === 'string') {
    const match = DURATION_RE.exec(value)
    if (match) {
      const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]!
      if (ms > 0) return ms
    }
    throw new ConfigError(
      `${field} must be a positive duration like '30s', '5m', '1h' or a number of milliseconds, got '${value}'`,
    )
  }
  throw new ConfigError(`${field} must be a duration string or a number of milliseconds`)
}
