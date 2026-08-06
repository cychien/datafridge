import '@cloudflare/vitest-pool-workers/types'
import type { D1Migration } from 'cloudflare:test'
import type { TestEnv } from './worker.js'

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
