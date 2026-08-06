import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/do.ts', 'src/d1.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  tsconfig: 'tsconfig.build.json',
  external: ['@datafridge/core', 'cloudflare:workers'],
})
