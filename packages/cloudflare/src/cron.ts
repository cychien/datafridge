import { ConfigError, createFridge, defineQueries, Queries, resolveSources } from '@datafridge/core'
import type { Driver, QueryDefinition, RunReport, SourcePolicy, Store } from '@datafridge/core'
import { assertTimeoutsFitInvocation } from './limits.js'

/**
 * Cron trigger driver: non-serialized because scheduled invocations can
 * overlap, so the schedule plane must provide atomic claims - which d1's CAS
 * provides.
 */
export function cronDriver(ctx: ExecutionContext): Driver {
  return { serialized: false, defer: (promise) => ctx.waitUntil(promise) }
}

export interface CronFridgeConfig<Env> {
  queries: Queries | readonly QueryDefinition[]
  store: (env: Env) => Store
  sources?: Record<string, SourcePolicy>
  /**
   * Operational hook after each tick. Do not log payloads or error details:
   * they come from application fetchers. A throwing hook is absorbed so one
   * bad log line cannot fail the invocation.
   */
  onRunReport?: (report: RunReport) => void | Promise<void>
}

export type CronScheduledHandler<Env> = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
) => Promise<void>

/**
 * One-line wiring for a cron trigger plus a CAS-protected store:
 *
 *   export default {
 *     scheduled: cronFridge<Env>({ queries, store: (env) => d1(env.DB) }),
 *   }
 *
 * Store factories take `env` because bindings only exist per invocation;
 * everything env-independent fails here, at config time.
 */
export function cronFridge<Env>(config: CronFridgeConfig<Env>): CronScheduledHandler<Env> {
  const queries = config.queries instanceof Queries ? config.queries : defineQueries(config.queries)
  assertTimeoutsFitInvocation(queries, 'cron trigger')
  if (typeof config.store !== 'function') {
    throw new ConfigError('cronFridge requires a store: pass store: (env) => d1(env.DB)')
  }
  resolveSources(config.sources)
  return async (_controller, env, ctx) => {
    const report = await createFridge({
      queries,
      driver: cronDriver(ctx),
      store: config.store(env),
      ...(config.sources ? { sources: config.sources } : {}),
    }).runDue()
    if (!config.onRunReport) return
    try {
      await config.onRunReport(report)
    } catch {
      // Error objects from application hooks can contain secrets.
      console.error('datafridge: onRunReport failed; the tick itself succeeded')
    }
  }
}
