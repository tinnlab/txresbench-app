import { defineConfig } from 'vitest/config'
import path from 'node:path'
// @ts-expect-error — plain-JS helper, shared verbatim with `scripts/run-node-tests.mjs`
import { listNodeTestFiles } from './scripts/node-test-files.mjs'

// Unit/L0-L1 test runner (node env). The visualization engine + its unit suites
// were extracted into the standalone `@ziee/viz` package (src-app/libs/viz), which
// owns its own vitest pass — so the app itself currently has no in-src unit
// tests. `passWithNoTests` keeps this pass green until the app grows its own.
export default defineConfig({
  // Mirror `vite.config.ts`'s app-local `@` alias so in-`src` unit tests can
  // import through the same `@/…` paths the app uses (W1 actions/palette
  // suites); `@ziee/*` resolve via the npm-workspace symlinks + exports maps.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // Default env is node (the pure-TS engine suites). A `.test.tsx` React
    // render suite opts into jsdom per-file via a `// @vitest-environment jsdom`
    // docblock (processor-registry TEST-23) — no global DOM cost for the rest.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // `node:test` suites are EXCLUDED, derived (never hand-listed) from the same
    // helper `scripts/run-node-tests.mjs` uses to decide what to RUN — see that
    // module's header. vitest reports a `node:test` file as a PASSING file with zero
    // tests even when its assertions fail, so leaving them in this include turns 24
    // real suites into 24 hollow green ticks.
    exclude: [
      '**/node_modules/**',
      '**/*.browser.test.ts',
      ...(listNodeTestFiles() as string[]),
    ],
    passWithNoTests: true,
  },
})
