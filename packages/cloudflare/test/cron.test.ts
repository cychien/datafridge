import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { ConfigError, createReader } from '@datafridge/core'
import type { QueryDef } from '@datafridge/core'
import { beforeEach, describe, expect, it } from 'vitest'

import { cronPoller } from '../src/cron.js'
import type { CronScheduledHandler } from '../src/cron.js'
import { d1Results, d1Store } from '../src/d1.js'

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

  it('accepts the combo B shape without touching env', () => {
    expect(() => cronPoller<CronEnv>({ queries, store: (e) => d1Store(e.DB) })).not.toThrow()
  })

  it('rejects passing both store and results', () => {
    expect(
      configErrorMessage(() =>
        cronPoller<CronEnv>({
          queries,
          store: (e) => d1Store(e.DB),
          results: (e) => d1Results(e.DB),
        }),
      ),
    ).toBe('cronPoller: pass either store or results, not both')
  })

  it('rejects a missing store', () => {
    expect(configErrorMessage(() => cronPoller<CronEnv>({ queries }))).toBe(
      'cronPoller requires a store: pass store: (env) => d1Store(env.DB), or results plus schedule',
    )
  })

  it('rejects results without a schedule plane (DESIGN rule 4 counterexample, at config time)', () => {
    expect(
      configErrorMessage(() => cronPoller<CronEnv>({ queries, results: (e) => d1Results(e.DB) })),
    ).toBe(
      'no valid schedule plane: the cron driver is not serialized and results alone cannot ' +
        'host schedule bookkeeping; pass a full store with atomic claims ' +
        '(store: (env) => d1Store(env.DB)) or an explicit schedule factory',
    )
  })

  it('rejects a timeout that cannot fit a cron invocation', () => {
    expect(
      configErrorMessage(() =>
        cronPoller<CronEnv>({
          queries: [{ name: 'slow', every: '1h', timeout: '15m', fetch: async () => 1 }],
          store: (e) => d1Store(e.DB),
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
        store: (e) => d1Store(e.DB),
      }),
    ).not.toThrow()
  })
})

describe('cron shell e2e (combo B: scheduled handler + d1Store)', () => {
  it('a scheduled invocation fetches due queries into D1 and reschedules them', async () => {
    let ticks = 0
    const handler = cronPoller<CronEnv>({
      queries: [{ name: 'metrics', every: '5m', fetch: async () => ({ tick: ++ticks }) }],
      store: (e) => d1Store(e.DB),
    })

    await invoke(handler)
    expect(ticks).toBe(1)

    const read = await createReader({ results: d1Results(env.DB) }).read<{ tick: number }>(
      'metrics',
    )
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
      store: (e) => d1Store(e.DB),
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
