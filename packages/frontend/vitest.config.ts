import { defineConfig } from 'vitest/config'
import path from 'path'

// Node-environment unit tests (no DOM). notes.ts persistence guards on `typeof
// window`; the recovery acceptance test installs a localStorage shim itself.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
