import { describe, expect, it } from 'vitest'

import { ConfigError, queryKey, VARIANT_KEY_PREFIX } from '../src/index.js'
import type { QueryParams } from '../src/index.js'

describe('queryKey', () => {
  it('uses canonical JSON and a stable SHA-256 identity', () => {
    const expected =
      '@df/v1/analytics/9291ba3bb82908a3762df904014a1ea0be348cdd86c949074b8658228139b3a9'
    expect(queryKey('analytics', { courseId: 'course-a', window: '7d' })).toBe(expected)
    expect(queryKey('analytics', { window: '7d', courseId: 'course-a' })).toBe(expected)
  })

  it('does not include parameter values and separates distinct JSON shapes', () => {
    const first = queryKey('analytics', { courseId: 'private-slug', window: '7d' })
    expect(first).not.toContain('private-slug')
    expect(first).not.toContain('7d')
    expect(queryKey('analytics', [1, 23])).not.toBe(queryKey('analytics', [12, 3]))
    expect(queryKey('analytics', { value: '1' })).not.toBe(queryKey('analytics', { value: 1 }))
  })

  it('leaves fixed query names unchanged and reserves the variant namespace', () => {
    expect(queryKey('fixed')).toBe('fixed')
    expect(() => queryKey(`${VARIANT_KEY_PREFIX}forged`)).toThrow(ConfigError)
  })

  it.each([
    ['non-finite numbers', { value: Number.NaN }],
    ['class instances', { value: new Date(0) }],
    ['undefined', { value: undefined }],
    ['sparse arrays', Array(1)],
  ])('rejects %s', (_label, params) => {
    expect(() => queryKey('analytics', params as QueryParams)).toThrow(ConfigError)
  })

  it('rejects cycles', () => {
    const params: Record<string, QueryParams> = {}
    params.self = params
    expect(() => queryKey('analytics', params)).toThrow('query params must not contain cycles')
  })
})
