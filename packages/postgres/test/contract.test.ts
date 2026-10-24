import { storeContractSuite } from '@datafridge/core/contract-tests'

import { postgresStore } from '../src/index.js'
import { eachBackend } from './backends.js'

eachBackend((backend, label) => {
  storeContractSuite(`postgres on ${label}`, async () => {
    await backend().wipe()
    return postgresStore(backend().db)
  })
})
