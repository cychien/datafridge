import { createReader } from '@datafridge/core'
import type { QueryDefinition, RunReport } from '@datafridge/core'
import { d1 } from '../src/d1.js'
import { PollerDO } from '../src/do.js'

export interface TestEnv {
  DB: D1Database
  POLLER: DurableObjectNamespace<TestPoller>
}

// The test worker and the tests share an isolate but not a module cache, so
// tests inject the registry straight onto the instance via runInDurableObject;
// reassigning it simulates a redeploy with changed queries.
export class TestPoller extends PollerDO<TestEnv> {
  queries: readonly QueryDefinition[] = []
  reports: RunReport[] = []
  reportError: Error | undefined

  store(env: TestEnv) {
    return d1(env.DB)
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
