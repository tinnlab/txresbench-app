// Prod-mode benchmark build of the @ziee/viz showcase (measure warm interaction latency
// against a REAL production React build — the dev server's perf instrumentation inflates
// million-element typed-array prop diffs ~1000x). Manual: `vite build --config vite.bench.config.ts`.
import base from './vite.config'
import { defineConfig, mergeConfig } from 'vite'
import { resolve } from 'node:path'

export default mergeConfig(base, defineConfig({
  build: {
    outDir: resolve(__dirname, 'dist-bench'),
    emptyOutDir: true,
    rollupOptions: {
      input: { showcase: resolve(__dirname, 'viz-showcase.html') },
    },
    minify: true,
  },
}))
