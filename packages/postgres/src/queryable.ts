/**
 * The one method the store needs from a Postgres client: run a single
 * parameterized statement (`$1`, `$2`, ...) and hand back its rows.
 * node-postgres `Pool`, `Client` and `PoolClient`, PGlite, and Neon's `Pool`,
 * `Client` and `neon(url, { fullResults: true })` all satisfy it as they are.
 *
 * Every store operation is exactly one statement, so nothing ever needs a
 * connection to itself across calls: a pool is safe to pass straight in.
 */
export interface PostgresQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

/**
 * What the store accepts: a client, or a Drizzle database (node-postgres or
 * PGlite driver), whose `$client` is read again for every statement so a
 * database that swaps connections per request or per Durable Object keeps
 * working.
 */
export type PostgresClient = PostgresQueryable | { readonly $client: PostgresQueryable }

export function resolveClient(db: PostgresClient): PostgresQueryable {
  if (typeof (db as Partial<PostgresQueryable>).query === 'function') {
    return db as PostgresQueryable
  }
  const client = (db as { $client?: Partial<PostgresQueryable> }).$client
  if (client && typeof client.query === 'function') return client as PostgresQueryable
  throw new TypeError(
    'datafridge: postgresStore needs a client with query(text, params) - a pg Pool or ' +
      'Client, PGlite, Neon - or a Drizzle database exposing one as $client',
  )
}
