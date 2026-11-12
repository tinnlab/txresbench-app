import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { gallerySentinelPlugin } from '@txresbench/gallery/vite/vite-plugin-gallery-sentinel.js'
import path from 'node:path'
import { txrBuiltCssUrlsCheck } from './vite-built-css-check'

const srcDir = path.resolve(__dirname, './src')

/**
 * The X1 build check (qa-fixes ITEM-7, wired ITEM-6-d): after the build
 * closes, every `url()` in the built CSS must resolve inside the built
 * directory. The plugin lives in `vite-built-css-check.ts` (its own module so
 * the unit test can drive it against fixture dists) and reads the bundler's
 * RESOLVED outDir — the check runs against what the build actually wrote, in
 * the default case and under a `--outDir` override alike. A broken font base
 * fails the build instead of silently shipping system-font fallback (the
 * `/assets/assets/assets/fonts` defect).
 */

// Minimal SDK-consumer Vite config (SDK_GAPS FE-6: app#1's config is heavily
// txresbench-entangled — root:'src', 5 custom plugins, Tauri env — a fresh app needs
// only react + tailwind + the /api proxy).
export default defineConfig({
  // `gallerySentinelPlugin` serves this server's WORKTREE ROOT at `/__worktree`
  // (dev/preview only — `apply: 'serve'`, never in a prod bundle). It is what
  // lets a gate PROVE that a dev server already listening on the port it wants
  // belongs to THIS worktree before reusing it. Without it every reuse decision
  // is a guess: on this multi-worktree box `just preland-frontend` reused a
  // SIBLING worktree's server on the shared :1420 and audited the wrong source
  // tree — measured as 90 "failing" surfaces on a tree that is byte-identical to
  // a clean, passing `origin/main`. Do not remove it: `scripts/preland-frontend-
  // health.mjs` FAILS CLOSED (exit 2) when the server it is about to audit does
  // not answer `/__worktree`.
  plugins: [react(), tailwindcss(), gallerySentinelPlugin(), txrBuiltCssUrlsCheck()],
  clearScreen: false,
  root: 'src',
  // Pre-bundle deps that are only reached through lazily-imported modules
  // (the settings drawers), so a dynamic import doesn't trigger an on-demand
  // re-optimization ("504 Outdated Optimize Dep") mid-navigation.
  optimizeDeps: {
    include: ['zod', 'react-hook-form', '@hookform/resolvers/zod', 'lucide-react'],
  },
  resolve: {
    // `@txresbench/*` resolve via npm-workspace symlinks in node_modules + each
    // package's `exports` map (handles subpaths like @txresbench/framework/store-kit
    // + @txresbench/kit/styles/tokens.css). Only the app-local '@' alias is set here.
    alias: [
      { find: '@', replacement: srcDir },
    ],
  },
  server: {
    // Bind all interfaces by default so the dev server is reachable off-box
    // (shared dev box / container IP / SSH port-forward) WITHOUT needing a
    // `--host` flag on every launch. Vite otherwise defaults to localhost-only,
    // which is unreachable from anywhere but the box itself. Override with
    // `vite --host localhost` (or VITE_DEV_HOST) for a local-only bind.
    host: process.env.VITE_DEV_HOST || true,
    port: Number(process.env.VITE_DEV_PORT) || 5173,
    strictPort: true,
    // Allow ALL hosts by DEFAULT so the dev server is reachable through the workspace
    // reverse-proxy (`<port>--…--pbya.workspace.…`). Vite otherwise rejects the proxied
    // Host header with "Blocked request. This host is not allowed." This is a DEV/PREVIEW
    // server ONLY — production is served by the Rust backend, so this never ships — and it
    // sits behind a trusted proxy, so the host check is pure friction. Do NOT change the
    // default back to a blocklist: set VITE_ALLOWED_HOSTS to a comma-separated allowlist to
    // restrict it (or `all`, which equals the default).
    allowedHosts:
      !process.env.VITE_ALLOWED_HOSTS || process.env.VITE_ALLOWED_HOSTS === 'all'
        ? true
        : process.env.VITE_ALLOWED_HOSTS.split(',').map(h => h.trim()).filter(Boolean),
    proxy: {
      // Everything under /api is forwarded to the embedded TxResBench backend.
      '/api/': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3100/',
        changeOrigin: true,
        xfwd: true,
      },
    },
  },
  build: {
    // Emitted to src-app/ui/dist so the desktop Tauri bundle (frontendDist:
    // ../ui/dist) can pick it up.
    outDir: '../dist',
    emptyOutDir: true,
  },
  // `vite preview` serves the built bundle (no on-demand dep-optimize); mirror
  // the dev /api proxy so the previewed SPA reaches the backend.
  preview: {
    // Same all-interfaces + allow-all-host defaults as the dev server (see above).
    host: process.env.VITE_DEV_HOST || true,
    allowedHosts:
      !process.env.VITE_ALLOWED_HOSTS || process.env.VITE_ALLOWED_HOSTS === 'all'
        ? true
        : process.env.VITE_ALLOWED_HOSTS.split(',').map(h => h.trim()).filter(Boolean),
    port: 4173,
    strictPort: true,
    proxy: {
      '/api/': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3100/',
        changeOrigin: true,
        xfwd: true,
      },
    },
  },
})
