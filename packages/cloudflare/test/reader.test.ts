import { env, runInDurableObject, SELF } from 'cloudflare:test'
import type { QueryDef } from '@datafridge/core'
import { describe, expect, it, vi } from 'vitest'

import { ensureStarted } from '../src/do.js'
import type { TestFridge } from './worker.js'

const queries: readonly QueryDef[] = [
  { name: 'posts', every: '1m', fetch: async () => ({ posts: ['hello'] }) },
]

describe('read path in a separate Worker context', () => {
  it('reads D1 directly through createReader without touching the DO', async () => {
    const before = await SELF.fetch('http://example.com/read/posts')
    expect(before.status).toBe(200)
    expect(await before.json()).toBeNull()

    const stub = env.POLLER.get(env.POLLER.idFromName('datafridge'))
    await runInDurableObject(stub, async (instance) => {
      ;(instance as TestFridge).queries = queries
    })
    await ensureStarted(env.POLLER)

    const body = await vi.waitFor(
      async () => {
        const res = await SELF.fetch('http://example.com/read/posts')
        const parsed = await res.json<{
          data: { posts: string[] }
          fetchedAt: number
          isStale: boolean
          age: number
        } | null>()
        expect(parsed).not.toBeNull()
        return parsed!
      },
      { timeout: 5_000 },
    )

    expect(body.data).toEqual({ posts: ['hello'] })
    expect(typeof body.fetchedAt).toBe('number')
    expect(body.isStale).toBe(false)
    expect(body.age).toBeGreaterThanOrEqual(0)
  })
})
