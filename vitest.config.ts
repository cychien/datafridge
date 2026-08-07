import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/cloudflare',
      'packages/cloudflare/vitest.cli.config.ts',
      {
        // Plain node, because the point is to start a real workerd from
        // outside and watch whether it comes up.
        test: {
          name: 'example-cloudflare-basic',
          root: './examples/cloudflare-basic',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          testTimeout: 120_000,
        },
      },
    ],
  },
})
