import { createReader, defineQueries } from '@datafridge/core'
import { d1, ensureStarted, PollerDO } from '@datafridge/cloudflare'

export interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
  API: Fetcher
}

export class Poller extends PollerDO<Env> {
  get queries() {
    return defineQueries([
      {
        name: 'fake-weather',
        every: '15s',
        fetch: async ({ signal }) => {
          const res = await this.env.API.fetch('https://fake-api.internal/fake-api', { signal })
          if (!res.ok) throw new Error(`upstream responded ${res.status}`)
          return res.json()
        },
      },
    ])
  }

  store(env: Env) {
    return d1(env.DB)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)

    // A stand-in for a slow third-party API.
    if (pathname === '/fake-api') {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return Response.json({
        tempC: Math.round(150 + Math.random() * 100) / 10,
        observedAt: new Date().toISOString(),
      })
    }

    if (pathname === '/read') {
      await ensureStarted(env.POLLER)
      const reader = createReader({ store: d1(env.DB) })
      return Response.json(await reader.read('fake-weather'))
    }

    return new Response('try /read or /fake-api\n', { status: 404 })
  },
}
