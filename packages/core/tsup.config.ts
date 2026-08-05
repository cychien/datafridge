import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/contract-tests.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
})
