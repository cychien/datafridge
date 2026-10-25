import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    // CI tests before it builds, so the workspace package resolves to source.
    alias: {
      '@datafridge/core/contract-tests': here('../core/src/contract-tests.ts'),
      '@datafridge/core': here('../core/src/index.ts'),
    },
  },
  test: {
    name: 'postgres',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
