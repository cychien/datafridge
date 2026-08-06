import { defineConfig } from 'vitest/config'

// The init CLI is plain node code; it gets its own project because the main
// cloudflare project runs everything under the workers pool.
export default defineConfig({
  test: {
    name: 'cloudflare-cli',
    environment: 'node',
    include: ['test-cli/**/*.test.ts'],
  },
})
