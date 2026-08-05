import { storeContractSuite } from '../src/contract-tests.js'
import { memoryStore } from '../src/index.js'

storeContractSuite('memoryStore', () => memoryStore())
