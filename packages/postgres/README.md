# @datafridge/postgres

A Postgres store for [datafridge](https://github.com/cychien/datafridge): result envelopes, schedule rows, leases, the source quota ledger, concurrency permits and transient flights, over the Postgres client your app already has.

```sh
pnpm add @datafridge/core @datafridge/postgres
```

```ts
import { createReader } from '@datafridge/core'
import { postgresStore } from '@datafridge/postgres'

const store = postgresStore(pool) // a pg Pool, PGlite, Neon, or a Drizzle database
const reader = createReader({ store, queries })
```

No runtime dependencies and no connection of its own. Every operation is one statement, so a shared pool is safe. Tables are created before the first write; `ensureSchema(pool)` or the packaged `migrations/0001_datafridge_init.sql` let you create them yourself.

See the [API reference](https://github.com/cychien/datafridge/blob/main/docs/api.md#datafridgepostgres).
