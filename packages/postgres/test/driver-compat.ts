import type { PGlite } from '@electric-sql/pglite'
import type {
  Client as NeonClient,
  NeonQueryFunction,
  Pool as NeonPool,
} from '@neondatabase/serverless'
import type { drizzle as drizzleNodePostgres } from 'drizzle-orm/node-postgres'
import type { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import type pg from 'pg'

import type { PostgresClient } from '../src/index.js'

// Compiled by typecheck, never run: every client the docs name fits as it is.
export type Accepted = [
  pg.Pool,
  pg.Client,
  pg.PoolClient,
  PGlite,
  NeonPool,
  NeonClient,
  NeonQueryFunction<false, true>,
  ReturnType<typeof drizzleNodePostgres<Record<string, never>, pg.Pool>>,
  ReturnType<typeof drizzlePglite<Record<string, never>, PGlite>>,
]

export const everyClientFits: Accepted extends PostgresClient[] ? true : never = true
