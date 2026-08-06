import { describe, expect, it } from 'vitest'

import {
  createPoller,
  createReader,
  defineQueries,
  FakeClock,
  flushMicrotasks,
  memoryStore,
} from '../src/index.js'
import { deferred, makeDriver, resultsOnly } from './helpers.js'

const queries = defineQueries([{ name: 'q', every: '5m', timeout: '30s', fetch: async () => 'v1' }])

function makePoller(overrides: { store?: ReturnType<typeof memoryStore>; clock?: FakeClock } = {}) {
  const clock = overrides.clock ?? new FakeClock(0)
  const store = overrides.store ?? memoryStore()
  const poller = createPoller({
    queries,
    store,
    driver: makeDriver({ serialized: true }),
    clock,
    random: () => 0,
  })
  return { clock, store, poller }
}

describe('poller.read on a cold query', () => {
  it('fetches on a miss and returns the fresh result', async () => {
    const { poller, clock } = makePoller()
    const read = poller.read<string>('q')
    await clock.advance(0)
    await expect(read).resolves.toMatchObject({ data: 'v1', isStale: false, age: 0 })
  })

  it('leaves a hit alone: an existing result never waits, stale or not', async () => {
    const { poller, clock, store } = makePoller()
    await poller.runDue()
    await clock.advance(600_000)

    // Stale, and the store would answer instantly even if the upstream hung.
    const hit = await poller.read<string>('q')
    expect(hit).toMatchObject({ data: 'v1', isStale: true })
    expect((await store.readSchedule('q'))!.failCount).toBe(0)
  })

  it('one upstream call however many readers miss at once', async () => {
    const gate = deferred<string>()
    let calls = 0
    const slow = defineQueries([
      {
        name: 'q',
        every: '5m',
        timeout: '30s',
        fetch: async () => {
          calls += 1
          return gate.promise
        },
      },
    ])
    const clock = new FakeClock(0)
    const store = memoryStore()
    const poller = createPoller({
      queries: slow,
      store,
      driver: makeDriver({ serialized: false }),
      clock,
      random: () => 0,
    })

    const reads = [poller.read<string>('q'), poller.read<string>('q'), poller.read<string>('q')]
    await flushMicrotasks()
    expect(calls).toBe(1)

    gate.resolve('shared')
    await clock.advance(1_000)
    for (const read of await Promise.all(reads)) {
      expect(read).toMatchObject({ data: 'shared' })
    }
    expect(calls).toBe(1)
  })

  it("gives up when the query's timeout is reached, and records the failure", async () => {
    const gate = deferred<string>()
    const slow = defineQueries([
      { name: 'q', every: '5m', timeout: '2s', fetch: async () => gate.promise },
    ])
    const clock = new FakeClock(0)
    const store = memoryStore()
    const poller = createPoller({
      queries: slow,
      store,
      driver: makeDriver({ serialized: true }),
      clock,
      random: () => 0,
    })

    const read = poller.read<string>('q')
    await flushMicrotasks() // let the read reach its deadline timer before time moves
    await clock.advance(2_000)
    await expect(read).resolves.toBeNull()

    // The wait and the fetch share one deadline, so the hung upstream is aborted
    // rather than left running: this counts as a failure and backs off.
    gate.resolve('too late')
    await flushMicrotasks()
    expect((await store.readSchedule('q'))!.failCount).toBe(1)
    expect(await store.readResult('q')).toBeNull()
  })

  it('returns null immediately when the upstream fails', async () => {
    const failing = defineQueries([
      {
        name: 'q',
        every: '5m',
        timeout: '30s',
        fetch: async () => {
          throw new Error('upstream down')
        },
      },
    ])
    const clock = new FakeClock(0)
    const poller = createPoller({
      queries: failing,
      store: memoryStore(),
      driver: makeDriver({ serialized: true }),
      clock,
      random: () => 0,
    })

    await expect(poller.read('q')).resolves.toBeNull()
    expect(clock.now()).toBe(0)
  })

  it('does not spend the budget while a failed query is backing off', async () => {
    const failing = defineQueries([
      {
        name: 'q',
        every: '5m',
        timeout: '30s',
        fetch: async () => {
          throw new Error('upstream down')
        },
      },
    ])
    const clock = new FakeClock(0)
    const store = memoryStore()
    const poller = createPoller({
      queries: failing,
      store,
      driver: makeDriver({ serialized: true }),
      clock,
      random: () => 0,
    })
    await poller.runDue()
    expect((await store.readSchedule('q'))!.nextRunAt).toBeGreaterThan(clock.now())

    // Nothing is running and nothing is due: answer now rather than wait it out.
    await expect(poller.read('q')).resolves.toBeNull()
    expect(clock.now()).toBe(0)
  })
})

