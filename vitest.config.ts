import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/cloudflare', 'packages/cloudflare/vitest.cli.config.ts'],
  },
})
