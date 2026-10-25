---
'@datafridge/postgres': major
---

`@datafridge/postgres`: a Postgres store, so the whole coordination plane - results, schedule rows, leases, the quota ledger, concurrency permits and flights - can live in the Postgres an app already runs.

```ts
import { postgresStore } from '@datafridge/postgres'

const store = postgresStore(pool) // pg Pool, PGlite, Neon, or a Drizzle database
```

It opens no connection of its own and has no runtime dependencies: it takes anything with `query(text, params) => Promise<{ rows }>`, or a Drizzle database whose `$client` it reads per statement, so a database that hands out connections per request or per Durable Object keeps working. Every operation is one statement that locks the row it decides on, so a shared pool is safe under `READ COMMITTED` without transactions. It passes the store contract suite on PGlite and on a real Postgres, plus tests that hold a transaction open on one connection and check the racing statement on another waits and decides correctly.

Tables are created before the first write, in one statement that checks each object first, so several processes starting at once all succeed and a role without `CREATE` works against tables someone else migrated. `ensureSchema(db)`, `POSTGRES_SCHEMA` and the packaged `migrations/0001_datafridge_init.sql` let you create them yourself.
