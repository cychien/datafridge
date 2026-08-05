import { createPoller, FakeClock, memoryStore } from '../src/index.js'
import type { Driver, PollerConfig, ResultStore, ScheduleStore, Store } from '../src/index.js'

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

export function resultsOnly(store: Store): ResultStore {
  return {
    readResult: (name) => store.readResult(name),
    writeResult: (name, env) => store.writeResult(name, env),
    deleteResult: (name) => store.deleteResult(name),
  }
}

export function scheduleOnly(store: Store): ScheduleStore {
  return {
    readSchedule: (name) => store.readSchedule(name),
    writeSchedule: (row) => store.writeSchedule(row),
    deleteSchedule: (name) => store.deleteSchedule(name),
    claim: (name, expectedVersion, leaseUntil, now) =>
      store.claim(name, expectedVersion, leaseUntil, now),
    listDue: (now, limit) => store.listDue!(now, limit),
    capabilities: store.capabilities,
  }
}

export interface Harness {
  clock: FakeClock
  store: Store
  poller: ReturnType<typeof createPoller>
}

export function makeHarness(
  queries: PollerConfig['queries'],
  overrides: Partial<PollerConfig> = {},
): Harness {
  const clock = (overrides.clock as FakeClock | undefined) ?? new FakeClock(0)
  const store = (overrides.store as Store | undefined) ?? memoryStore()
  const poller = createPoller({
    driver: makeDriver(),
    random: () => 0,
    ...overrides,
    queries,
    clock,
    store,
  })
  return { clock, store, poller }
}
