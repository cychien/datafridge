import type { Duration } from './duration.js'

export interface FetchCtx {
  signal: AbortSignal
  now: number
  attempt: number
}

export interface QueryDef<T = unknown> {
  name: string
  every: Duration
  timeout?: Duration
  lease?: Duration
  source?: string
  fetch: (ctx: FetchCtx) => Promise<T>
}

export interface ResolvedQuery<T = unknown> {
  readonly name: string
  readonly everyMs: number
  readonly timeoutMs: number
  readonly leaseMs: number
  readonly source: string
  readonly fetch: (ctx: FetchCtx) => Promise<T>
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
  lastError?: LastError
}

export interface ScheduleRow {
  name: string
  nextRunAt: number
  failCount: number
  leaseUntil: number | null
  version: number
}

export interface ResultStore {
  readResult(name: string): Promise<Envelope | null>
  writeResult(name: string, env: Envelope): Promise<void>
  deleteResult(name: string): Promise<void>
}

export interface ScheduleStoreCapabilities {
  atomicClaim: boolean
  listDue: boolean
}

export interface ScheduleStore {
  readSchedule(name: string): Promise<ScheduleRow | null>
  writeSchedule(row: ScheduleRow): Promise<void>
  deleteSchedule(name: string): Promise<void>
  claim(name: string, expectedVersion: number, leaseUntil: number, now: number): Promise<boolean>
  listDue?(now: number, limit: number): Promise<ScheduleRow[]>
  capabilities: ScheduleStoreCapabilities
}

export type Store = ResultStore & ScheduleStore

export interface Driver {
  serialized: boolean
  defer(promise: Promise<unknown>): void
  schedule?: ScheduleStore
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
  lastError?: LastError
}

export interface SourceBudget {
  maxPerTick: number
}
