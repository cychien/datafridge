import { DurableObject } from 'cloudflare:workers'
import { ConfigError, createFridge, defineQueries, Queries, variantBaseOf } from '@datafridge/core'
import type {
  QueryDefinition,
  RunReport,
  SchedulePlane,
  ScheduleRow,
  SourceBudget,
  Store,
} from '@datafridge/core'
import { assertTimeoutsFitInvocation } from './limits.js'

const REGISTRY_META_KEY = 'registry'
const MIN_ALARM_DELAY_MS = 1_000

const BOOKKEEPING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS datafridge_schedule (
    name TEXT PRIMARY KEY,
    next_run_at INTEGER NOT NULL,
    fail_count INTEGER NOT NULL,
    lease_until INTEGER,
    version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS datafridge_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

type ScheduleRecord = {
  name: string
  next_run_at: number
  fail_count: number
  lease_until: number | null
  version: number
}

function toScheduleRow(record: ScheduleRecord): ScheduleRow {
  return {
    name: record.name,
    nextRunAt: record.next_run_at,
    failCount: record.fail_count,
    leaseUntil: record.lease_until,
    version: record.version,
  }
}

// The DO is a single-threaded actor and SqlStorage is synchronous, so every
// method below is atomic without CAS gymnastics; claim is still implemented
// with full version/lease semantics so core sees the exact contract.
function sqliteSchedulePlane(sql: SqlStorage): SchedulePlane {
  const readRecord = (name: string): ScheduleRecord | undefined =>
    sql.exec<ScheduleRecord>('SELECT * FROM datafridge_schedule WHERE name = ?', name).toArray()[0]

  return {
    capabilities: { atomicClaim: true, listDue: true },

    async readSchedule(name) {
      const record = readRecord(name)
      return record ? toScheduleRow(record) : null
    },

    async writeSchedule(row) {
      sql.exec(
        'INSERT INTO datafridge_schedule (name, next_run_at, fail_count, lease_until, version) ' +
          'VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT (name) DO UPDATE SET next_run_at = excluded.next_run_at, ' +
          'fail_count = excluded.fail_count, lease_until = excluded.lease_until, ' +
          'version = excluded.version',
        row.name,
        row.nextRunAt,
        row.failCount,
        row.leaseUntil,
        row.version,
      )
    },

    async deleteSchedule(name) {
      sql.exec('DELETE FROM datafridge_schedule WHERE name = ?', name)
    },

    async claim(name, expectedVersion, leaseUntil, now) {
      const record = readRecord(name)
      if (!record) {
        if (expectedVersion !== 0) return false
        sql.exec(
          'INSERT INTO datafridge_schedule (name, next_run_at, fail_count, lease_until, version) ' +
            'VALUES (?, ?, 0, ?, 1)',
          name,
          now,
          leaseUntil,
        )
        return true
      }
      if (record.version !== expectedVersion) return false
      if (record.lease_until !== null && record.lease_until > now) return false
      sql.exec(
        'UPDATE datafridge_schedule SET version = version + 1, lease_until = ? WHERE name = ?',
        leaseUntil,
        name,
      )
      return true
    },

    async listDue(now, limit) {
      return sql
        .exec<ScheduleRecord>(
          'SELECT * FROM datafridge_schedule WHERE next_run_at <= ? ' +
            'ORDER BY next_run_at, name LIMIT ?',
          now,
          limit,
        )
        .toArray()
        .map(toScheduleRow)
    },
  }
}

function validateSourceBudgets(sources: Record<string, SourceBudget> | undefined): void {
  for (const [source, budget] of Object.entries(sources ?? {})) {
    if (!Number.isInteger(budget.maxPerTick) || budget.maxPerTick < 1) {
      throw new ConfigError(`source '${source}': maxPerTick must be a positive integer`)
    }
  }
}

function registrySignature(queries: Queries): string {
  const names = (entries: Array<[string, number]>) =>
    entries.sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify([
    names(queries.all.map((q) => [q.name, q.everyMs])),
    names(queries.dynamic.map((d) => [d.baseName, d.everyMs])),
  ])
}

/**
 * doAlarms driver: a Durable Object that wakes itself with alarms, runs the
 * core engine serialized, and keeps schedule bookkeeping in its own SQLite.
 * Subclasses declare the registry and where envelopes live:
 *
 *   export class Poller extends FridgeDO<Env> {
 *     queries = defineQueries([...])
 *     store(env: Env) { return d1(env.DB) }
 *   }
 */
export abstract class FridgeDO<Env = unknown> extends DurableObject<Env> {
  abstract queries: Queries | readonly QueryDefinition[]
  abstract store(env: Env): Store
  sources?: Record<string, SourceBudget>

  protected onRunReport(_report: RunReport): void | Promise<void> {}

  readonly #schedule: SchedulePlane

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(BOOKKEEPING_SCHEMA)
    })
    this.#schedule = sqliteSchedulePlane(ctx.storage.sql)
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
    if (
      queries.all.length === 0 &&
      queries.dynamic.length === 0 &&
      this.#scheduleRowCount() === 0
    ) {
      this.#writeMeta(REGISTRY_META_KEY, signature)
      return
    }
    this.#writeMeta(REGISTRY_META_KEY, signature)
    await this.ctx.storage.setAlarm(Date.now())
  }

  override async alarm(): Promise<void> {
    const queries = this.#resolveQueries()
    try {
      this.#writeMeta(REGISTRY_META_KEY, registrySignature(queries))
      const fridge = createFridge({
        queries,
        store: this.store(this.env),
        driver: {
          serialized: true,
          defer: (promise) => this.ctx.waitUntil(promise),
          schedule: this.#schedule,
        },
        ...(this.sources !== undefined ? { sources: this.sources } : {}),
      })
      const report = await fridge.runDue()
      await this.onRunReport(report)
    } catch {
      // Error objects from application hooks or storage can contain secrets.
      console.error('datafridge: alarm-level failure; alarm chain continues')
    } finally {
      await this.#scheduleNextAlarm(queries)
    }
  }

  #resolveQueries(): Queries {
    const queries = this.queries
    const resolved = queries instanceof Queries ? queries : defineQueries(queries)
    assertTimeoutsFitInvocation(resolved, 'Durable Object alarm')
    validateSourceBudgets(this.sources)
    return resolved
  }

  async #scheduleNextAlarm(queries: Queries): Promise<void> {
    const now = Date.now()
    const rows = this.ctx.storage.sql
      .exec<{
        name: string
        next_run_at: number
      }>('SELECT name, next_run_at FROM datafridge_schedule')
      .toArray()
    const byName = new Map(rows.map((row) => [row.name, row.next_run_at]))

    let next: number | null = null
    const consider = (at: number): void => {
      next = next === null ? at : Math.min(next, at)
    }
    for (const query of queries.all) consider(byName.get(query.name) ?? now)

    if (queries.dynamic.length > 0) {
      // Dynamic variants exist only as rows, so the alarm has to come from the
      // table. A base whose resolution failed carries its backoff in a row of
      // its own: that retry time governs, and its variant rows are ignored
      // however overdue they look, because none of them can run until the list
      // resolves again. A base with no rows at all is woken on its own period.
      const bases = new Set(queries.dynamic.map((entry) => entry.baseName))
      const blocked = new Set<string>()
      for (const entry of queries.dynamic) {
        const retryAt = byName.get(entry.baseName)
        if (retryAt === undefined) continue
        consider(retryAt)
        if (retryAt > now) blocked.add(entry.baseName)
      }
      const covered = new Set<string>()
      for (const row of rows) {
        const base = variantBaseOf(row.name)
        if (base === undefined || !bases.has(base) || blocked.has(base)) continue
        consider(row.next_run_at)
        covered.add(base)
      }
      for (const entry of queries.dynamic) {
        if (!covered.has(entry.baseName) && !byName.has(entry.baseName)) {
          consider(now + entry.everyMs)
        }
      }
    }

    if (next === null) return
    await this.ctx.storage.setAlarm(Math.max(next, now + MIN_ALARM_DELAY_MS))
  }

  #scheduleRowCount(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM datafridge_schedule')
      .one().n
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
