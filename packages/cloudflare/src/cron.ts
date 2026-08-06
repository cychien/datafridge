import { ConfigError, createPoller, defineQueries, Queries } from '@datafridge/core'
import type { Driver, QueryDefinition, SourceBudget, Store } from '@datafridge/core'
import { assertTimeoutsFitInvocation } from './limits.js'

/**
 * Cron trigger driver: non-serialized because scheduled invocations can
 * overlap, so the schedule plane must provide atomic claims - which d1's CAS
 * provides.
 */
export function cronDriver(ctx: ExecutionContext): Driver {
  return { serialized: false, defer: (promise) => ctx.waitUntil(promise) }
}

export interface CronPollerConfig<Env> {
  queries: Queries | readonly QueryDefinition[]
  store: (env: Env) => Store
  sources?: Record<string, SourceBudget>
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
 *     scheduled: cronPoller<Env>({ queries, store: (env) => d1(env.DB) }),
 *   }
 *
 * Store factories take `env` because bindings only exist per invocation;
 * everything env-independent fails here, at config time.
 */
export function cronPoller<Env>(config: CronPollerConfig<Env>): CronScheduledHandler<Env> {
  const queries = config.queries instanceof Queries ? config.queries : defineQueries(config.queries)
  assertTimeoutsFitInvocation(queries, 'cron trigger')
  if (typeof config.store !== 'function') {
    throw new ConfigError('cronPoller requires a store: pass store: (env) => d1(env.DB)')
  }
  return async (_controller, env, ctx) => {
    await createPoller({
      queries,
      driver: cronDriver(ctx),
      store: config.store(env),
      ...(config.sources ? { sources: config.sources } : {}),
    }).runDue()
  }
}
