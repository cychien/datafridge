import { describe, expect, it } from 'vitest'

import { ConfigError, defineQueries } from '../src/index.js'

const fetch = async () => 'data'

describe('defineQueries', () => {
  it('normalizes durations to milliseconds and applies defaults', () => {
    const queries = defineQueries([{ name: 'q', every: '5m', fetch }])
    const q = queries.get('q')!
    expect(q.everyMs).toBe(300_000)
    expect(q.timeoutMs).toBe(30_000)
    expect(q.leaseMs).toBe(60_000)
    expect(q.source).toBe('default')
  })

  it('respects explicit timeout, lease and source', () => {
    const queries = defineQueries([
      { name: 'q', every: '1h', timeout: '2m', lease: '3m', source: 'posthog', fetch },
    ])
    const q = queries.get('q')!
    expect(q.timeoutMs).toBe(120_000)
    expect(q.leaseMs).toBe(180_000)
    expect(q.source).toBe('posthog')
  })

  it('rejects duplicate names', () => {
    expect(() =>
      defineQueries([
        { name: 'dup', every: '5m', fetch },
        { name: 'dup', every: '1h', fetch },
      ]),
    ).toThrow(/duplicate query name 'dup'/)
  })

  it('rejects timeout >= lease', () => {
    expect(() =>
      defineQueries([{ name: 'q', every: '5m', timeout: '2m', lease: '1m', fetch }]),
    ).toThrow(ConfigError)
    expect(() =>
      defineQueries([{ name: 'q', every: '5m', timeout: '1m', lease: '1m', fetch }]),
    ).toThrow(/timeout .* must be shorter than lease/)
  })

  it.each(['5x', '', 0, -1, NaN] as const)('rejects invalid every %j', (every) => {
    expect(() => defineQueries([{ name: 'q', every: every as never, fetch }])).toThrow(ConfigError)
  })

  it('rejects invalid timeout and lease durations', () => {
    expect(() =>
      defineQueries([{ name: 'q', every: '5m', timeout: 'zzz' as never, fetch }]),
    ).toThrow(ConfigError)
    expect(() => defineQueries([{ name: 'q', every: '5m', lease: -5 as never, fetch }])).toThrow(
      ConfigError,
    )
  })

  it('rejects missing name and missing fetch', () => {
    expect(() => defineQueries([{ name: '', every: '5m', fetch }])).toThrow(ConfigError)
    expect(() => defineQueries([{ name: 'q', every: '5m' } as never])).toThrow(ConfigError)
  })

  it('freezes the resolved registry', () => {
    const queries = defineQueries([{ name: 'q', every: '5m', fetch }])
    expect(Object.isFrozen(queries.all)).toBe(true)
    expect(Object.isFrozen(queries.get('q'))).toBe(true)
  })
})
