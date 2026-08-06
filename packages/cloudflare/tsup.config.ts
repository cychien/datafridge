import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/do.ts', 'src/d1.ts', 'src/cron.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    tsconfig: 'tsconfig.build.json',
    external: ['@datafridge/core', 'cloudflare:workers'],
  },
  {
    // Node CLI: smol-toml is bundled in so the package keeps zero runtime deps.
    entry: { cli: 'src/cli/bin.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
    tsconfig: 'tsconfig.cli.json',
    noExternal: ['smol-toml'],
  },
])
