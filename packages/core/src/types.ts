import type { Duration } from './duration.js'

export type QueryParams =
  | null
  | boolean
  | number
  | string
  | readonly QueryParams[]
  | { readonly [key: string]: QueryParams }

export interface FetchCtx {
  signal: AbortSignal
  now: number
  attempt: number
}

/**
 * Turns a fetched value into plain JSON for storage and back. The stored form
 * stays readable from any language; only a reader holding the query registry
 * can decode it.
 */
export interface QueryCodec<T = unknown> {
  encode(value: T): unknown
  decode(raw: unknown): T
}

export interface ValidityCtx {
  params?: QueryParams
  now: number
}

export interface ParameterizedFetchCtx<P extends QueryParams> extends FetchCtx {
  params: P
}

interface QuerySettings {
  name: string
  every: Duration
  timeout?: Duration
  lease?: Duration
  source?: string
}

export interface QueryDef<T = unknown> extends QuerySettings {
  fetch: (ctx: FetchCtx) => Promise<T>
  codec?: QueryCodec<T>
  /**
   * When the data itself expires - "today's traffic" stops being today's at
   * midnight however recently it was fetched. Returns that boundary in epoch
   * ms; the result is invalid past it, and the scheduler re-fetches at the
   * boundary instead of a full period later.
   */
  validUntil?: (ctx: ValidityCtx) => number
}

export type DimensionValues =
  readonly QueryParams[] | (() => readonly QueryParams[] | Promise<readonly QueryParams[]>)

interface ParameterizedBase<P extends QueryParams, T> extends QuerySettings {
  fetch(ctx: ParameterizedFetchCtx<P>): Promise<T>
  codec?: QueryCodec<T>
  validUntil?: (ctx: ValidityCtx) => number
}

/**
 * Arrays are static: expanded once at construction. Functions are dynamic:
 * resolved at every tick, so the list can live in a database, and they may be
 * async. `dimensions` is the cartesian product of its entries, one param field
 * per dimension.
 */
export type ParameterizedQueryDef<P extends QueryParams = QueryParams, T = unknown> =
  | (ParameterizedBase<P, T> & {
      variants: readonly P[] | (() => readonly P[] | Promise<readonly P[]>)
      dimensions?: never
    })
  | (ParameterizedBase<P, T> & {
      dimensions: Readonly<Record<string, DimensionValues>>
      variants?: never
    })

export type QueryDefinition = QueryDef | ParameterizedQueryDef

export interface ResolvedQuery<T = unknown> {
  readonly name: string
  readonly baseName: string
  readonly params?: QueryParams
  readonly everyMs: number
  readonly timeoutMs: number
  readonly leaseMs: number
  readonly source: string
  readonly fetch: (ctx: FetchCtx) => Promise<T>
  readonly codec?: QueryCodec
  readonly validUntil?: (now: number) => number
}

export interface LastError {
  at: number
  message: string
  count: number
}

export interface Envelope<T = unknown> {
  data: T
  fetchedAt: number
  freshUntil: number
  validUntil?: number
  lastError?: LastError
}

export interface ScheduleRow {
  name: string
  nextRunAt: number
  failCount: number
  leaseUntil: number | null
  version: number
}

export interface StoreCapabilities {
  atomicClaim: boolean
  listDue: boolean
}

/**
 * Schedule bookkeeping on its own. Adapter-level: the only implementors are
 * stateful serialized drivers that keep their own (a Durable Object's SQLite,
 * a long-lived process's memory). Applications pass a Store, never this.
 */
export interface SchedulePlane {
  readSchedule(name: string): Promise<ScheduleRow | null>
  writeSchedule(row: ScheduleRow): Promise<void>
  deleteSchedule(name: string): Promise<void>
  claim(name: string, expectedVersion: number, leaseUntil: number, now: number): Promise<boolean>
  listDue?(now: number, limit: number): Promise<ScheduleRow[]>
  capabilities: StoreCapabilities
}

/** Where datafridge keeps everything: result envelopes and schedule bookkeeping. */
export interface Store extends SchedulePlane {
  readResult(name: string): Promise<Envelope | null>
  writeResult(name: string, env: Envelope): Promise<void>
  deleteResult(name: string): Promise<void>
}

export interface Driver {
  serialized: boolean
  defer(promise: Promise<unknown>): void
  schedule?: SchedulePlane
}

export interface RunReport {
  ran: string[]
  skippedLeased: string[]
  deferredBudget: string[]
  failed: Array<{ name: string; message: string }>
}

export interface ReadResult<T = unknown> {
  data: T
  fetchedAt: number
  isStale: boolean
  age: number
  /** 'invalid' once the data's own window has passed; the data is still served. */
  status: 'ok' | 'invalid'
  validUntil?: number
  lastError?: LastError
}

export interface SourceBudget {
  maxPerTick: number
}
