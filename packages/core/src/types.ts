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

/**
 * Handed to a function-valued variant list. The signal aborts once the base's
 * `timeout` is reached, so a list that lives behind a hung connection can be
 * cancelled instead of holding it open.
 */
export interface ResolveCtx {
  signal: AbortSignal
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
  | readonly QueryParams[]
  | ((ctx: ResolveCtx) => readonly QueryParams[] | Promise<readonly QueryParams[]>)

interface ParameterizedBase<P extends QueryParams, T> extends QuerySettings {
  fetch(ctx: ParameterizedFetchCtx<P>): Promise<T>
  codec?: QueryCodec<T>
  validUntil?: (ctx: ValidityCtx) => number
}

/**
 * A base whose parameter space is not a list. It declares no `every`, `lease`
 * or `validUntil` because it has no entries to schedule, refresh or expire:
 * every read is answered by one fresh call.
 */
interface OpenParameterizedBase<P extends QueryParams, T> {
  name: string
  timeout?: Duration
  source?: string
  fetch(ctx: ParameterizedFetchCtx<P>): Promise<T>
}

/**
 * Arrays are static: expanded once at construction. Functions are dynamic:
 * resolved at every tick, so the list can live in a database, and they may be
 * async. `dimensions` is the cartesian product of its entries, one param field
 * per dimension.
 */
export type ParameterizedQueryDef<P extends QueryParams = QueryParams, T = unknown> =
  | (ParameterizedBase<P, T> & {
      variants: readonly P[] | ((ctx: ResolveCtx) => readonly P[] | Promise<readonly P[]>)
      dimensions?: never
      anyParams?: never
    })
  | (ParameterizedBase<P, T> & {
      dimensions: Readonly<Record<string, DimensionValues>>
      variants?: never
      anyParams?: never
    })
  | (OpenParameterizedBase<P, T> & {
      /**
       * No list, and no entries either. Any params are accepted, and each read
       * of params the registry does not name is answered by one fresh upstream
       * call - metered, bounded and never stored. For parameter spaces too
       * large or too open-ended to enumerate, where storing every combination
       * somebody happens to ask for would be a cache nobody asked for.
       */
      anyParams: true
      variants?: never
      dimensions?: never
      every?: never
      lease?: never
      validUntil?: never
      codec?: never
    })

export type QueryDefinition = QueryDef | ParameterizedQueryDef

/** A scheduled entry: it has a period, a row, a lease, and a stored result. */
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

/**
 * A call for params no entry exists for. It goes out through the same
 * dispatcher, so it obeys the same source ceiling, reserve, concurrency and
 * timeout - but it claims no lease and writes nothing back, because there is no
 * entry for it to be the current value of.
 */
export interface EphemeralQuery<T = unknown> {
  readonly name: string
  readonly baseName: string
  readonly params: QueryParams
  readonly timeoutMs: number
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
  validUntil?: number
  lastError?: LastError
}

export interface ScheduleRow {
  name: string
  nextRunAt: number
  failCount: number
  leaseUntil: number | null
  version: number
  /**
   * The variant's params, for rows the registry does not name. A key is a hash,
   * so an on-demand entry that nothing declared cannot be rebuilt from its name
   * alone; carrying the params makes the row enough to run the work by itself.
   */
  params?: QueryParams
}

export interface StoreCapabilities {
  atomicClaim: boolean
  listDue: boolean
}

/**
 * Whether a concurrency permit was granted. A refusal carries the earliest
 * moment the answer could change - the soonest live permit for that source
 * expires, or `now` when the source has room and only this holder id was in the
 * way - so a caller can wait for something rather than poll for nothing.
 */
export type PermitGrant = { granted: true } | { granted: false; retryAt: number }

/** What one upstream call for params no entry exists for came back with. */
export type FlightOutcome =
  | { status: 'ran'; data: unknown }
  | { status: 'throttled'; retryAt: number }
  | { status: 'failed'; message: string }

/**
 * A place in a flight. The leader makes the call; followers joined while it was
 * still running and take its answer. `generation` scopes the handoff: an answer
 * is only ever handed to the cohort that was waiting on that exact flight.
 */
export interface FlightTicket {
  role: 'leader' | 'follower'
  generation: number
}

/**
 * What a waiter needs to know: whether its own flight is still running, and
 * whether the answer it is entitled to has landed.
 */
export interface FlightState {
  /** The generation currently running, or `null` when nothing is. */
  running: number | null
  /** The last answer still inside its handoff window. */
  settled: { generation: number; outcome: FlightOutcome } | null
}

/**
 * Dispatcher coordination on its own: schedule rows, leases, the quota ledger,
 * concurrency permits and transient flights. Adapter-level - applications pass
 * a Store, never this - and it is the one place every executor sharing a
 * backend meets, which is why all of it lives here rather than in whichever
 * process happens to be running.
 */
export interface SchedulePlane {
  readSchedule(name: string): Promise<ScheduleRow | null>
  writeSchedule(row: ScheduleRow): Promise<void>
  deleteSchedule(name: string): Promise<void>
  claim(name: string, expectedVersion: number, leaseUntil: number, now: number): Promise<boolean>
  /**
   * Counts one upstream call against `source` and answers whether it fit under
   * `limit`. Windows are fixed and aligned to the epoch: the one containing
   * `now` starts at `floor(now / windowMs) * windowMs` and opens with a usage of
   * zero. `limit` is passed per call rather than stored, because callers hold
   * back part of a window from lower-priority work; the ledger keeps usage only.
   */
  takeQuota(source: string, limit: number, windowMs: number, now: number): Promise<boolean>
  /**
   * Hands back a slot `takeQuota` granted for a call that never happened, so a
   * ceiling stays exact accounting rather than a count of intentions. `takenAt`
   * is the `now` that take was made with, and the credit applies only while the
   * ledger is still on that call's window: a window that has since rolled keeps
   * its own count, because usage cannot be moved between windows. Never drives
   * usage below zero.
   */
  releaseQuota(source: string, windowMs: number, takenAt: number): Promise<void>
  /**
   * Takes one of `limit` concurrency permits for `source`, across every
   * executor sharing this store. `holder` identifies this call so it can give
   * the permit back; `expiresAt` is when the permit stops counting even if it
   * never is, which is how a holder that died stops blocking everyone else.
   * It never waits.
   *
   * A `holder` already holding a live permit is refused rather than allowed to
   * take a second or to overwrite the first: one id is one call's claim on one
   * permit, and two callers arriving with the same id are still two callers.
   * That refusal reports `retryAt: now`, because the source itself has room.
   */
  acquirePermit(
    source: string,
    limit: number,
    holder: string,
    expiresAt: number,
    now: number,
  ): Promise<PermitGrant>
  /** Gives a permit back the moment the call it was taken for is done. */
  releasePermit(source: string, holder: string): Promise<void>
  /**
   * Joins the flight for `key`, creating one when nothing is running. A caller
   * that finds a live flight becomes a follower of it and takes its answer
   * rather than making a second call; a caller that arrives once the last
   * flight has settled starts a new generation, because a settled answer
   * belongs to the cohort that waited for it and to nobody who came later.
   * `expiresAt` is the leader's own deadline: past it the flight is dead and
   * the next caller takes it over.
   */
  joinFlight(key: string, expiresAt: number, now: number): Promise<FlightTicket>
  /** Where a follower's answer arrives. */
  readFlight(key: string, now: number): Promise<FlightState | null>
  /**
   * The leader's answer, handed to whoever is waiting on this generation and
   * kept readable until `keepUntil`. Answers false when the generation has
   * moved on, which is how a write from a flight everyone stopped waiting for
   * is rejected rather than handed to the wrong cohort.
   */
  settleFlight(
    key: string,
    generation: number,
    outcome: FlightOutcome,
    keepUntil: number,
  ): Promise<boolean>
  /**
   * Drops flights nothing can still be waiting on: settled ones past their
   * handoff window, and running ones past their expiry. Bounded by `limit`.
   * Callers pass a `before` already behind `now` by more than a leader can
   * outlive its own deadline, because deleting a running flight is what would
   * let the next generation restart at one and match a late settle.
   */
  sweepFlights(before: number, limit: number): Promise<number>
  /**
   * The rows for these names, in the order asked, `null` where there is none.
   * Optional: without it core reads them one at a time, which is fine for a
   * registry smaller than a page and needless once it is larger. `names` is
   * always a bounded batch.
   */
  readSchedules?(names: readonly string[]): Promise<Array<ScheduleRow | null>>
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
  /**
   * How long this invocation may run, when the platform bounds it. A tick stops
   * admitting work whose own `timeout` no longer fits in what is left, so the
   * remainder is deferred to the next tick instead of being killed mid-flight.
   */
  budgetMs?: number
}

export interface RunReport {
  ran: string[]
  skippedLeased: string[]
  /** Out of source quota this window; still due, and more overdue next tick. */
  throttled: string[]
  /**
   * Due, but past what this invocation could take on: its remaining wall clock
   * would not fit the query's own timeout, or the source was already at its
   * concurrency ceiling. Nothing upstream was asked and nothing was written, so
   * these come back at the head of the next tick. Capacity, not rate:
   * `throttled` is the source's window, this is everything else.
   */
  deferred: string[]
  failed: Array<{ name: string; message: string }>
  /**
   * When this fridge next has work, as the tick that just ran already knows it -
   * so a driver that schedules its own wake-ups does not have to ask storage
   * again. `null` means there is nothing scheduled at all.
   */
  nextRunAt: number | null
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

/**
 * Nothing is stored and the source has no quota left to fetch it with. It is
 * not the same answer as `null`: nothing is wrong and nothing is missing, the
 * call is only waiting its turn, and `retryAt` says when the window rolls.
 */
export interface ThrottledRead {
  status: 'throttled'
  retryAt: number
}

export interface SourceLimit {
  requests: number
  per: Duration
  /**
   * Held back from scheduled refreshes. Without it a tick landing on the window
   * boundary can spend the whole window's quota in its first second, and a
   * reader arriving mid-window - with an actual person behind it - finds
   * nothing left. Defaults to 0.
   */
  reserve?: number
}

export interface SourcePolicy {
  /** The hard ceiling, counted in the store's ledger and shared by every executor. */
  limit?: SourceLimit
  /** Instantaneous smoothing inside one instance. Does not bound total volume. */
  maxConcurrent?: number
}
