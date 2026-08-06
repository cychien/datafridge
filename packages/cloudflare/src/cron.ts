import { ConfigError, createPoller, defineQueries, Queries } from '@datafridge/core'
import type {
  Driver,
  QueryDefinition,
  ResultStore,
  ScheduleStore,
  SourceBudget,
  Store,
} from '@datafridge/core'
import { assertTimeoutsFitInvocation } from './limits.js'

/**
 * Cron trigger driver: non-serialized because scheduled invocations can
 * overlap, so the schedule plane must provide atomic claims - combo B pairs it
 * with d1Store's CAS.
 */
export function cronDriver(ctx: ExecutionContext): Driver {
  return { serialized: false, defer: (promise) => ctx.waitUntil(promise) }
}

export interface CronPollerConfig<Env> {
  queries: Queries | readonly QueryDefinition[]
  store?: (env: Env) => Store
  results?: (env: Env) => ResultStore
  schedule?: (env: Env) => ScheduleStore
  sources?: Record<string, SourceBudget>
}

export type CronScheduledHandler<Env> = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
) => Promise<void>

/**
 * One-line wiring for combo B (cron trigger + CAS-protected store):
 *
 *   export default {
 *     scheduled: cronPoller<Env>({ queries, store: (env) => d1Store(env.DB) }),
 *   }
 *
 * Store factories take `env` because bindings only exist per invocation;
 * everything env-independent fails here, at config time.
 */
export function cronPoller<Env>(config: CronPollerConfig<Env>): CronScheduledHandler<Env> {
  const queries = config.queries instanceof Queries ? config.queries : defineQueries(config.queries)
  assertTimeoutsFitInvocation(queries, 'cron trigger')
  if (config.store && config.results) {
    throw new ConfigError('cronPoller: pass either store or results, not both')
  }
  if (!config.store && !config.results) {
    throw new ConfigError(
      'cronPoller requires a store: pass store: (env) => d1Store(env.DB), or results plus schedule',
    )
  }
  if (config.results && !config.schedule) {
    throw new ConfigError(
      'no valid schedule plane: the cron driver is not serialized and results alone cannot ' +
        'host schedule bookkeeping; pass a full store with atomic claims ' +
        '(store: (env) => d1Store(env.DB)) or an explicit schedule factory',
    )
  }
  return async (_controller, env, ctx) => {
    await createPoller({
      queries,
      driver: cronDriver(ctx),
      ...(config.store ? { store: config.store(env) } : { results: config.results!(env) }),
      ...(config.schedule ? { schedule: config.schedule(env) } : {}),
      ...(config.sources ? { sources: config.sources } : {}),
    }).runDue()
  }
}
