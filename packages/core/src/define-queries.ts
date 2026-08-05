import { parseDuration } from './duration.js'
import { ConfigError } from './errors.js'
import type { QueryDef, ResolvedQuery } from './types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_LEASE_MARGIN_MS = 30_000

export class Queries {
  readonly all: readonly ResolvedQuery[]
  readonly #byName: Map<string, ResolvedQuery>

  constructor(all: readonly ResolvedQuery[]) {
    this.all = all
    this.#byName = new Map(all.map((q) => [q.name, q]))
  }

  get(name: string): ResolvedQuery | undefined {
    return this.#byName.get(name)
  }
}

export function defineQueries(defs: readonly QueryDef[]): Queries {
  if (!Array.isArray(defs)) throw new ConfigError('defineQueries expects an array of query defs')
  const seen = new Set<string>()
  const resolved = defs.map((def) => {
    const query = resolveQuery(def)
    if (seen.has(query.name)) throw new ConfigError(`duplicate query name '${query.name}'`)
    seen.add(query.name)
    return query
  })
  return new Queries(Object.freeze(resolved))
}

function resolveQuery(def: QueryDef): ResolvedQuery {
  if (typeof def.name !== 'string' || def.name.length === 0) {
    throw new ConfigError('query name must be a non-empty string')
  }
  const at = `query '${def.name}'`
  if (typeof def.fetch !== 'function') {
    throw new ConfigError(`${at}: fetch must be a function`)
  }
  const everyMs = parseDuration(def.every, `${at}: every`)
  const timeoutMs =
    def.timeout === undefined ? DEFAULT_TIMEOUT_MS : parseDuration(def.timeout, `${at}: timeout`)
  const leaseMs =
    def.lease === undefined
      ? timeoutMs + DEFAULT_LEASE_MARGIN_MS
      : parseDuration(def.lease, `${at}: lease`)
  if (timeoutMs >= leaseMs) {
    throw new ConfigError(
      `${at}: timeout (${timeoutMs}ms) must be shorter than lease (${leaseMs}ms), ` +
        'otherwise a live executor could outlive its lease',
    )
  }
  return Object.freeze({
    name: def.name,
    everyMs,
    timeoutMs,
    leaseMs,
    source: def.source ?? 'default',
    fetch: def.fetch,
  })
}
