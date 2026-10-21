#!/usr/bin/env node
/**
 * The port-resolution WALK, factored out of `resolve-viz-port.mjs` so every
 * backend-free tier gets the same refusals instead of each config inventing its own.
 *
 * `resolve-viz-port.mjs` documents the incident history and the rule; this is the
 * mechanism it (and now the gallery-e2e tier) share. The short version:
 *
 *   bindable now                     → take it, boot our own
 *   occupied, sentinel says US       → reuse ONLY if reuse was asked for; the server
 *                                      is this WORKTREE's, but its lifetime belongs
 *                                      to whichever RUN started it, and Playwright
 *                                      kills only servers it started
 *   occupied, anything else          → skip. Fail closed.
 *
 * `playwright.gallery.config.ts` had none of this: it took the key-derived BASE and
 * used it as the port, with no bind probe and no sentinel, under
 * `reuseExistingServer: !process.env.CI`. That is strictly weaker than the viz
 * config that still lost three runs — a base is only a search START, and ~150
 * worktrees over a 200-wide span collide by the pigeonhole principle (this box has
 * five trees deriving 21061 today). It would adopt anything answering 200.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  fnv1a8,
  isPortBindable,
  portBase,
  resolveWorktreeRoot,
  serverIsThisWorktree,
} from '@ziee/gallery/scripts/lib/run-key.mjs'

import { classifyOrigin, reuseRequested } from './harness-origin.mjs'

/**
 * Resolve one leg. Returns `{ port, reused, pinned }`.
 *
 * `allowReuse` defaults to FALSE — the whole point. A caller that genuinely wants
 * adoption (a human dev-server launcher) passes it explicitly.
 */
export async function resolveHarnessPort({
  floor,
  span,
  envVar,
  env = process.env,
  allowReuse = false,
  maxAttempts = 200,
  start: startOverride = null,
  ownRoot = resolveWorktreeRoot(),
  fetchImpl = fetch,
  /** Human name for the LEG (`vizShowcase`, `galleryE2e`) — used in errors. The
   *  env-var name is `envVar`; keeping them separate stops an error message from
   *  telling a user to set a leg name as if it were a variable. */
  label = envVar || `:${floor}`,
}) {
  const rootOf = async port => {
    const c = await classifyOrigin(port, { ownRoot, fetchImpl })
    return c.state === 'ours' ? ownRoot : c.root
  }

  const pinnedRaw = envVar ? Number(env[envVar]) : Number.NaN
  if (Number.isFinite(pinnedRaw) && pinnedRaw > 0) {
    const port = pinnedRaw | 0
    // A pin overrides the SEARCH, never the PROOF. Pinning is what a human does when
    // the box is busy — i.e. exactly when a stranger on that port is most likely.
    if (await isPortBindable(port)) return { port, reused: false, pinned: true }
    const root = await rootOf(port)
    if (allowReuse && serverIsThisWorktree(root, ownRoot)) return { port, reused: true, pinned: true }
    throw new Error(
      `${envVar}=${port} is pinned for ${label}, but that port is already held by ` +
        (serverIsThisWorktree(root, ownRoot)
          ? `another run of THIS worktree (${ownRoot}). It is not this run's server to use.`
          : `a server that cannot prove it belongs to ${ownRoot} (it reports ${root ?? '<no sentinel>'}).`) +
        ' Refusing to test against it — pin a different port, or unset the pin to auto-resolve.',
    )
  }

  const start = startOverride ?? portBase(fnv1a8(ownRoot), floor, span)
  for (let i = 0; i < maxAttempts; i++) {
    const port = ((start + i - 1) % 65535) + 1
    // eslint-disable-next-line no-await-in-loop
    if (await isPortBindable(port)) return { port, reused: false, pinned: false }
    if (allowReuse) {
      // eslint-disable-next-line no-await-in-loop
      const root = await rootOf(port)
      if (serverIsThisWorktree(root, ownRoot)) return { port, reused: true, pinned: false }
    }
  }
  throw new Error(
    `no usable ${label} port in ${maxAttempts} from ${start}: every candidate is occupied by a server ` +
      `that could not prove it belongs to ${ownRoot}, or by another run of it. ` +
      `Set ${envVar}=<port> to pin one.`,
  )
}

/** The gallery-e2e leg. Same `webE2eVite` floor `playwright.gallery.config.ts`
 *  already used — disjoint from `webGallery`, which `gate:ui` + the visual config
 *  derive from, so the two can run back to back in one tree. */
