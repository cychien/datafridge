import { env } from 'cloudflare:test'
import type { Envelope } from '@datafridge/core'
import { describe, expect, it } from 'vitest'

import { d1 } from '../src/d1.js'
import { wipeStore } from './helpers.js'

/** Counts what a call actually asks of D1, which is the thing under test here. */
function counting(db: D1Database): { db: D1Database; statements: string[] } {
  const statements: string[] = []
  const wrapped = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (query: string) => {
          statements.push(query)
          return target.prepare(query)
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { db: wrapped, statements }
}

describe('d1 concurrency permits', () => {
  it('costs one statement to be refused, and only pays for a reason on request', async () => {
    await wipeStore(env.DB)
    const { db, statements } = counting(env.DB)
    const store = d1(db)
    // The schema is applied lazily, so warm it before anything is counted.
    await store.acquirePermit('posthog', 1, 'warm', 90_000, 1_000)
    await store.releasePermit('posthog', 'warm')
    await store.acquirePermit('posthog', 1, 'held', 90_000, 1_000)

    // A saturated source refuses far more often than it grants, and a reader
    // polling out its timeout discards every reason but the last.
    statements.length = 0
    expect(await store.acquirePermit('posthog', 1, 'poll', 90_000, 1_000, false)).toEqual({
      granted: false,
      retryAt: null,
    })
    expect(statements).toHaveLength(1)

    statements.length = 0
    expect(await store.acquirePermit('posthog', 1, 'poll', 90_000, 1_000, true)).toEqual({
      granted: false,
      retryAt: 90_000,
    })
    expect(statements.length).toBeGreaterThan(1)

    // Cheap refusals are still refusals: the ceiling is unchanged.
    await store.releasePermit('posthog', 'held')
    expect(await store.acquirePermit('posthog', 1, 'poll', 90_000, 1_000, false)).toEqual({
      granted: true,
    })
  })
})

describe('d1.writeResult envelope size guard', () => {
  it('rejects an envelope above the D1 row limit and keeps the previous one', async () => {
    const results = d1(env.DB)
    const good: Envelope = { data: { posts: ['hello'] }, fetchedAt: 1_000, freshUntil: 61_000 }
    await results.writeResult('posts', good)

    const oversized: Envelope = {
      data: 'x'.repeat(2_000_001),
      fetchedAt: 2_000,
      freshUntil: 62_000,
    }
    await expect(results.writeResult('posts', oversized)).rejects.toThrow(
      /envelope for query "posts" .* exceeding D1's 2000000-byte row limit/,
    )

    expect(await results.readResult('posts')).toEqual(good)
  })
})
