import { parseDuration } from './duration.js'
import { ConfigError } from './errors.js'
import { queryKey, snapshotQueryParams, validateQueryName } from './query-key.js'
import type {
  FetchCtx,
  ParameterizedQueryDef,
  QueryCodec,
  QueryDef,
  QueryDefinition,
  QueryParams,
  ResolvedQuery,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_LEASE_MARGIN_MS = 30_000

/**
 * A parameterized query whose variant list is a function: the list lives
 * somewhere that can change - a database, a config service - so it is resolved
 * at every tick instead of once at construction, and it may be async. Static
 * arrays never take this path.
 */
export interface DynamicVariants {
  readonly baseName: string
  readonly everyMs: number
  readonly timeoutMs: number
  readonly codec?: QueryCodec
  /** Resolve the current variant list. Called once per tick, and on a cold read. */
  readonly resolve: () => Promise<readonly QueryParams[]>
  readonly instantiate: (params: QueryParams) => ResolvedQuery
  /** The current member whose storage key matches, if any. */
  readonly member: (key: string) => Promise<ResolvedQuery | undefined>
}

export class Queries {
  readonly all: readonly ResolvedQuery[]
  readonly dynamic: readonly DynamicVariants[]
  readonly #byName: Map<string, ResolvedQuery>
  readonly #dynamicByBase: Map<string, DynamicVariants>

  constructor(all: readonly ResolvedQuery[], dynamic: readonly DynamicVariants[] = []) {
    this.all = all
    this.dynamic = dynamic
    this.#byName = new Map(all.map((query) => [query.name, query]))
    this.#dynamicByBase = new Map(dynamic.map((entry) => [entry.baseName, entry]))
  }

  get(name: string, params?: QueryParams): ResolvedQuery | undefined {
    return this.#byName.get(queryKey(name, params))
  }

  getByKey(key: string): ResolvedQuery | undefined {
    return this.#byName.get(key)
  }

  dynamicFor(baseName: string): DynamicVariants | undefined {
    return this.#dynamicByBase.get(baseName)
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
  const dynamic: DynamicVariants[] = []

  for (const definition of definitions) {
    validateQueryName(definition.name)
    if (baseNames.has(definition.name)) {
      throw new ConfigError(`duplicate query name '${definition.name}'`)
    }
    baseNames.add(definition.name)

    if (isParameterized(definition)) {
      const source = variantSource(definition)
      if (source.kind === 'dynamic') {
        dynamic.push(makeDynamic(definition, source.resolve))
        continue
      }
      for (const params of source.list) {
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

  return new Queries(Object.freeze(resolved), Object.freeze(dynamic))
}

type VariantSource =
  | { kind: 'static'; list: readonly QueryParams[] }
  | { kind: 'dynamic'; resolve: () => Promise<readonly QueryParams[]> }

function variantSource(definition: ParameterizedQueryDef): VariantSource {
  const at = `query '${definition.name}'`
  const { variants, dimensions } = definition
  if (variants !== undefined && dimensions !== undefined) {
    throw new ConfigError(`${at}: pass either variants or dimensions, not both`)
  }

  if (variants !== undefined) {
    if (typeof variants === 'function') {
      return {
        kind: 'dynamic',
        resolve: async () => requireArray(at, 'variants', await variants()),
      }
    }
    return { kind: 'static', list: requireArray(at, 'variants', variants) }
  }

  if (dimensions === undefined || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
    throw new ConfigError(`${at}: dimensions must be an object of arrays or functions`)
  }
  const entries = Object.entries(dimensions)
  if (entries.length === 0) {
    throw new ConfigError(`${at}: dimensions must declare at least one dimension`)
  }
  for (const [dimension, values] of entries) {
    if (typeof values !== 'function' && !Array.isArray(values)) {
      throw new ConfigError(
        `${at}: dimension '${dimension}' must be an array or a function returning one`,
      )
    }
  }

  if (entries.every(([, values]) => Array.isArray(values))) {
    const staticEntries = entries.map(
      ([dimension, values]) => [dimension, values as readonly QueryParams[]] as const,
    )
    return { kind: 'static', list: cartesian(staticEntries) }
  }

  return {
    kind: 'dynamic',
    resolve: async () => {
      const resolvedEntries = await Promise.all(
        entries.map(async ([dimension, values]) => {
          const list = typeof values === 'function' ? await values() : values
          return [dimension, requireArray(at, `dimension '${dimension}'`, list)] as const
        }),
      )
      return cartesian(resolvedEntries)
    },
  }
}

function requireArray(at: string, what: string, value: unknown): readonly QueryParams[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${at}: ${what} must resolve to an array`)
  }
  return value as readonly QueryParams[]
}

function cartesian(
  entries: ReadonlyArray<readonly [string, readonly QueryParams[]]>,
): QueryParams[] {
  let combos: Array<Record<string, QueryParams>> = [{}]
  for (const [dimension, values] of entries) {
    const next: Array<Record<string, QueryParams>> = []
    for (const combo of combos) {
      for (const value of values) next.push({ ...combo, [dimension]: value })
    }
    combos = next
  }
  return combos
}

function makeDynamic(
  definition: ParameterizedQueryDef,
  resolve: () => Promise<readonly QueryParams[]>,
): DynamicVariants {
  const settings = resolveSettings(definition)
  const instantiate = (params: QueryParams) => resolveParameterizedQuery(definition, params)
  return Object.freeze({
    baseName: definition.name,
    everyMs: settings.everyMs,
    timeoutMs: settings.timeoutMs,
    ...(settings.codec ? { codec: settings.codec } : {}),
    resolve,
    instantiate,
    member: async (key: string) => {
      for (const params of await resolve()) {
        const query = instantiate(params)
        if (query.name === key) return query
      }
      return undefined
    },
  })
}

function resolveFixedQuery(definition: QueryDef): ResolvedQuery {
  const settings = resolveSettings(definition)
  const { validUntil } = definition
  return Object.freeze({
    ...settings,
    name: definition.name,
    baseName: definition.name,
    fetch: definition.fetch,
    ...(validUntil ? { validUntil: (now: number) => validUntil({ now }) } : {}),
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
  const { validUntil } = definition
  return Object.freeze({
    ...settings,
    name,
    baseName: definition.name,
    params: snapshot,
    fetch,
    ...(validUntil ? { validUntil: (now: number) => validUntil({ params: snapshot, now }) } : {}),
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
  const codec = definition.codec
  if (
    codec !== undefined &&
    (typeof codec.encode !== 'function' || typeof codec.decode !== 'function')
  ) {
    throw new ConfigError(`${at}: codec must provide encode and decode functions`)
  }
  if (definition.validUntil !== undefined && typeof definition.validUntil !== 'function') {
    throw new ConfigError(`${at}: validUntil must be a function returning an epoch-ms timestamp`)
  }
  return {
    everyMs,
    timeoutMs,
    leaseMs,
    source: definition.source ?? 'default',
    ...(codec ? { codec: codec as QueryCodec } : {}),
  }
}

function isParameterized(definition: QueryDefinition): definition is ParameterizedQueryDef {
  return 'variants' in definition || 'dimensions' in definition
}
