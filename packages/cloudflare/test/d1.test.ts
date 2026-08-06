import { env } from 'cloudflare:test'
import type { Envelope } from '@datafridge/core'
import { describe, expect, it } from 'vitest'

import { d1Results } from '../src/d1.js'

describe('d1Results.writeResult envelope size guard', () => {
  it('rejects an envelope above the D1 row limit and keeps the previous one', async () => {
    const results = d1Results(env.DB)
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
