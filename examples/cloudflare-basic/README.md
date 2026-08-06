# cloudflare-basic

Minimal setup: `PollerDO` (Durable Object alarms) polls a fake slow API
every 15s and writes envelopes to D1; the read endpoint goes straight to D1
through `createReader` and never waits on the upstream.

## Run

From the repo root:

```sh
pnpm install
pnpm build
```

Then in this folder:

```sh
pnpm migrate   # apply the packaged D1 schema locally
pnpm dev       # wrangler dev
```

Hit the read endpoint (the first call ignites the alarm chain, so the very
first response is `null` until the first poll lands, within ~1s):

```sh
curl http://localhost:8787/read
```

Response shape: `{ data, fetchedAt, isStale, age }` - `fetchedAt` tells you how
old the data is, and if the fake API ever fails, reads keep serving the last
good envelope with `isStale` / `lastError` set.
