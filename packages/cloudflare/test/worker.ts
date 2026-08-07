import { createReader } from '@datafridge/core'
import type { QueryDefinition, RunReport, Store } from '@datafridge/core'
import { d1 } from '../src/d1.js'
import { FridgeDO } from '../src/do.js'

export interface TestEnv {
  DB: D1Database
  POLLER: DurableObjectNamespace<TestFridge>
}

// The test worker and the tests share an isolate but not a module cache, so
// tests inject the registry straight onto the instance via runInDurableObject;
// reassigning it simulates a redeploy with changed queries.
export class TestFridge extends FridgeDO<TestEnv> {
  queries: readonly QueryDefinition[] = []
  reports: RunReport[] = []
  reportError: Error | undefined
  // Lets a test stand a failing D1 in front of the real one, so the object's
  // own behaviour under a store that throws is observable from outside it.
  breakStore: ((store: Store) => Store) | undefined

  store(env: TestEnv) {
    const store = d1(env.DB)
    return this.breakStore ? this.breakStore(store) : store
  }

  protected override onRunReport(report: RunReport) {
    this.reports.push(report)
    if (this.reportError) throw this.reportError
  }
}

// Read-side worker: goes straight to D1 through createReader, never touches
// the POLLER namespace.
export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/read/')) {
      const name = url.pathname.slice('/read/'.length)
      const reader = createReader({ store: d1(env.DB) })
      return Response.json(await reader.read(name))
    }
    return new Response('not found', { status: 404 })
  },
}
