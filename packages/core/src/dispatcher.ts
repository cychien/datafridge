import { backoffMs, firstRunJitterMs, retryAfterMs } from './backoff.js'
import type { Clock } from './clock.js'
import { withDeadline } from './deadline.js'
import { RateLimitError, ConfigError } from './errors.js'
import { windowStartOf } from './sources.js'
import type { ResolvedSource, ResolvedSources } from './sources.js'
import type {
  EphemeralQuery,
  Envelope,
  FlightOutcome,
  ResolvedQuery,
  SchedulePlane,
  ScheduleRow,
  Store,
} from './types.js'

// How long a settled flight's answer stays readable by the cohort that waited
// for it, how often a waiter looks, and how far apart those looks may drift.
const FLIGHT_HANDOFF_MS = 10_000
const FLIGHT_POLL_MS = 25
const MAX_FLIGHT_POLL_MS = 500
// A permit outlives the call it was taken for by this much, so a holder that
// died stops counting shortly after rather than never.
const PERMIT_GRACE_MS = 30_000
const PERMIT_POLL_MS = 25
const MAX_PERMIT_POLL_MS = 500
// A refusal that says the source has room was this holder id colliding with a
// peer's. Mint another and take the slot; the bound is only there so a store
// that always refuses cannot spin.
const PERMIT_ID_ATTEMPTS = 8

export type FetchTask = {
  query: ResolvedQuery
  /** The schedule row as the caller observed it; its version is the CAS expectation. */
  row: ScheduleRow
} & (
  | { priority: 'scheduled' }
  /** A reader is waiting, and stops waiting at `deadline`. */
  | { priority: 'demand'; deadline: number }
)

export type DispatchOutcome =
  /** `nextRunAt` is the row this dispatch just wrote, so nobody has to re-read it. */
  | { status: 'ran'; nextRunAt: number }
  | { status: 'leased' }
  | { status: 'throttled'; retryAt: number }
  /**
   * The source is at its concurrency ceiling; nothing was claimed or called.
   * `retryAt` is the soonest a permit can free - a peer's expiry - so nobody
   * has to poll for a thing that cannot change before then.
   */
  | { status: 'deferred'; retryAt: number }
  | { status: 'failed'; message: string; nextRunAt?: number }

/** A call with no entry behind it: it either brings data back, or it does not. */
export type EphemeralOutcome = FlightOutcome

export interface DispatcherConfig {
  store: Store
  schedule: SchedulePlane
  clock: Clock
  random: () => number
  sources: ResolvedSources
}

/**
 * The single exit to upstream. Scheduled refreshes, read-miss fetches and calls
 * for params no entry exists for are the same work arriving through different
 * doors, so rate limiting, coalescing, write-back and backoff live here once and
 * nowhere else - there is no second path that could skip one of them.
 */
export interface Dispatcher {
  /**
   * Times itself off the injected clock rather than from a `now` the caller
   * took: admission can wait out a quota window or queue for a permit, and a
   * lease, a permit or a fetcher's `now` measured from before that wait would
   * already be part-spent when the call finally starts.
   */
  run(task: FetchTask): Promise<DispatchOutcome>
  /**
   * A call for params the registry does not name. It draws on the same source
   * window a reader's miss does, takes the same concurrency permit and is
   * bounded by the same timeout, but it claims no lease and stores nothing:
   * there is no entry for it to be the current value of.
   *
   * Reads that overlap coalesce anyway. The first joins a flight and makes the
   * call; everyone who arrives while it is running takes its answer, so the
   * cohort costs one call and one quota slot however many readers it holds.
   * A read arriving after that flight settles is a new flight and a new call -
   * an answer belongs to the people who waited for it, not to whoever asks next.
   */
  runEphemeral(query: EphemeralQuery, deadline: number): Promise<EphemeralOutcome>
}

/** Runs a wait with this call's concurrency slot handed back for the duration. */
type Unslotted = <T>(wait: () => Promise<T>) => Promise<T>

