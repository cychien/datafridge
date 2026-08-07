import type { Clock } from './clock.js'
import { withDeadline } from './deadline.js'
import { parseDuration } from './duration.js'
import type { Duration } from './duration.js'
import { ConfigError } from './errors.js'
import { queryKey, snapshotQueryParams, validateQueryName } from './query-key.js'
import type {
  EphemeralQuery,
  FetchCtx,
  ParameterizedQueryDef,
  QueryCodec,
  QueryDef,
  QueryDefinition,
  QueryParams,
  ResolveCtx,
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
  readonly resolve: (signal?: AbortSignal) => Promise<readonly QueryParams[]>
  readonly instantiate: (params: QueryParams) => ResolvedQuery
  /** The current member whose storage key matches, if any. */
  readonly member: (key: string, signal?: AbortSignal) => Promise<ResolvedQuery | undefined>
}

/**
 * A parameterized query with no list and no entries. Params the registry does
 * not name are answered by one fresh call through the dispatcher and nothing is
 * kept: no row, no lease, no envelope. Being an entry is what the registry
 * decides, never what somebody happened to ask for.
 */
export interface OpenBase {
  readonly baseName: string
  readonly timeoutMs: number
  readonly source: string
  readonly instantiate: (params: QueryParams) => EphemeralQuery
}

// Construction stays free of time: the bound belongs to whoever owns a clock.
// The stand-in signal is built per call, never once at module scope: workerd
// bans AbortController in global scope and would refuse to start any Worker
// importing this file.
function resolveCtx(signal: AbortSignal | undefined): ResolveCtx {
  return { signal: signal ?? new AbortController().signal }
}

function resolutionLabel(dynamic: DynamicVariants): string {
  return `query '${dynamic.baseName}': variant resolution`
}

/**
 * A variant list is application code reaching a database, so it gets the same
 * deadline treatment a fetch does, bounded by the base's own `timeout`. A
 * resolution that hangs then becomes the failed resolution it already is.
 */
export function resolveVariantsWithin(
  dynamic: DynamicVariants,
  clock: Clock,
): Promise<readonly QueryParams[]> {
  return withDeadline(clock, dynamic.timeoutMs, resolutionLabel(dynamic), (signal) =>
    dynamic.resolve(signal),
  )
}

/**
 * Membership takes a deadline rather than a duration because a cold read
 * spends one budget on resolving the list and then waiting for the result -
 * one query, one answer to how long it may take.
 */
export function resolveMemberBy(
  dynamic: DynamicVariants,
  key: string,
  clock: Clock,
  deadline: number,
): Promise<ResolvedQuery | undefined> {
  const remaining = Math.max(0, deadline - clock.now())
  return withDeadline(clock, remaining, resolutionLabel(dynamic), (signal) =>
    dynamic.member(key, signal),
  )
}

export class Queries {
  readonly all: readonly ResolvedQuery[]
  readonly dynamic: readonly DynamicVariants[]
  readonly open: readonly OpenBase[]
  readonly #byName: Map<string, ResolvedQuery>
  readonly #dynamicByBase: Map<string, DynamicVariants>
  readonly #openByBase: Map<string, OpenBase>

  constructor(
    all: readonly ResolvedQuery[],
    dynamic: readonly DynamicVariants[] = [],
    open: readonly OpenBase[] = [],
  ) {
    this.all = all
    this.dynamic = dynamic
    this.open = open
    this.#byName = new Map(all.map((query) => [query.name, query]))
    this.#dynamicByBase = new Map(dynamic.map((entry) => [entry.baseName, entry]))
    this.#openByBase = new Map(open.map((entry) => [entry.baseName, entry]))
  }

