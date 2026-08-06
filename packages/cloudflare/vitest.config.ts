import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig(async () => {
  const migrations = await readD1Migrations(here('./migrations'))
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './test/wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    resolve: {
      // CI typechecks and tests before building, so point the workspace
      // package at core's source instead of dist.
      alias: {
        '@datafridge/core/contract-tests': here('../core/src/contract-tests.ts'),
        '@datafridge/core': here('../core/src/index.ts'),
      },
    },
    test: {
      name: 'cloudflare',
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  }
})
