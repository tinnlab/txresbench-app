import { defineConfig } from 'vitest/config'

// Node-env unit runner for the @txresbench/dock pure cross-window docking mechanics
// (layout split-tree, container model, drag geometry, window registry).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.browser.test.ts'],
  },
})
