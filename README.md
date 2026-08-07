<h1 align="center">datafridge</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@datafridge/core"
    ><img
      alt="@datafridge/core on npm"
      src="https://img.shields.io/npm/v/%40datafridge%2Fcore?style=flat-square&label=%40datafridge%2Fcore"
  /></a>
  <a href="https://www.npmjs.com/package/@datafridge/cloudflare"
    ><img
      alt="@datafridge/cloudflare on npm"
      src="https://img.shields.io/npm/v/%40datafridge%2Fcloudflare?style=flat-square&label=%40datafridge%2Fcloudflare"
  /></a>
  <a href="https://github.com/cychien/datafridge/actions/workflows/ci.yml"
    ><img
      alt="CI"
      src="https://img.shields.io/github/actions/workflow/status/cychien/datafridge/ci.yml?branch=main&style=flat-square&label=ci"
  /></a>
</p>

<h3 align="center">Data always on hand, stable and reliable</h3>

<p align="center"><strong>English</strong> · <a href="./README.zh-TW.md">繁體中文</a></p>

When our system depends on third-party data, an unstable source can easily make our own system look unreliable.

This instability includes slow responses, intermittent data, and rate limits that appear as usage or call frequency grows.

datafridge handles this for you. Register a query once and configure its scheduler, store, refresh interval, rate limit, and other metadata. The scheduler then keeps the latest third-party data safely in your database in the background.

The whole library is one promise: **when your app wants data, it always has some.** Not necessarily current - but always there, and as current as the upstream allows.

```
   scheduler tick (Durable Object alarm or cron)
        │
        ▼
   ┌──────────────┐   fetch   ┌──────────────┐
   │ your fetcher │ ────────► │ upstream API │   slow · throttled · flaky
   └──────┬───────┘           └──────────────┘
          │ { data, fetchedAt }        on failure: keep the last good value,
          ▼                            record the error, retry with backoff
   ┌─────────────────────────────────────────────┐
   │ your store                                  │
   └──────┬──────────────────────────────────────┘
          │ read() - one local query
          ▼
   { data, fetchedAt, isStale, age }
```

`@datafridge/core` is the engine: pure logic with zero runtime dependencies. `@datafridge/cloudflare` is the adapter package for Cloudflare infrastructure such as Durable Object alarms, Cron Triggers, and D1.

## Use cases

datafridge fits data that may be briefly stale but must remain fast and reliable to read:

- **Dashboards and reports**: Periodically fetch analytics, advertising, or operational data instead of making every user wait for a third-party API.
- **External data synchronization**: Keep CMS content, public datasets, event information, or catalogs in your own database so upstream failures do not take down your product.
- **Expensive aggregate queries**: Precompute data across services or large ranges in the background so requests only read completed results.
- **Shared API quotas**: Let multiple Workers, schedulers, and requests share a rate limit and concurrency ceiling without overwhelming the upstream.
- **Continuous service during failures**: Keep returning last-known-good data while an upstream times out, throttles, or goes temporarily offline, then retry with backoff in the background.

It is not suitable for transactional flows such as payment confirmation, inventory deduction, or authorization checks that require the current source of truth.

## Quick start

This example uses a Cloudflare Durable Object (`FridgeDO`) as the scheduler and Cloudflare D1 as the store. Node.js 20 or newer is required.

```sh
npm install @datafridge/core @datafridge/cloudflare
npx --no-install datafridge init --scheduler durable-object --store d1
npx wrangler d1 create datafridge
```

Paste the D1 `database_id` into your Wrangler configuration as prompted by the CLI, then configure the poller and fetcher:

```ts
import { createReader, defineQueries } from '@datafridge/core'
import { d1, ensureStarted, FridgeDO } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
}

const queries = defineQueries([
  {
    name: 'weekly-summary',
    every: '10m',
    fetch: async ({ signal }) => {
      const response = await fetch('https://api.example.com/weekly-summary', { signal })
      if (!response.ok) throw new Error(`upstream status ${response.status}`)
      return response.json()
    },
  },
])

export class Poller extends FridgeDO<Env> {
  queries = queries

  store(env: Env) {
    return d1(env.DB)
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    await ensureStarted(env.POLLER) // Only needed with the Durable Object scheduler to start polling
    const reader = createReader({ store: d1(env.DB), queries })
    return Response.json(await reader.read('weekly-summary'))
  },
}
```

The first read attempts to fetch fresh data. Once data exists, later reads only query D1. See [`examples/cloudflare-basic`](./examples/cloudflare-basic) for a complete example, or [Cloudflare setup](./docs/cloudflare.md) for Cron Triggers, secrets, and Wrangler configuration.

## Documentation

- [API reference](./docs/api.md)
- [Cloudflare setup](./docs/cloudflare.md)
- [Runnable Cloudflare example](./examples/cloudflare-basic)

## License

[MIT](./LICENSE)
