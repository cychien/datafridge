import { createScheduledController, createExecutionContext, env } from 'cloudflare:test'
import { createReader, defineQueries } from '@datafridge/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { cronPoller } from '../src/cron.js'
import { d1 } from '../src/d1.js'

interface SchemaEnv {
  DB: D1Database
}

// Storage is isolated per test file, so dropping the tables here cannot affect
// any other file. This file deliberately starts with no schema at all: it is the
// proof that applying the packaged migration is optional.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DROP TABLE IF EXISTS datafridge_results'),
    env.DB.prepare('DROP TABLE IF EXISTS datafridge_schedule'),
  ])
})

async function invoke(handler: ReturnType<typeof cronPoller<SchemaEnv>>): Promise<void> {
  const ctx = createExecutionContext()
  await handler(
    createScheduledController({ scheduledTime: new Date(), cron: '* * * * *' }),
    env as unknown as SchemaEnv,
    ctx,
  )
}

describe('d1 applies its own schema', () => {
  it('a tick works against a database with no datafridge tables', async () => {
    const handler = cronPoller<SchemaEnv>({
      queries: [{ name: 'metrics', every: '5m', fetch: async () => ({ ok: true }) }],
      store: (e) => d1(e.DB),
    })

    await invoke(handler)

    const read = await createReader({ store: d1(env.DB) }).read<{ ok: boolean }>('metrics')
    expect(read).not.toBeNull()
    expect(read!.data).toEqual({ ok: true })

    const row = await env.DB.prepare('SELECT * FROM datafridge_schedule WHERE name = ?')
      .bind('metrics')
      .first<{ version: number }>()
    expect(row!.version).toBe(1)
  })

  it('is idempotent: a second tick against the existing schema still refreshes', async () => {
    let ticks = 0
    const handler = cronPoller<SchemaEnv>({
      queries: [{ name: 'metrics', every: '1ms', fetch: async () => ({ tick: ++ticks }) }],
      store: (e) => d1(e.DB),
    })

    await invoke(handler)
    await invoke(handler)

    expect(ticks).toBe(2)
    const read = await createReader({ store: d1(env.DB) }).read<{ tick: number }>('metrics')
    expect(read!.data).toEqual({ tick: 2 })
  })

  it('recovers when the tables disappear under a warm isolate', async () => {
    let ticks = 0
    const handler = cronPoller<SchemaEnv>({
      queries: [{ name: 'metrics', every: '1ms', fetch: async () => ({ tick: ++ticks }) }],
      store: (e) => d1(e.DB),
    })

    await invoke(handler)
    expect(ticks).toBe(1)

    // A dropped database or a destructive migration, with the schema already
    // remembered as applied for this binding.
    await env.DB.batch([
      env.DB.prepare('DROP TABLE datafridge_results'),
      env.DB.prepare('DROP TABLE datafridge_schedule'),
    ])

    await invoke(handler)
    expect(ticks).toBe(2)
    const read = await createReader({ store: d1(env.DB) }).read<{ tick: number }>('metrics')
    expect(read!.data).toEqual({ tick: 2 })
  })

  it('reading before any table exists returns null instead of failing', async () => {
    const reader = createReader({ store: d1(env.DB) })
    await expect(reader.read('never-fetched')).resolves.toBeNull()
  })

  it('a real read failure still propagates', async () => {
    const broken = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error('D1_ERROR: network unreachable')
          },
        }),
      }),
    } as unknown as D1Database

    await expect(d1(broken).readResult('metrics')).rejects.toThrow(/network unreachable/)
  })
})

describe('a cold read over a real D1', () => {
  const queries = defineQueries([
    { name: 'metrics', every: '5m', timeout: '10s', fetch: async () => ({ ok: true }) },
  ])

  it('a cold read waits for the tick that fills it instead of answering null', async () => {
    // No tick has run and no tables exist: the cold first request, on the
    // scheduler whose next tick could be a minute away.
    const reader = createReader({ store: d1(env.DB), queries })
    const waiting = reader.read<{ ok: boolean }>('metrics')

    const handler = cronPoller<SchemaEnv>({ queries, store: (e) => d1(e.DB) })
    await invoke(handler)

    const result = await waiting
    expect(result).not.toBeNull()
    expect(result!.data).toEqual({ ok: true })
  })

  it('a store-only reader answers a cold read immediately, having no timeout to respect', async () => {
    const bare = createReader({ store: d1(env.DB) })
    expect(await bare.read('metrics')).toBeNull()
  })

  it("gives up at the query's own timeout when nothing writes", async () => {
    const impatient = defineQueries([
      { name: 'metrics', every: '5m', timeout: '300ms', fetch: async () => ({ ok: true }) },
    ])
    const reader = createReader({ store: d1(env.DB), queries: impatient })
    const started = Date.now()
    expect(await reader.read('metrics')).toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })

  it('refuses a dynamic base whose timeout cannot fit an invocation', () => {
    const tooSlow = defineQueries([
      {
        name: 'per-course',
        every: '30m',
        timeout: '20m',
        variants: async () => [{ courseId: 'alpha' }],
        fetch: async () => ({ ok: true }),
      },
    ])
    expect(() => cronPoller<SchemaEnv>({ queries: tooSlow, store: (e) => d1(e.DB) })).toThrow(
      /query 'per-course': timeout \(1200000ms\) must be shorter than the 900000ms/,
    )
  })

  it('refuses a name outside the registry instead of waiting it out', async () => {
    const reader = createReader({ store: d1(env.DB), queries })
    await expect(reader.read('metriks')).rejects.toThrow(/unknown query 'metriks'/)
  })
})