export const GALLERY_E2E_BAND = {
  floor: 9000,
  span: 200,
  envVar: 'GALLERY_E2E_PORT',
  /** The tier-local reuse opt-in, ANDed with the repo-wide `HARNESS_REUSE_SERVER`. */
  reuseEnv: 'GALLERY_REUSE_SERVER',
  label: 'galleryE2e',
}

/**
 * The FULL-BACKEND tier's two legs (`playwright.config.ts`).
 *
 * That config was reported and NOT fixed by the change that built this module: it
 * carried the fixed literals `3155`/`4173`, so two runs collided BY CONSTRUCTION —
 * not by an unlucky hash, the way a derived port can, but always. Both legs now walk
 * this same bind-verified, sentinel-proved search.
 *
 * DISJOINT FLOORS, and each is disjoint from `galleryE2e` above AND from every band in
 * `run-key.mjs::PORT_FLOORS`: the tiers are routinely run back to back in one tree
 * (`just e2e-all`), and a shared floor recreates the collision INSIDE a single
 * worktree — which is the failure mode the whole mechanism exists for.
 *
 * The obvious pick, `PORT_FLOORS.webE2eBackend` (9100), is WRONG and the disjointness
 * test caught it: that table's own `webE2eVite` is `9000 + 200`, so 9100 sits inside
 * it, and `galleryE2e` derives from `webE2eVite`. Reusing the "reserved" floor would
 * have put this tier's backend inside the gallery tier's span — a collision written
 * into the table itself. 9800/10000 are outside every entry (`desktopE2eBackend` is
 * 9600 + 200, so 9800 starts exactly where it ends).
 *
 * The pin names are the two knobs the justfile already documents for isolating a run
 * on a shared box (`E2E_BACKEND_PORT` / `E2E_APP_PORT`), so they keep working — but
 * now a pin overrides the SEARCH and never the PROOF.
 */
export const APP_E2E_BACKEND_BAND = {
  floor: 9800,
  span: 200,
  envVar: 'E2E_BACKEND_PORT',
  reuseEnv: 'E2E_REUSE',
  label: 'appE2eBackend',
}

export const APP_E2E_PREVIEW_BAND = {
  floor: 10000,
  span: 200,
  envVar: 'E2E_APP_PORT',
  reuseEnv: 'E2E_REUSE',
  label: 'appE2ePreview',
}

/** Every named leg this resolver can be asked for, by its `label`. */
export const BANDS = {
  [GALLERY_E2E_BAND.label]: GALLERY_E2E_BAND,
  [APP_E2E_BACKEND_BAND.label]: APP_E2E_BACKEND_BAND,
  [APP_E2E_PREVIEW_BAND.label]: APP_E2E_PREVIEW_BAND,
}

/**
 * Resolve a NAMED set of legs in ONE process, returning `{ [label]: verdict }`.
 *
 * One process for the whole set is deliberate. A config that shelled out once per leg
 * would take two independent snapshots of a box that is changing underneath it, and a
 * multi-leg tier has to publish ONE consistent answer to its pre-flight, its
 * `reuseExistingServer` verdicts, its derived database name and its `baseURL`.
 */
export async function resolveBands(labels, { env = process.env, ...rest } = {}) {
  const out = {}
  for (const label of labels) {
    const band = BANDS[label]
    if (!band) {
      throw new Error(
        `unknown harness band '${label}'. Known: ${Object.keys(BANDS).join(', ')}. ` +
          'A typo must not silently resolve nothing — a leg with no port would be booted ' +
          'on whatever the config defaulted to, which is the defect this replaces.',
      )
    }
    // eslint-disable-next-line no-await-in-loop
    out[label] = await resolveHarnessPort({
      ...band,
      env,
      allowReuse: reuseRequested(env, band.reuseEnv),
      ...rest,
    })
  }
  return out
}

// Path-equality, not a basename match: a basename comparison would treat any other
// file of this name on the box as "this module", and importing must never resolve a
// port as a side effect.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  // No args → the gallery leg, emitted as a BARE verdict (the shape
  // `playwright.gallery.config.ts` already parses). With args → a keyed map.
  const labels = process.argv.slice(2).filter(Boolean)
  const job = labels.length
    ? resolveBands(labels)
    : resolveHarnessPort({
        ...GALLERY_E2E_BAND,
        env: process.env,
        allowReuse: reuseRequested(process.env, GALLERY_E2E_BAND.reuseEnv),
      })
  job
    .then(v => process.stdout.write(JSON.stringify(v)))
    .catch(e => {
      process.stderr.write(`resolve-harness-port: ${e.message}\n`)
      process.exit(2)
    })
}
