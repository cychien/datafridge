import { createReader, defineQueries } from '@datafridge/core'
import { d1, ensureStarted, FridgeDO } from '@datafridge/cloudflare'

export interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
  API: Fetcher
}

// The fetcher needs a binding, so the registry is a function of env rather than
// a module constant. Both the scheduler and the read route build it from here,
// which is how the two sides share one definition.
const queriesFor = (env: Env) =>
  defineQueries([
    {
      name: 'fake-weather',
      every: '15s',
      timeout: '5s',
      fetch: async ({ signal }) => {
        const res = await env.API.fetch('https://fake-api.internal/fake-api', { signal })
        if (!res.ok) throw new Error(`upstream responded ${res.status}`)
        return res.json()
      },
    },
  ])

export class Poller extends FridgeDO<Env> {
  get queries() {
    return queriesFor(this.env)
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
      const reader = createReader({ store: d1(env.DB), queries: queriesFor(env) })
      // The fake API takes 400ms, so a cold first request waits for it rather
      // than answering null; every later request is a plain D1 read.
      return Response.json(await reader.read('fake-weather'))
    }

    return new Response('try /read or /fake-api\n', { status: 404 })
  },
}
