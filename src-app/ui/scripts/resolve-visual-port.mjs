#!/usr/bin/env node
/**
 * The VISUAL tier's origin, resolved with the same refusals as the viz and
 * gallery-e2e tiers. Prints `{port, reused}` as JSON.
 *
 * Split out of `playwright.visual.config.ts` for one reason: a Playwright config is
 * loaded synchronously (its esbuild-CJS transform has no top-level await) while
 * bind-probing and sentinel-fetching are inherently async, so the resolution has to
 * happen in a child process.
 *
 * REUSE IS ALLOWED HERE ONLY UNDER `GALLERY_PORT`, which is `gate-ui.mjs`'s
 * hand-over: the gate boots a server it bind-verified and keeps it alive for the
 * whole pass, so the owner outlives the adopter. That is the property that was
 * missing everywhere else — `viz-full-2.log` was an adopter outliving its owner (the
 * owning run exited, Playwright killed the server it had started, and the adopter
 * reported 132 `ERR_CONNECTION_REFUSED` over 10.6 minutes). Without the hand-over,
 * an occupied port is stepped over, even when the sentinel proves it is this tree's.
 */
import { PORT_FLOORS } from '@ziee/gallery/scripts/lib/run-key.mjs'

import { reuseRequested } from './harness-origin.mjs'
import { resolveHarnessPort } from './resolve-harness-port.mjs'

const handedOver = !!process.env.GALLERY_PORT
const { floor, span } = PORT_FLOORS.webGallery

resolveHarnessPort({
  floor,
  span,
  envVar: 'GALLERY_PORT',
  label: 'visualGallery',
  env: process.env,
  allowReuse: handedOver || reuseRequested(process.env, 'GALLERY_REUSE_SERVER'),
})
  .then(({ port, reused }) => process.stdout.write(JSON.stringify({ port, reused })))
  .catch(e => {
    process.stderr.write(`resolve-visual-port: ${e.message}\n`)
    process.exit(2)
  })
