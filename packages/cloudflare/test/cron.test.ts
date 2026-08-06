import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { ConfigError, createReader } from '@datafridge/core'
import type { QueryDef, Store } from '@datafridge/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { cronPoller } from '../src/cron.js'
import type { CronScheduledHandler } from '../src/cron.js'
import { d1 } from '../src/d1.js'

interface CronEnv {
  DB: D1Database
}

const controller = () => createScheduledController({ scheduledTime: new Date(), cron: '* * * * *' })

async function invoke(handler: CronScheduledHandler<CronEnv>): Promise<void> {
  const ctx = createExecutionContext()
  await handler(controller(), env, ctx)
  await waitOnExecutionContext(ctx)
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM datafridge_results'),
    env.DB.prepare('DELETE FROM datafridge_schedule'),
  ])
})

describe('cronPoller config-time validation', () => {
  const queries: readonly QueryDef[] = [{ name: 'q', every: '5m', fetch: async () => 1 }]

  function configErrorMessage(fn: () => unknown): string {
    try {
      fn()
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      return (err as ConfigError).message
    }
    return expect.unreachable('expected a ConfigError')
  }

  it('accepts the cron trigger plus full store shape without touching env', () => {
    expect(() => cronPoller<CronEnv>({ queries, store: (e) => d1(e.DB) })).not.toThrow()
  })

  it('rejects a missing store', () => {
    expect(configErrorMessage(() => cronPoller<CronEnv>({ queries } as never))).toBe(
      'cronPoller requires a store: pass store: (env) => d1(env.DB)',
    )
  })

  it('rejects a store that cannot claim atomically, since cron invocations overlap', () => {
    const withoutAtomicClaim = (env: CronEnv): Store => {
      const store = d1(env.DB)
      return { ...store, capabilities: { ...store.capabilities, atomicClaim: false } }
    }
    const handler = cronPoller<CronEnv>({ queries, store: withoutAtomicClaim })
    return expect(invoke(handler)).rejects.toThrow(/lacks atomicClaim/)
  })

  it('rejects a timeout that cannot fit a cron invocation', () => {
    expect(
      configErrorMessage(() =>
        cronPoller<CronEnv>({
          queries: [{ name: 'slow', every: '1h', timeout: '15m', fetch: async () => 1 }],
          store: (e) => d1(e.DB),
        }),
      ),
    ).toBe(
      "query 'slow': timeout (900000ms) must be shorter than the 900000ms wall-clock limit " +
        'of a Cloudflare cron trigger invocation; lower the timeout',
    )
  })

  it('accepts a timeout that fits', () => {
    expect(() =>
      cronPoller<CronEnv>({
        queries: [{ name: 'slow', every: '1h', timeout: '14m', fetch: async () => 1 }],
        store: (e) => d1(e.DB),
      }),
    ).not.toThrow()
  })
})

describe('cron shell e2e (scheduled handler + d1)', () => {
  it('a scheduled invocation fetches due queries into D1 and reschedules them', async () => {
    let ticks = 0
    const handler = cronPoller<CronEnv>({
      queries: [{ name: 'metrics', every: '5m', fetch: async () => ({ tick: ++ticks }) }],
      store: (e) => d1(e.DB),
    })

    await invoke(handler)
    expect(ticks).toBe(1)

    const read = await createReader({ store: d1(env.DB) }).read<{ tick: number }>('metrics')
    expect(read).not.toBeNull()
    expect(read!.data).toEqual({ tick: 1 })
    expect(read!.isStale).toBe(false)

    const row = await env.DB.prepare('SELECT * FROM datafridge_schedule WHERE name = ?')
      .bind('metrics')
      .first<{ next_run_at: number; lease_until: number | null; version: number }>()
    expect(row).not.toBeNull()
    expect(row!.version).toBe(1)
    expect(row!.lease_until).toBeNull()
    expect(row!.next_run_at).toBeGreaterThan(Date.now())

    // The next tick finds nothing due: no refetch.
    await invoke(handler)
    expect(ticks).toBe(1)
  })

  it('two concurrent scheduled invocations fetch every due query exactly once (CAS claim)', async () => {
    const counts = new Map<string, number>()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const query = (name: string): QueryDef => ({
      name,
      every: '5m',
      fetch: async () => {
        counts.set(name, (counts.get(name) ?? 0) + 1)
        await gate
        return name
      },
    })
    const handler = cronPoller<CronEnv>({
      queries: [query('a'), query('b'), query('c')],
      store: (e) => d1(e.DB),
    })

    const ctx1 = createExecutionContext()
    const ctx2 = createExecutionContext()
    const first = handler(controller(), env, ctx1)
    const second = handler(controller(), env, ctx2)
    // Hold the gate long enough for both invocations to race their claims.
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    await Promise.all([first, second])
    await waitOnExecutionContext(ctx1)
    await waitOnExecutionContext(ctx2)

    for (const name of ['a', 'b', 'c']) expect(counts.get(name)).toBe(1)

    const { results } = await env.DB.prepare(
      'SELECT name, version, lease_until FROM datafridge_schedule ORDER BY name',
    ).run<{ name: string; version: number; lease_until: number | null }>()
    expect(results.map((r) => r.name)).toEqual(['a', 'b', 'c'])
    expect(results.map((r) => r.version)).toEqual([1, 1, 1])
    expect(results.map((r) => r.lease_until)).toEqual([null, null, null])
  })
})