/** Instantaneous smoothing inside this instance; it bounds concurrency, not volume. */
function makeSemaphores(sources: ResolvedSources) {
  const inFlight = new Map<string, number>()
  const waiting = new Map<string, Array<() => void>>()

  return {
    async acquire(source: string): Promise<void> {
      const max = sources.get(source)?.maxConcurrent ?? Infinity
      if (max === Infinity) return
      const running = inFlight.get(source) ?? 0
      if (running < max) {
        inFlight.set(source, running + 1)
        return
      }
      await new Promise<void>((resolve) => {
        const queue = waiting.get(source) ?? []
        queue.push(resolve)
        waiting.set(source, queue)
      })
    },

    release(source: string): void {
      const max = sources.get(source)?.maxConcurrent ?? Infinity
      if (max === Infinity) return
      const next = waiting.get(source)?.shift()
      // The slot is handed straight over rather than counted down and up again,
      // so a released slot cannot be taken by a newcomer ahead of the queue.
      if (next) next()
      else inFlight.set(source, Math.max(0, (inFlight.get(source) ?? 1) - 1))
    },
  }
}

export function createDispatcher(config: DispatcherConfig): Dispatcher {
  const { store, schedule, clock, random, sources } = config
  const semaphores = makeSemaphores(sources)
  let holderSeq = 0
  // Entropy where there is any, and a per-call counter where there is not:
  // `random` is injectable and pinned in tests, so uniqueness is never assumed.
  // The store refuses a duplicate holder outright, which is what makes a
  // collision cost one retry rather than a breached ceiling.
  const nextHolder = (): string =>
    [
      Math.floor(random() * 0x1_0000_0000).toString(36),
      clock.now().toString(36),
      (holderSeq += 1).toString(36),
    ].join('-')

  const isOwner = async (name: string, token: number): Promise<boolean> => {
    const current = await schedule.readSchedule(name)
    return current !== null && current.version === token
  }

  const sleepUntil = (at: number): Promise<void> =>
    new Promise((resolve) => {
      clock.setTimeout(() => resolve(), Math.max(0, at - clock.now()))
    })

  const sleepFor = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      clock.setTimeout(() => resolve(), Math.max(0, ms))
    })

  /**
   * The longest a coordination call has taken this dispatch, measured off the
   * injected clock rather than configured. Admission consults it so it never
   * starts a round trip whose answer would land after the reader has stopped
   * listening: a read whose deadline passes mid-acquire hears "there is
   * nothing", which is the one answer work that never reached upstream must
   * never give.
   */
  const measureRoundTrips = () => {
    let worst = 0
    return {
      async observe<T>(call: () => Promise<T>): Promise<T> {
        const startedAt = clock.now()
        try {
          return await call()
        } finally {
          worst = Math.max(worst, clock.now() - startedAt)
        }
      },
      /** Whether `count` more of them can start and still be heard by `deadline`. */
      fits(deadline: number | undefined, count: number): boolean {
        return deadline === undefined || deadline - clock.now() > worst * count
      },
    }
  }

  type RoundTrips = ReturnType<typeof measureRoundTrips>

  /**
   * Scheduled work takes what is left after the window's reserve and never
   * waits: refusing it leaves the row due, and the next tick brings it back
   * with a higher overdue ratio, so nothing starves. A demand fetch has someone
   * waiting, so it may take the reserve too and may wait for the window to roll
   * - but only for as long as that reader is still there.
   */
  const takeQuota = async (
    policy: ResolvedSource,
    source: string,
    limit: number,
    /** A reader's cut-off, or undefined for work nobody is waiting on. */
    deadline: number | undefined,
    unslotted: Unslotted,
    trips: RoundTrips,
  ): Promise<{ ok: true; takenAt: number } | { ok: false; retryAt: number }> => {
    const { windowMs } = policy
    for (;;) {
      const now = clock.now()
      const taken = await trips.observe(() => schedule.takeQuota(source, limit, windowMs, now))
      if (taken) return { ok: true, takenAt: now }
      const retryAt = windowStartOf(now, windowMs) + windowMs
      if (deadline === undefined || retryAt >= deadline) return { ok: false, retryAt }
      // Waiting out a window is not a call in flight, so the concurrency slot
      // goes back for the duration: `maxConcurrent` bounds what upstream is
      // actually carrying, never what is queued behind a ceiling.
      await unslotted(() => sleepUntil(retryAt))
    }
  }

  /**
   * A slot taken for a call that never happened. Refusing to credit a window
   * that has already rolled leaves this one over-counting by one, which is the
   * safe direction for a ceiling, so a refund that cannot land is not an error.
   */
  const giveQuotaBack = async (
    source: string,
    windowMs: number,
    takenAt: number,
  ): Promise<void> => {
    try {
      await schedule.releaseQuota(source, windowMs, takenAt)
    } catch {
      // Over-counting one call is the safe direction, and the window rolls.
    }
  }

  /**
   * `maxConcurrent` across every executor sharing this store, not just this
   * one. The local semaphore above still runs first, so same-instance work
   * hands slots straight over instead of polling; this is what stops two
   * Workers from being two ceilings. A permit expires on its own, so a holder
   * that died stops blocking its peers without anyone having to notice.
   */
  const takePermit = async (
    source: string,
    /**
     * When the permit stops counting, from the moment it is actually taken -
     * queueing for one can outlast the wait that led here, so a lifetime
     * measured from before the queue would be part-spent on arrival.
     */
    expiresAt: (takenAt: number) => number,
    deadline: number | undefined,
    trips: RoundTrips,
    /** Round trips the caller still owes on the way out of a refusal. */
    tailTrips: number,
  ): Promise<{ ok: true; release: () => Promise<void> } | { ok: false; retryAt: number }> => {
    const max = sources.get(source)?.maxConcurrent
    if (max === undefined || !Number.isFinite(max)) {
      return { ok: true, release: async () => undefined }
    }
    let interval = PERMIT_POLL_MS
    let collisions = 0
    let attempts = 0
    let retryingId = false
    let refusedUntil: number | null = null
    let holder = nextHolder()
    for (;;) {
      const now = clock.now()
      // Asking costs a round trip, and so does the refund a refusal owes on the
      // way out. Once the reader's budget cannot carry both, asking again would
      // only turn "not your turn, come back at X" into silence, so the refusal
      // already in hand is the answer.
      if (!trips.fits(deadline, 1 + tailTrips)) {
        return { ok: false, retryAt: refusedUntil ?? now }
      }
      // Scheduled work never queues for a permit: staying due and coming back
      // more overdue is cheaper than holding an invocation open for a peer.
      const wait = deadline === undefined ? 0 : Math.min(interval, deadline - now)
      // Giving up at the deadline is giving up too late: the reader stops
      // listening at that same instant, and would hear nothing rather than why.
      const lastAttempt = wait <= 0 || now + wait >= (deadline as number)
      // A refusal is worth a reason only where one gets acted on: an attempt
      // that is telling a colliding id apart from a full source, and the
      // attempt whose answer the caller reports. The polls in between mint a
      // fresh id and look again regardless, so asking a saturated source why -
      // over and over, per waiting reader - would be paying for an answer
      // nobody reads.
      const explainRefusal = attempts === 0 || retryingId || lastAttempt
      retryingId = false
      const grant = await trips.observe(() =>
        schedule.acquirePermit(source, max, holder, expiresAt(now), now, explainRefusal),
      )
      attempts += 1
      if (grant.granted) {
        const taken = holder
        return {
          ok: true,
          release: async () => {
            try {
              await schedule.releasePermit(source, taken)
            } catch {
              // The permit expires on its own; a failed release costs a little
              // headroom until then, never correctness.
            }
          },
        }
      }
      if (grant.retryAt !== null) refusedUntil = grant.retryAt
      // The source has room, so the id was what stood in the way.
      if (grant.retryAt !== null && grant.retryAt <= now && collisions < PERMIT_ID_ATTEMPTS) {
        collisions += 1
        retryingId = true
        holder = nextHolder()
        continue
      }
      if (lastAttempt) return { ok: false, retryAt: refusedUntil ?? now }
      await sleepFor(wait)
      interval = Math.min(interval * 2, MAX_PERMIT_POLL_MS)
      holder = nextHolder()
    }
  }

  const succeed = async (
    query: ResolvedQuery,
    token: number,
    data: unknown,
    done: number,
  ): Promise<DispatchOutcome> => {
    const { name } = query
    if (!(await isOwner(name, token))) {
      return { status: 'failed', message: 'write discarded (lease reclaimed)' }
    }
    const stored = query.codec ? query.codec.encode(data) : data
    const validUntil = query.validUntil?.(done)
    if (validUntil !== undefined && !Number.isFinite(validUntil)) {
      throw new ConfigError(`query '${name}': validUntil must return a finite epoch-ms timestamp`)
    }
    const envelope: Envelope = {
      data: stored,
      fetchedAt: done,
      freshUntil: done + query.everyMs,
      ...(validUntil !== undefined ? { validUntil } : {}),
    }
    await store.writeResult(name, envelope)
    const jitter = token === 1 ? firstRunJitterMs(query.everyMs, random) : 0
    // everyMs is a positive duration, so periodic is always past `done`: no
    // branch below can schedule a run that is due the moment it is written.
    const periodic = done + query.everyMs + jitter
    // Data with its own expiry re-fetches at the boundary, not a period later.
    // A boundary already behind us describes a window that has closed -
    // legitimate for a variant naming a past date - so it schedules nothing and
    // the ordinary period governs.
    const nextRunAt =
      validUntil !== undefined && validUntil > done ? Math.min(periodic, validUntil) : periodic
    await schedule.writeSchedule({
      name,
      nextRunAt,
      failCount: 0,
      leaseUntil: null,
      version: token,
      ...(query.params !== undefined ? { params: query.params } : {}),
    })
    return { status: 'ran', nextRunAt }
  }

  const fail = async (
    query: ResolvedQuery,
    row: ScheduleRow,
    token: number,
    err: unknown,
  ): Promise<DispatchOutcome> => {
    const { name } = query
    const done = clock.now()
    let message = errorMessage(err)
    let nextRunAt: number | undefined
    try {
      if (await isOwner(name, token)) {
        const failCount = row.failCount + 1
        const old = await store.readResult(name)
        if (old) {
          await store.writeResult(name, {
            ...old,
            lastError: { at: done, message, count: failCount },
          })
        }
        nextRunAt = done + retryDelayMs(err, failCount, query.everyMs, random)
        await schedule.writeSchedule({
          name,
          nextRunAt,
          failCount,
          leaseUntil: null,
          version: token,
          ...(query.params !== undefined ? { params: query.params } : {}),
        })
      } else {
        message = `write discarded (lease reclaimed): ${message}`
      }
    } catch {
      // Store write failed mid-run; the lease expires and a later tick re-claims.
      nextRunAt = undefined
    }
    return { status: 'failed', message, ...(nextRunAt !== undefined ? { nextRunAt } : {}) }
  }

  const dispatch = async (task: FetchTask, unslotted: Unslotted): Promise<DispatchOutcome> => {
    const { query, row } = task
    const { name, source } = query
    const policy = sources.get(source)
    // Quota is taken after the concurrency slot so a queued call is not holding
    // one, and before the claim so a call that has no quota never takes a lease
    // it would have to hand straight back.
    const metered = policy !== undefined && policy.windowMs !== Infinity
    const trips = measureRoundTrips()
    let charged: number | null = null
    // Coordination that throws is contained here rather than escaping as a
    // rejection: `run` answers with an outcome or it says why, so a store
    // failing mid-admission lands in the tick's report instead of being
    // swallowed by whoever gathered the dispatches.
    try {
      if (metered) {
        const demand = task.priority === 'demand'
        const taken = await takeQuota(
          policy,
          source,
          demand ? policy.demandLimit : policy.scheduledLimit,
          demand ? task.deadline : undefined,
          unslotted,
          trips,
        )
        if (!taken.ok) return { status: 'throttled', retryAt: taken.retryAt }
        charged = taken.takenAt
      }
      const permit = await takePermit(
        source,
        (takenAt) => takenAt + query.leaseMs + PERMIT_GRACE_MS,
        task.priority === 'demand' ? task.deadline : undefined,
        trips,
        metered ? 1 : 0,
      )
      if (!permit.ok) {
        if (charged !== null) await giveQuotaBack(source, policy!.windowMs, charged)
        return { status: 'deferred', retryAt: permit.retryAt }
      }
      try {
        // Both bounds are fixed here, before the claim goes out, and the call is
        // held to the absolute one: waiting out a quota window, queueing for a
        // permit and the claim round trip itself all come out of the call's own
        // `timeout`, never out of the `lease - timeout` margin the query
        // declared. Measuring the fetch from wherever the claim happened to
        // return is what would let it run past the lease a peer reads.
        const admittedAt = clock.now()
        const upstreamBy = admittedAt + query.timeoutMs
        const leaseUntil = upstreamBy + (query.leaseMs - query.timeoutMs)
        const claimed = await schedule.claim(name, row.version, leaseUntil, admittedAt)
        if (!claimed) {
          // Someone else is doing this work; nothing leaves for upstream here,
          // so the slot this call was counted for goes back to the window.
          if (charged !== null) await giveQuotaBack(source, policy!.windowMs, charged)
          return { status: 'leased' }
        }
        charged = null
        const token = row.version + 1
        try {
          const budget = Math.max(0, upstreamBy - clock.now())
          const data = await withDeadline(clock, budget, `query '${name}'`, (signal) =>
            query.fetch({ signal, now: admittedAt, attempt: row.failCount + 1 }),
          )
          return await succeed(query, token, data, clock.now())
        } catch (err) {
          return await fail(query, row, token, err)
        }
      } finally {
        await permit.release()
      }
    } catch (err) {
      if (charged !== null) await giveQuotaBack(source, policy!.windowMs, charged)
      return { status: 'failed', message: errorMessage(err) }
    }
  }

  /** Takes the answer of the flight this reader joined, and only that one. */
  const awaitFlight = async (
    key: string,
    generation: number,
    deadline: number,
  ): Promise<EphemeralOutcome> => {
    let interval = FLIGHT_POLL_MS
    for (;;) {
      const state = await schedule.readFlight(key, clock.now())
      if (state?.settled?.generation === generation) return state.settled.outcome
      // Somebody took the flight over, so the call this reader was waiting on
      // is never going to answer it.
      if (state === null || (state.running !== null && state.running > generation)) {
        return { status: 'failed', message: `query '${key}': the call it joined went away` }
      }
      const remaining = deadline - clock.now()
      if (remaining <= 0) {
        return { status: 'failed', message: `query '${key}': timed out waiting for its call` }
      }
      await sleepFor(Math.min(interval, remaining))
      interval = Math.min(interval * 2, MAX_FLIGHT_POLL_MS)
    }
  }

  /** Makes the call the whole cohort is waiting on, and hands them the answer. */
  const leadFlight = async (
    query: EphemeralQuery,
    generation: number,
    deadline: number,
    unslotted: Unslotted,
  ): Promise<EphemeralOutcome> => {
    const { name, source } = query
    const settle = async (outcome: FlightOutcome): Promise<EphemeralOutcome> => {
      try {
        await schedule.settleFlight(name, generation, outcome, clock.now() + FLIGHT_HANDOFF_MS)
      } catch {
        // The cohort falls back to its own deadline. A handoff that does not
        // land costs those readers an answer, never the ledger its accuracy:
        // the call happened, and it stays charged.
      }
      return outcome
    }

    const policy = sources.get(source)
    const metered = policy !== undefined && policy.windowMs !== Infinity
    const trips = measureRoundTrips()
    let charged: number | null = null
    // Every exit from here settles: a leader that walks away without one leaves
    // its cohort polling a flight nobody is ever going to answer, until their
    // own deadlines run out. A store that throws mid-admission is the ordinary
    // way that happens, and the cohort is owed an answer for it too.
    try {
      if (metered) {
        // A reader is waiting, so this draws on the same ceiling a miss does,
        // reserve included - once, for everyone who joined.
        const taken = await takeQuota(
          policy,
          source,
          policy.demandLimit,
          deadline,
          unslotted,
          trips,
        )
        if (!taken.ok) return await settle({ status: 'throttled', retryAt: taken.retryAt })
        charged = taken.takenAt
      }
      // A refusal here still has to hand the answer to the cohort, and the quota
      // back if it took any.
      const permit = await takePermit(
        source,
        () => deadline + PERMIT_GRACE_MS,
        deadline,
        trips,
        metered ? 2 : 1,
      )
      if (!permit.ok) {
        // Nothing reached upstream, so the slot goes back and the cohort is told
        // it is not their turn - never that there is nothing.
        if (charged !== null) await giveQuotaBack(source, policy!.windowMs, charged)
        return await settle({ status: 'throttled', retryAt: permit.retryAt })
      }
      charged = null
      try {
        const startedAt = clock.now()
        const remaining = Math.max(0, Math.min(query.timeoutMs, deadline - startedAt))
        const data = await withDeadline(clock, remaining, `query '${name}'`, (signal) =>
          query.fetch({ signal, now: startedAt, attempt: 1 }),
        )
        return await settle({ status: 'ran', data })
      } catch (err) {
        return await settle({ status: 'failed', message: errorMessage(err) })
      } finally {
        await permit.release()
      }
    } catch (err) {
      if (charged !== null) await giveQuotaBack(source, policy!.windowMs, charged)
      return await settle({ status: 'failed', message: errorMessage(err) })
    }
  }

  /** Only calls actually in flight hold a slot; a wait for the window gives it back. */
  const inSlot = async <T>(
    source: string,
    run: (unslotted: Unslotted) => Promise<T>,
  ): Promise<T> => {
    await semaphores.acquire(source)
    let held = true
    const unslotted = async <R>(wait: () => Promise<R>): Promise<R> => {
      held = false
      semaphores.release(source)
      try {
        return await wait()
      } finally {
        await semaphores.acquire(source)
        held = true
      }
    }
    try {
      return await run(unslotted)
    } finally {
      if (held) semaphores.release(source)
    }
  }

  return {
    run(task: FetchTask): Promise<DispatchOutcome> {
      return inSlot(task.query.source, (unslotted) => dispatch(task, unslotted))
    },

    async runEphemeral(query: EphemeralQuery, deadline: number): Promise<EphemeralOutcome> {
      // Joining happens before any slot is taken: a follower makes no call, so
      // it must not sit on the budget that bounds the ones that do.
      const ticket = await schedule.joinFlight(query.name, deadline + PERMIT_GRACE_MS, clock.now())
      if (ticket.role === 'follower') {
        return awaitFlight(query.name, ticket.generation, deadline)
      }
      return inSlot(query.source, (unslotted) =>
        leadFlight(query, ticket.generation, deadline, unslotted),
      )
    },
  }
}

function retryDelayMs(
  err: unknown,
  failCount: number,
  everyMs: number,
  random: () => number,
): number {
  const retryAfter = err instanceof RateLimitError ? err.retryAfterMs : undefined
  return retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfterMs(retryAfter, random)
    : backoffMs(failCount, everyMs, random)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
