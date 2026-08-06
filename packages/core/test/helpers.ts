import { createFridge, FakeClock, memoryStore } from '../src/index.js'
import type { Driver, FridgeConfig, SchedulePlane, Store } from '../src/index.js'

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
