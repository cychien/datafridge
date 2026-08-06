# cloudflare-basic

Minimal setup: `PollerDO` (Durable Object alarms) polls a fake slow API
every 15s and writes results to D1; the read endpoint goes straight to D1
through `createReader` and never waits on the upstream once anything is stored.

## Run

From the repo root:

```sh
pnpm install
pnpm build
```

Then in this folder:

```sh
pnpm dev       # wrangler dev; the tables are created on the first write
```

Hit the read endpoint. The first call ignites the alarm chain and waits for
that first poll instead of answering `null`, for at most the query's `timeout`,
which this app sets to 5s. Every later call is a plain D1 read:

```sh
curl http://localhost:8787/read
```

Response shape: `{ data, fetchedAt, isStale, age }` - `fetchedAt` tells you how
old the data is, and if the fake API ever fails, reads keep serving the last
good result with `isStale` / `lastError` set.