  openFor(baseName: string): OpenBase | undefined {
    return this.#openByBase.get(baseName)
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
  const open: OpenBase[] = []

  for (const definition of definitions) {
    validateQueryName(definition.name)
    if (baseNames.has(definition.name)) {
      throw new ConfigError(`duplicate query name '${definition.name}'`)
    }
    baseNames.add(definition.name)

    if (isParameterized(definition)) {
      if (definition.anyParams !== undefined) {
        if (definition.variants !== undefined || definition.dimensions !== undefined) {
          throw new ConfigError(
            `query '${definition.name}': anyParams names no list, so it cannot be combined ` +
              'with variants or dimensions',
          )
        }
        open.push(makeOpen(definition))
        continue
      }
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

  return new Queries(Object.freeze(resolved), Object.freeze(dynamic), Object.freeze(open))
}

type VariantSource =
  | { kind: 'static'; list: readonly QueryParams[] }
  | { kind: 'dynamic'; resolve: (signal?: AbortSignal) => Promise<readonly QueryParams[]> }

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
        resolve: async (signal) => requireArray(at, 'variants', await variants(resolveCtx(signal))),
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
    resolve: async (signal) => {
      const ctx = resolveCtx(signal)
      const resolvedEntries = await Promise.all(
        entries.map(async ([dimension, values]) => {
          const list = typeof values === 'function' ? await values(ctx) : values
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

/**
 * Fields an open base cannot mean anything by. The types already exclude them,
 * but a JS caller has no types, so presence of the property is what is checked -
 * an explicit `every: undefined` is still somebody declaring a schedule for
 * something that is never scheduled.
 */
const OPEN_BASE_FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  ['every', 'anyParams has no entries to schedule, so it cannot declare a period'],
  ['lease', 'anyParams claims no lease, so it cannot declare one'],
  ['validUntil', 'anyParams stores no result, so there is nothing for validUntil to expire'],
  ['codec', 'anyParams stores nothing, so a codec would have nothing to encode'],
]

function makeOpen(definition: ParameterizedQueryDef): OpenBase {
  const at = `query '${definition.name}'`
  if (definition.anyParams !== true) {
    throw new ConfigError(`${at}: anyParams must be true, or left out entirely`)
  }
  if (typeof definition.fetch !== 'function') {
    throw new ConfigError(`${at}: fetch must be a function`)
  }
  for (const [field, why] of OPEN_BASE_FORBIDDEN) {
    if (Object.hasOwn(definition, field)) {
      throw new ConfigError(`${at}: ${why}`)
    }
  }
  const timeoutMs =
    definition.timeout === undefined
      ? DEFAULT_TIMEOUT_MS
      : parseDuration(definition.timeout, `${at}: timeout`)
  const source = definition.source ?? 'default'
  return Object.freeze({
    baseName: definition.name,
    timeoutMs,
    source,
    instantiate: (params: QueryParams): EphemeralQuery => {
      const snapshot = snapshotQueryParams(params)
      return Object.freeze({
        name: queryKey(definition.name, snapshot),
        baseName: definition.name,
        params: snapshot,
        timeoutMs,
        source,
        fetch: (ctx: FetchCtx) => definition.fetch({ ...ctx, params: snapshot }),
      })
    },
  })
}

function makeDynamic(
  definition: ParameterizedQueryDef,
  resolve: (signal?: AbortSignal) => Promise<readonly QueryParams[]>,
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
    member: async (key: string, signal?: AbortSignal) => {
      for (const params of await resolve(signal)) {
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
  const everyMs = parseDuration(definition.every as Duration, `${at}: every`)
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
  const codec = validateCodec((definition as { codec?: unknown }).codec, at)
  if (definition.validUntil !== undefined && typeof definition.validUntil !== 'function') {
    throw new ConfigError(`${at}: validUntil must be a function returning an epoch-ms timestamp`)
  }
  return {
    everyMs,
    timeoutMs,
    leaseMs,
    source: definition.source ?? 'default',
    ...(codec ? { codec } : {}),
  }
}

function validateCodec(codec: unknown, at: string): QueryCodec | undefined {
  if (codec === undefined) return undefined
  const candidate = codec as Partial<QueryCodec>
  if (typeof candidate.encode !== 'function' || typeof candidate.decode !== 'function') {
    throw new ConfigError(`${at}: codec must provide encode and decode functions`)
  }
  return codec as QueryCodec
}

function isParameterized(definition: QueryDefinition): definition is ParameterizedQueryDef {
  return 'variants' in definition || 'dimensions' in definition || 'anyParams' in definition
}
