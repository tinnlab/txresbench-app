import { defineConfig } from 'vitest/config'

// Unit/L0-L1 test runner (node env) for the @ziee/viz engine kernels + logic.
// Mirrors the app's former visualization vitest pass. Browser/L3 (WebGL) +
// e2e/L4-L6 run under Playwright against the showcase separately.
export default defineConfig({
  test: {
    // Default env is node (the pure-TS engine kernels). A `.test.tsx` React RENDER
    // suite opts into jsdom per-file via a `// @vitest-environment jsdom` docblock —
    // the same convention `src-app/ui/vitest.config.ts` documents — so the ~200 node
    // suites here pay no DOM cost.
    environment: 'node',
    // `.tsx` was NOT collected before, so a React render suite in this package would
    // have sat on disk under no runner at all — the exact hole `check-package-suites.mjs`
    // exists to close, reproduced one level down.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // exclude the browser-only suites from the node pass
    exclude: ['**/node_modules/**', '**/*.browser.test.ts'],
  },
})
