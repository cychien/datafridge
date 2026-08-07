import { env } from 'cloudflare:test'
import { storeContractSuite } from '@datafridge/core/contract-tests'

import { d1 } from '../src/d1.js'
import { wipeStore } from './helpers.js'

// Storage isolation is per test file, so the factory hands out a wiped store.
storeContractSuite('d1', async () => {
  await wipeStore(env.DB)
  return d1(env.DB)
})
