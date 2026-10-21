#!/usr/bin/env node
/**
 * `npm run gallery` — boot THIS worktree's component-gallery Vite server on a
 * PER-WORKTREE, bind-verified port.
 *
 * WHY THIS EXISTS
 * ---------------
 * The script used to be the literal string `vite --port 1420 --strictPort`, and
 * `gallery.config.json` pinned the same 1420. On a box with ~100 concurrent git
 * worktrees that is ONE shared mutable resource: whichever worktree booted first
 * owns :1420, and every gate in every other worktree then either fails to bind or
 * — worse — silently REUSES that foreign server and audits the wrong source tree.
 * Measured pre-fix: `just preland-frontend` on a byte-identical clean `origin/main`
 * reported 90 failing surfaces / 21,065 findings, none of which existed in the tree
 * being gated.
 *
 * The port now comes from the unified run key (`@ziee/gallery/scripts/lib/run-key`,
 * the Node twin of the Rust worktree-db key): `webGallery` floor 20000 + (key % 200),
 * then the first OS-bindable port at/after that base across the WHOLE dual stack
 * (0.0.0.0 + ::1 + 127.0.0.1 — an IPv6-only probe miss is what produced the
 * ERR_NETWORK_CHANGED storms). `GALLERY_PORT=<n>` still overrides for a pinned run.
 *
 * The URL is printed on one line so a human can paste it; the gates do NOT parse
 * this output — they resolve the same key themselves.
 */
import { spawn } from 'node:child_process'
import {
  pickBindablePort,
  resolveGalleryPort,
  worktreeKey,
} from '@ziee/gallery/scripts/lib/run-key.mjs'

const base = resolveGalleryPort({ env: process.env.GALLERY_PORT, cfgPort: null })
const port = await pickBindablePort(base)

console.log(
  `[gallery] worktree key ${worktreeKey()} → port base ${base} → bound :${port}\n` +
    `[gallery] http://localhost:${port}/gallery.html`,
)

// --strictPort so a race that steals the port between the bind probe and vite's
// own listen FAILS LOUDLY instead of silently landing on a different port than
// the one just announced.
const child = spawn(
  'npx',
  ['vite', '--port', String(port), '--strictPort', ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
child.on('exit', code => process.exit(code ?? 0))
