import type { Clock } from './clock.js'
import { defineQueries, Queries } from './define-queries.js'
import { createDispatcher } from './dispatcher.js'
import { ConfigError } from './errors.js'
import { createReadPath } from './read-path.js'
import type { ReadableStore } from './read-path.js'
import { resolveSources } from './sources.js'
import { systemClock, systemRandom } from './system-clock.js'
import type {
  QueryDefinition,
  QueryParams,
  ReadResult,
  SourcePolicy,
  Store,
  ThrottledRead,
} from './types.js'

export {
  MAX_MISS_WAIT_POLL_INTERVAL_MS,
  MISS_WAIT_POLL_INTERVAL_MS,
  decodeRead,
  shapeRead,
  waitForEnvelope,
} from './reader-core.js'

export interface ReaderConfig {
  /**
   * `readResult` is the only method a read needs, and a results-only store is
   * still a complete reader: it serves what is stored and waits for whoever is
   * fetching. A *full* store makes it a reader that can also fetch - the same
   * dispatcher a tick uses, so a miss coalesces behind one lease and a source
   * ceiling applies to it - and it is what `anyParams` requires, since those
   * reads are a call and nothing else.
   */
  store: ReadableStore | Store
  /**
   * Rejects names outside it, and carries the timeout a miss waits for. Without
   * it a reader needs nothing but a store, and a miss answers null immediately
   * because there is no registry to say how long a first result may take.
   */
  queries?: Queries | readonly QueryDefinition[]
  /** What each source will tolerate, for the calls this reader may make itself. */
  sources?: Record<string, SourcePolicy>
  clock?: Clock
  random?: () => number
  /**
   * Where work that outlives the answer goes to finish, e.g. `ctx.waitUntil`.
   * Without it a fetch a reader started is still started, just with nobody
   * holding the invocation open for its write-back.
   */
  defer?: (promise: Promise<unknown>) => void
}

export interface Reader {
  read<T = unknown>(
    name: string,
    params?: QueryParams,
  ): Promise<ReadResult<T> | ThrottledRead | null>
}

/** A store is a full one when it can claim, meter and write, not just read. */
function asFullStore(store: ReadableStore | Store): Store | undefined {
  const candidate = store as Partial<Store>
  return typeof candidate.claim === 'function' &&
    typeof candidate.takeQuota === 'function' &&
    typeof candidate.releaseQuota === 'function' &&
    typeof candidate.writeResult === 'function' &&
    typeof candidate.writeSchedule === 'function' &&
    typeof candidate.readSchedule === 'function'
    ? (store as Store)
    : undefined
}

export function createReader(config: ReaderConfig): Reader {
  const { store, clock = systemClock } = config
  if (!store) throw new ConfigError('createReader requires a store')
  const registry =
    config.queries === undefined
      ? undefined
      : config.queries instanceof Queries
        ? config.queries
        : defineQueries(config.queries)
  const sources = resolveSources(config.sources)
  const full = registry === undefined ? undefined : asFullStore(store)
  if (registry !== undefined && registry.open.length > 0 && full === undefined) {
    throw new ConfigError(
      `query '${registry.open[0]!.baseName}': anyParams is answered by a fresh call, so a ` +
        'reader needs the full store, not a results-only one',
    )
  }

  const read = createReadPath({
    store,
    clock,
    defer: config.defer ?? (() => undefined),
    ...(registry !== undefined ? { queries: registry } : {}),
    ...(full !== undefined
      ? {
          schedule: full,
          dispatcher: createDispatcher({
            store: full,
            schedule: full,
            clock,
            random: config.random ?? systemRandom,
            sources,
          }),
        }
      : {}),
  })

  return { read }
}