describe('reader.read on a cold query', () => {
  it('waits for a write it cannot make itself', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const { poller } = makePoller({ store, clock })
    const reader = createReader({ store, queries, clock })

    const read = reader.read<string>('q')
    await clock.advance(0)
    expect(await store.readResult('q')).toBeNull()

    // Something else - a Durable Object alarm, a cron tick - writes it.
    await poller.runDue()
    await clock.advance(50)
    await expect(read).resolves.toMatchObject({ data: 'v1' })
  })

  it('answers a miss immediately without the registry, since nothing says how long to wait', async () => {
    const clock = new FakeClock(0)
    const reader = createReader({ store: memoryStore(), clock })
    await expect(reader.read('q')).resolves.toBeNull()
    expect(clock.now()).toBe(0)
  })

  it('rejects an unknown name when the registry is present', async () => {
    const reader = createReader({ store: memoryStore(), queries, clock: new FakeClock(0) })
    await expect(reader.read('typo')).rejects.toThrow(/unknown query 'typo'/)
  })

  it('still reads without a registry, exactly as before', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const { poller } = makePoller({ store, clock })
    await poller.runDue()

    const reader = createReader({ store, clock })
    await expect(reader.read<string>('q')).resolves.toMatchObject({ data: 'v1' })
    await expect(reader.read('typo')).resolves.toBeNull()
  })

  it('escalates the poll interval so a full-timeout wait costs a few dozen store reads', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    let reads = 0
    const counted = {
      readResult: async (name: string) => {
        reads += 1
        return store.readResult(name)
      },
    }
    const reader = createReader({ store: counted, queries, clock })

    const read = reader.read('q')
    await flushMicrotasks()
    await clock.advance(30_000)
    await expect(read).resolves.toBeNull()
    // A flat 50ms poll would be 601; each read is a billed subrequest on
    // Cloudflare, against a 50-per-invocation cap on the free plan.
    expect(reads).toBeLessThan(40)
  })

  it('waits exactly as long as the query may take, with nothing to configure', async () => {
    const clock = new FakeClock(0)
    const reader = createReader({
      store: memoryStore(),
      queries: defineQueries([{ name: 'q', every: '5m', timeout: '1s', fetch: async () => 'v1' }]),
      clock,
    })

    const read = reader.read('q')
    await flushMicrotasks()
    await clock.advance(999)
    expect(await Promise.race([read, Promise.resolve('pending')])).toBe('pending')
    await clock.advance(1)
    await expect(read).resolves.toBeNull()
  })
})

describe('a reader that can see the schedule stops waiting for a backoff', () => {
  const failing = defineQueries([
    {
      name: 'q',
      every: '5m',
      timeout: '30s',
      fetch: async () => {
        throw new Error('upstream down')
      },
    },
  ])

  it('answers a backing-off query at once instead of polling out the timeout', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const poller = createPoller({
      queries: failing,
      store,
      driver: makeDriver({ serialized: true }),
      clock,
      random: () => 0,
    })
    await poller.runDue()
    expect((await store.readSchedule('q'))!.nextRunAt).toBeGreaterThan(clock.now())

    // The full store gives the reader readSchedule, so it can tell a scheduled
    // retry from a fetch that is about to land.
    const reader = createReader({ store, queries: failing, clock })
    await expect(reader.read('q')).resolves.toBeNull()
    expect(clock.now()).toBe(0)
  })

  it('still waits while another executor holds the lease', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const queries = defineQueries([{ name: 'q', every: '5m', fetch: async () => 'v1' }])
    const poller = createPoller({
      queries,
      store,
      driver: makeDriver({ serialized: true }),
      clock,
      random: () => 0,
    })
    const reader = createReader({ store, queries, clock })

    await store.claim('q', 0, clock.now() + 60_000, clock.now())
    const waiting = reader.read<string>('q')
    await flushMicrotasks()

    await store.writeResult('q', {
      data: 'v1',
      fetchedAt: clock.now(),
      freshUntil: clock.now() + 1,
    })
    await clock.advance(50)
    await expect(waiting).resolves.toMatchObject({ data: 'v1' })
    void poller
  })

  it('a store without readSchedule keeps the old behaviour', async () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const poller = createPoller({
      queries: failing,
      store,
      driver: makeDriver({ serialized: true }),
      clock,
      random: () => 0,
    })
    await poller.runDue()

    const reader = createReader({ store: resultsOnly(store), queries: failing, clock })
    const read = reader.read('q')
    await flushMicrotasks()
    await clock.advance(30_000)
    await expect(read).resolves.toBeNull()
  })
})
