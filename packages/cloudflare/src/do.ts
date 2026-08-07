import { DurableObject } from 'cloudflare:workers'
import { createFridge, defineQueries, Queries, resolveSources } from '@datafridge/core'
import type { QueryDefinition, RunReport, SourcePolicy, Store } from '@datafridge/core'
import { assertTimeoutsFitInvocation, INVOCATION_WALL_CLOCK_LIMIT_MS } from './limits.js'

const REGISTRY_META_KEY = 'registry'
const MIN_ALARM_DELAY_MS = 1_000
// Nothing in the registry is due and nothing is stored yet: look again on the
// shortest declared period rather than going quiet.
const IDLE_ALARM_DELAY_MS = 60_000

// The object keeps no dispatch state: schedule rows, leases, quota and results
// all live in the Store, so two of these - or one of these and a cron trigger -
// coordinate through it rather than through whoever happens to be the singleton.
// The only thing it remembers is which registry it last ignited for.
const BOOKKEEPING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS datafridge_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

function registrySignature(queries: Queries): string {
  const names = (entries: Array<readonly [string, ...number[]]>) =>
    entries.sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify([
    names(queries.all.map((q) => [q.name, q.everyMs] as const)),
    names(queries.dynamic.map((d) => [d.baseName, d.everyMs] as const)),
    names(queries.open.map((e) => [e.baseName, e.timeoutMs] as const)),
  ])
}

/** Nothing to run means nothing to wake for. */
function hasScheduledWork(queries: Queries): boolean {
  return queries.all.length > 0 || queries.dynamic.length > 0
}

/**
 * doAlarms driver: a Durable Object that wakes itself with alarms and runs the
 * core engine serialized against the Store you give it. It is a scheduler, not
 * a database - every row it works on lives in that Store. Subclasses declare
 * the registry and where the Store comes from:
 *
 *   export class Poller extends FridgeDO<Env> {
 *     queries = defineQueries([...])
 *     store(env: Env) { return d1(env.DB) }
 *   }
 *
 * Reads do not come here. A request path builds its own `createReader` over the
 * same Store, so serving data never queues behind one object.
 */
export abstract class FridgeDO<Env = unknown> extends DurableObject<Env> {
  abstract queries: Queries | readonly QueryDefinition[]
  abstract store(env: Env): Store
  sources?: Record<string, SourcePolicy>

  protected onRunReport(_report: RunReport): void | Promise<void> {}

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(BOOKKEEPING_SCHEMA)
    })
  }

  /**
   * Idempotent ignition: schedules an immediate alarm unless one is already
   * pending for the current registry. Safe to call on every read.
   */
  async ensureStarted(): Promise<void> {
    const queries = this.#resolveQueries()
    const signature = registrySignature(queries)
    const upToDate = this.#readMeta(REGISTRY_META_KEY) === signature
    if (upToDate && (await this.ctx.storage.getAlarm()) !== null) return
    this.#writeMeta(REGISTRY_META_KEY, signature)
    if (!hasScheduledWork(queries)) return
    await this.ctx.storage.setAlarm(Date.now())
  }

  override async alarm(): Promise<void> {
    const queries = this.#resolveQueries()
    let nextRunAt: number | null = null
    try {
      this.#writeMeta(REGISTRY_META_KEY, registrySignature(queries))
      const report = await createFridge({
        queries,
        store: this.store(this.env),
        driver: {
          serialized: true,
          defer: (promise) => this.ctx.waitUntil(promise),
          budgetMs: INVOCATION_WALL_CLOCK_LIMIT_MS,
        },
        ...(this.sources !== undefined ? { sources: this.sources } : {}),
      }).runDue()
      nextRunAt = report.nextRunAt
      await this.onRunReport(report)
    } catch {
      // Error objects from application hooks or storage can contain secrets.
      console.error('datafridge: alarm-level failure; alarm chain continues')
    } finally {
      await this.#scheduleNextAlarm(queries, nextRunAt)
    }
  }

  #resolveQueries(): Queries {
    const queries = this.queries
    const resolved = queries instanceof Queries ? queries : defineQueries(queries)
    assertTimeoutsFitInvocation(resolved, 'Durable Object alarm')
    resolveSources(this.sources)
    return resolved
  }

  /**
   * The tick that just ran already knows when there is work again - it computed
   * it from the rows it had in hand - so the alarm costs no further storage
   * read. A tick that never got that far falls back to looking again shortly,
   * which is also what a tick with leftover work asks for; the one-second floor
   * is what keeps "again now" from becoming a spin.
   */
  async #scheduleNextAlarm(queries: Queries, nextRunAt: number | null): Promise<void> {
    const now = Date.now()
    if (nextRunAt === null && !hasScheduledWork(queries)) return
    const at = nextRunAt ?? now + IDLE_ALARM_DELAY_MS
    await this.ctx.storage.setAlarm(Math.max(at, now + MIN_ALARM_DELAY_MS))
  }

  #readMeta(key: string): string | null {
    const record = this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM datafridge_meta WHERE key = ?', key)
      .toArray()[0]
    return record ? record.value : null
  }

  #writeMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO datafridge_meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key,
      value,
    )
  }
}

interface FridgeNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { ensureStarted(): Promise<void> }
}

/**
 * Ignites (or re-ignites after a redeploy) the alarm chain of a FridgeDO.
 * Idempotent and cheap once running; hang it on the read path or a post-deploy
 * hook.
 */
export async function ensureStarted(
  namespace: FridgeNamespace,
  instanceName = 'datafridge',
): Promise<void> {
  await namespace.get(namespace.idFromName(instanceName)).ensureStarted()
}
