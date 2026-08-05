import { describe, expect, it } from 'vitest'

import { ConfigError, parseDuration } from '../src/index.js'

describe('parseDuration', () => {
  it('parses unit strings', () => {
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('1h')).toBe(3_600_000)
    expect(parseDuration('2d')).toBe(172_800_000)
    expect(parseDuration('1.5h')).toBe(5_400_000)
  })

  it('passes through positive numbers as milliseconds', () => {
    expect(parseDuration(1)).toBe(1)
    expect(parseDuration(60_000)).toBe(60_000)
  })

  it.each(['', '5', 'm5', '5x', '-5m', '5 m', 'abc'])('rejects invalid string %j', (value) => {
    expect(() => parseDuration(value as never)).toThrow(ConfigError)
  })

  it.each([0, -1, NaN, Infinity, -Infinity])('rejects invalid number %d', (value) => {
    expect(() => parseDuration(value)).toThrow(ConfigError)
  })

  it('names the offending field in the error', () => {
    expect(() => parseDuration('nope' as never, 'every')).toThrow(/every/)
  })
})
