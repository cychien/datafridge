import { createFridge, FakeClock, memoryStore } from '../src/index.js'
import type {
  Driver,
  FridgeConfig,
  ReadResult,
  SchedulePlane,
  Store,
  ThrottledRead,
} from '../src/index.js'

/**
 * Narrows a fridge read to the stored case. Tests that are not about rate
 * limiting say so by using this: being throttled there is a failure, not a
 * branch to handle.
 */
export function stored<T>(result: ReadResult<T> | ThrottledRead | null): ReadResult<T> | null {
  if (result !== null && result.status === 'throttled') {
    throw new Error(`expected a stored read, got throttled until ${result.retryAt}`)
  }
  return result
}

export function makeDriver(overrides: Partial<Driver> = {}): Driver {
  return { serialized: false, defer: () => undefined, ...overrides }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** All a reader ever touches: proof that a read-only consumer needs nothing else. */
export function resultsOnly(store: Store): Pick<Store, 'readResult'> {
  return { readResult: (name) => store.readResult(name) }
}

export function scheduleOnly(store: Store): SchedulePlane {
  return {
    readSchedule: (name) => store.readSchedule(name),
    writeSchedule: (row) => store.writeSchedule(row),
    deleteSchedule: (name) => store.deleteSchedule(name),
    claim: (name, expectedVersion, leaseUntil, now) =>
      store.claim(name, expectedVersion, leaseUntil, now),
    takeQuota: (source, limit, windowMs, now) => store.takeQuota(source, limit, windowMs, now),
    releaseQuota: (source, windowMs, takenAt) => store.releaseQuota(source, windowMs, takenAt),
    acquirePermit: (source, limit, holder, expiresAt, now, explainRefusal) =>
      store.acquirePermit(source, limit, holder, expiresAt, now, explainRefusal),
    releasePermit: (source, holder) => store.releasePermit(source, holder),
    joinFlight: (key, expiresAt, now) => store.joinFlight(key, expiresAt, now),
    readFlight: (key, now) => store.readFlight(key, now),
    settleFlight: (key, generation, outcome, keepUntil) =>
      store.settleFlight(key, generation, outcome, keepUntil),
    sweepFlights: (before, limit) => store.sweepFlights(before, limit),
    listDue: (now, limit) => store.listDue!(now, limit),
    capabilities: store.capabilities,
  }
}

export interface Harness {
  clock: FakeClock
  store: Store
  fridge: ReturnType<typeof createFridge>
}

export function makeHarness(
  queries: FridgeConfig['queries'],
  overrides: Partial<FridgeConfig> = {},
): Harness {
  const clock = (overrides.clock as FakeClock | undefined) ?? new FakeClock(0)
  const store = (overrides.store as Store | undefined) ?? memoryStore()
  const fridge = createFridge({
    driver: makeDriver(),
    random: () => 0,
    ...overrides,
    queries,
    clock,
    store,
  })
  return { clock, store, fridge }
}
