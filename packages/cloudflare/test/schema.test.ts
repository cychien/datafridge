import { createScheduledController, createExecutionContext, env } from 'cloudflare:test'
import { createReader } from '@datafridge/core'
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
