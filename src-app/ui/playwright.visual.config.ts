// The VISUAL (Layer-A) Playwright config `npm run gate:ui` drives
// (declarative-rendering-hardening Slice 3, ITEM-14).
//
// Why this file exists: `gate-ui.mjs`'s visual step has ALWAYS run
// `npx playwright test -c playwright.visual.config.ts …` — and this repo never had the
// config, so the step died with `playwright.visual.config.ts does not exist` and `gate:ui`
// could not pass for ANY feature (measured on `e5b4da29`; the baseline log is archived with
// this branch's lifecycle artifacts). INV-5 requires the declarative surfaces to run UNDER
// `gate:ui`, so making the step real is a precondition, not polish.
//
// Everything else comes from `gallery.config.json` (the same file the gate + generators
// read), including `visualTestDir` — so `GALLERY_PORT=<n> npm run gate:ui` works on a box
// where this worktree's derived port is already taken.
//
// THE PORT IS THE ONE THING THIS FILE OVERRIDES. `gallery.config.json` now sets
// `"port": null` ("derive per worktree"), and `defineVisualConfig`'s own fallback for an
// absent port is the historical fixed 1420 — which is the shared-mutable-resource bug this
// repo just paid for (a gate reusing a SIBLING worktree's :1420 server and auditing the
// wrong tree). `null` would additionally resolve to `Number(null) === 0`, i.e. a literal
// `http://localhost:0`. So resolve the SAME per-worktree key-derived base the gate uses and
// pass it explicitly. (Under `npm run gate:ui` the gate exports GALLERY_PORT with its own
// bind-verified port and that wins — this default only matters for a standalone
// `npm run test:e2e:visual`.)
//
// The spec list the gate runs is `gallery.config.json`'s `visualSpecs`. It currently names
// only the declarative Layer-A spec: enabling the generic gallery-wide `layout`/`states`/
// `overlays` template sweep at the same time would fold an unknown number of PRE-EXISTING,
// never-triaged findings into every future feature's gate (DEC-8). Broadening it is a
// deliberate follow-up, not something to slip in with a hardening branch.
// NOTE the explicit `.ts`: `@txresbench/gallery`'s `"./playwright/*"` export maps the subpath
// VERBATIM, so an extensionless specifier resolves to a non-existent file and Playwright dies
// with ERR_MODULE_NOT_FOUND before running a single spec.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolvedOnce } from './scripts/resolved-once.mjs'

import { defineVisualConfig } from '@txresbench/gallery/playwright/visual.config.ts'

// AND THE SAME REUSE DEFECT REACHES THIS CONFIG THROUGH THE SDK. `defineVisualConfig`
// hardcodes `reuseExistingServer: !process.env.CI` and does no sentinel check, so off
// CI this tier adopts anything answering 200 on the port — a sibling worktree's
// gallery, or a server another run of THIS tree owns and will kill on exit. That is
// the shape that cost three viz runs (`viz-full-2.log`: 132 failures in 10.6 min,
// every one `ERR_CONNECTION_REFUSED`, against a server that had been killed under it).
//
// `@txresbench/gallery` is a pinned SUBMODULE this repo does not own, so the fix is applied
// on THIS side of the boundary: the config it returns is spread and the two fields
// that matter are overridden. Reported upstream rather than edited in place.
//
// `gate:ui` exports its own bind-verified GALLERY_PORT and that still wins; this path
// matters for a standalone `npm run test:e2e:visual`.
// GALLERY_PORT set means `gate:ui` already booted a server it bind-verified and owns
// for the duration of this pass, and is handing it over. That is the ONE case where
// adopting a server this run did not start is legitimate — the owner outlives the
// adoptee — so reuse is allowed there and nowhere else. Standalone
// `npm run test:e2e:visual` boots its own.
const HANDED_OVER = !!process.env.GALLERY_PORT
const RESOLVER = fileURLToPath(new URL('./scripts/resolve-visual-port.mjs', import.meta.url))
// `resolvedOnce`: Playwright loads this config in the runner AND again in every
// worker, and a re-resolution would step over the server the runner just booted.
const VERDICT = resolvedOnce('visual_gallery', () =>
  JSON.parse(execFileSync('node', [RESOLVER], { encoding: 'utf8' }).trim()),
) as { port: number; reused: boolean }

const base = defineVisualConfig({ port: VERDICT.port })
const webServer = base.webServer as { url: string; reuseExistingServer?: boolean }

process.env.HARNESS_ORIGINS = JSON.stringify([
  { label: 'component gallery (visual)', port: VERDICT.port, url: webServer.url },
])

export default {
  ...base,
  // Proven before any spec, and re-proven the moment one fails at the connection
  // level. A proof taken once at config-load time cannot see the corpse case, which
  // is created after the run starts by definition.
  globalSetup: './scripts/harness-preflight.mjs',
  reporter: [
    ...(Array.isArray(base.reporter) ? base.reporter : [['list']]),
    ['./scripts/harness-watchdog-reporter.mjs'],
  ],
  // The SDK's `!process.env.CI` replaced by the resolver's verdict: two independent
  // decisions about one port are free to contradict, and `viz-full-3.log` is what
  // that looks like.
  webServer: { ...webServer, reuseExistingServer: VERDICT.reused && HANDED_OVER },
}
