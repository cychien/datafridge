import { parseDuration } from './duration.js'
import { ConfigError } from './errors.js'
import { queryKey, snapshotQueryParams, validateQueryName } from './query-key.js'
import type {
  FetchCtx,
  ParameterizedQueryDef,
  QueryDef,
  QueryDefinition,
  QueryParams,
  ResolvedQuery,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_LEASE_MARGIN_MS = 30_000

export class Queries {
  readonly all: readonly ResolvedQuery[]
  readonly #byName: Map<string, ResolvedQuery>

  constructor(all: readonly ResolvedQuery[]) {
    this.all = all
    this.#byName = new Map(all.map((query) => [query.name, query]))
  }

  get(name: string, params?: QueryParams): ResolvedQuery | undefined {
    return this.#byName.get(queryKey(name, params))
  }

  getByKey(key: string): ResolvedQuery | undefined {
    return this.#byName.get(key)
  }
}

export function defineParameterizedQuery<P extends QueryParams, T>(
  definition: ParameterizedQueryDef<P, T>,
): ParameterizedQueryDef<P, T> {
  return definition
}

export function defineQueries(definitions: readonly QueryDef[]): Queries
export function defineQueries(definitions: readonly QueryDefinition[]): Queries
export function defineQueries(definitions: readonly QueryDefinition[]): Queries {
  if (!Array.isArray(definitions)) {
    throw new ConfigError('defineQueries expects an array of query defs')
  }

  const baseNames = new Set<string>()
  const keys = new Set<string>()
  const resolved: ResolvedQuery[] = []

  for (const definition of definitions) {
    validateQueryName(definition.name)
    if (baseNames.has(definition.name)) {
      throw new ConfigError(`duplicate query name '${definition.name}'`)
    }
    baseNames.add(definition.name)

    if (isParameterized(definition)) {
      const variants =
        typeof definition.variants === 'function' ? definition.variants() : definition.variants
      if (!Array.isArray(variants)) {
        throw new ConfigError(`query '${definition.name}': variants must return an array`)
      }
      for (const params of variants) {
        const query = resolveParameterizedQuery(definition, params)
        if (keys.has(query.name)) {
          throw new ConfigError(`query '${definition.name}': duplicate variant params`)
        }
        keys.add(query.name)
        resolved.push(query)
      }
      continue
    }

    const query = resolveFixedQuery(definition)
    if (keys.has(query.name)) throw new ConfigError(`duplicate query name '${query.name}'`)
    keys.add(query.name)
    resolved.push(query)
  }

  return new Queries(Object.freeze(resolved))
}

function resolveFixedQuery(definition: QueryDef): ResolvedQuery {
  const settings = resolveSettings(definition)
  return Object.freeze({
    ...settings,
    name: definition.name,
    baseName: definition.name,
    fetch: definition.fetch,
  })
}

function resolveParameterizedQuery(
  definition: ParameterizedQueryDef,
  params: QueryParams,
): ResolvedQuery {
  const settings = resolveSettings(definition)
  const snapshot = snapshotQueryParams(params)
  const name = queryKey(definition.name, snapshot)
  const fetch = (ctx: FetchCtx) => definition.fetch({ ...ctx, params: snapshot })
  return Object.freeze({
    ...settings,
    name,
    baseName: definition.name,
    params: snapshot,
    fetch,
  })
}

function resolveSettings(definition: QueryDefinition) {
  const at = `query '${definition.name}'`
  if (typeof definition.fetch !== 'function') {
    throw new ConfigError(`${at}: fetch must be a function`)
  }
  const everyMs = parseDuration(definition.every, `${at}: every`)
  const timeoutMs =
    definition.timeout === undefined
      ? DEFAULT_TIMEOUT_MS
      : parseDuration(definition.timeout, `${at}: timeout`)
  const leaseMs =
    definition.lease === undefined
      ? timeoutMs + DEFAULT_LEASE_MARGIN_MS
      : parseDuration(definition.lease, `${at}: lease`)
  if (timeoutMs >= leaseMs) {
    throw new ConfigError(
      `${at}: timeout (${timeoutMs}ms) must be shorter than lease (${leaseMs}ms), ` +
        'otherwise a live executor could outlive its lease',
    )
  }
  return {
    everyMs,
    timeoutMs,
    leaseMs,
    source: definition.source ?? 'default',
  }
}

function isParameterized(
  definition: QueryDefinition,
): definition is ParameterizedQueryDef<QueryParams> {
  return 'variants' in definition
}
