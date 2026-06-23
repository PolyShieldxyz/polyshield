import { defineConfig } from 'vitest/config'
import path from 'path'

// Node-environment unit tests (no DOM). notes.ts persistence guards on `typeof
// window`; the recovery acceptance test installs a localStorage shim itself.
export default defineConfig({
  // Use the React 17+ automatic JSX runtime (matches Next), so component modules under
  // test don't need an explicit `import React`. Harmless for the non-JSX unit tests.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
