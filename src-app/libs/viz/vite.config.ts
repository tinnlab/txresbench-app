import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { gallerySentinelPlugin } from '@ziee/gallery/vite/vite-plugin-gallery-sentinel.js'
import { resolve } from 'node:path'

// Dev/demo Vite config for the @ziee/viz showcase. Root = the package, so the
// viz-showcase.html entry sits at the package root and its `/src/...` module
// scripts resolve under src/. Backend-free (fixture-seeded); served on :1421 for
// the viz e2e + gallery-verify.
export default defineConfig({
  root: __dirname,
  // Tailwind (v4 vite plugin) powers the @ziee/kit-based in-cell controls in the standalone showcase;
  // the CSS pipeline is dev/demo-only (viz-showcase.html), never a release build.
  //
  // `gallerySentinelPlugin` answers `/__worktree` with THIS server's worktree root
  // (dev AND `vite preview`, via `apply: 'serve'`; never in a prod bundle). It is what
  // lets the viz e2e runner PROVE that a showcase already listening on the port it wants
  // belongs to this worktree before reusing it. Without it every reuse is a guess, and on
  // this multi-worktree box the guess was wrong: two trees raced for the old fixed :1421
  // and the loser audited the winner's @ziee/viz build. Do not remove it —
  // `src-app/ui/scripts/resolve-viz-port.mjs` FAILS CLOSED (skips the port) when a server
  // does not answer `/__worktree`, so dropping this plugin does not silently degrade to
  // the old behaviour; it makes every run boot a fresh server on a fresh port.
  plugins: [react(), tailwindcss(), gallerySentinelPlugin()],
  clearScreen: false,
  server: {
    // No default port: the RUNNER passes `--port <derived> --strictPort` (see
    // `src-app/ui/playwright.viz.config.ts`), and `npm run viz-showcase` lets vite pick.
    // A committed literal here is what two worktrees collided on.
    strictPort: true,
    // Dev/demo server: reached through the workspace HTTP proxy (an arbitrary
    // `*.workspace.*` hostname), so disable Vite's host allow-list. This config is
    // never part of a release build.
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      input: {
        showcase: resolve(__dirname, 'viz-showcase.html'),
      },
    },
  },
})
