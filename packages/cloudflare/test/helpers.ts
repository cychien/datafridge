import type { ReadResult, Store, ThrottledRead } from '@datafridge/core'

/**
 * What a read-only consumer gets: it can serve what is stored and tell a
 * backoff from a fetch in flight, and it can do nothing else. A reader over
 * this cannot claim, so it never fetches and never applies schema.
 */
export function readOnly(store: Store): Pick<Store, 'readResult' | 'readSchedule'> {
  return {
    readResult: (name) => store.readResult(name),
    readSchedule: (name) => store.readSchedule(name),
  }
}

/**
 * Narrows a read to the stored case. Tests that are not about rate limiting say
 * so by using this: being throttled there is a failure, not a branch to handle.
 */
export function stored<T>(result: ReadResult<T> | ThrottledRead | null): ReadResult<T> | null {
  if (result !== null && result.status === 'throttled') {
    throw new Error(`expected a stored read, got throttled until ${result.retryAt}`)
  }
  return result
}

/**
 * Every table datafridge owns, asked of the database rather than listed here:
 * a test fixture that has to be updated when the schema grows is a test fixture
 * that silently stops isolating.
 */
async function datafridgeTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'datafridge_%'")
    .all<{ name: string }>()
  return results.map((row) => row.name)
}

/** Empties datafridge's tables, leaving the schema in place. */
export async function wipeStore(db: D1Database): Promise<void> {
  const tables = await datafridgeTables(db)
  if (tables.length === 0) return
  await db.batch(tables.map((table) => db.prepare(`DELETE FROM ${table}`)))
}

/** Takes the schema away entirely, so the next write has to put it back. */
export async function dropStore(db: D1Database): Promise<void> {
  const tables = await datafridgeTables(db)
  if (tables.length === 0) return
  await db.batch(tables.map((table) => db.prepare(`DROP TABLE ${table}`)))
}
