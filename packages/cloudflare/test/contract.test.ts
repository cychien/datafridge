import { env } from 'cloudflare:test'
import { storeContractSuite } from '@datafridge/core/contract-tests'

import { d1Store } from '../src/d1.js'

// Storage isolation is per test file, so the factory hands out a wiped store.
storeContractSuite('d1Store', async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM datafridge_results'),
    env.DB.prepare('DELETE FROM datafridge_schedule'),
  ])
  return d1Store(env.DB)
})
