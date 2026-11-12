#!/usr/bin/env node
/**
 * Per-worktree port resolution for the `@txresbench/viz` showcase origins — the SAME
 * mechanism `playwright.gallery.config.ts` / `gate-ui.mjs` already use, adopted
 * for the viz tier.
 *
 * ## The defect
 *
 * `playwright.viz.config.ts` pinned :1421 (dev showcase) and :1422 (prod bench),
 * with `reuseExistingServer: !process.env.CI`. Two worktrees running the viz tier
 * on this box therefore raced for one port, and the loser did NOT fail loudly —
 * Playwright saw the URL already answering and REUSED the sibling's server, so
 * the run audited a different source tree while reporting on this one. That is
 * the same collision class already fixed for the gallery in `086d45a5`, where it
 * produced 9,355 `ERR_NETWORK_CHANGED` findings and a gate attributing a sibling
 * worktree's console errors to this tree as 216 failures. The config's own
 * comment ("a stale :1421 vite from a prior run would silently validate the WRONG
 * @txresbench/viz build and blind the merge gate") describes the bug precisely and then
 * only guards the CI half of it; `reuseExistingServer: !CI` is exactly the half
 * that makes a local collision SILENT rather than loud.
 *
 * ## Why THAT fix was not enough either — and what changed here
 *
 * With the derivation and the sentinel both in place, two more runs died:
 * `viz-full-2.log` (132 failed / 15 passed in 10.6 min, every failure
 * `ERR_CONNECTION_REFUSED at :21000`) and `viz-full-3.log`
 * (`http://localhost:21400/viz-showcase.html is already used`).
 *
 * :21000 and :21400 are the two viz FLOORS exactly — what a key with
 * `key % 200 === 0` derives, which on this box is exactly ONE worktree
 * (`tmp/viz-finish-wt`). So both runs came from the SAME tree: two agents running
 * the tier concurrently in one worktree.
 *
 * For that case, deriving the port per worktree does not merely fail to help — it
 * GUARANTEES the collision. Both runs derive the same number by construction; the
 * sentinel is then asked "does this server belong to this worktree?" and TRUTHFULLY
 * answers yes to both. The sentinel proves WORKTREE identity, but what is being
 * shared is a SERVER PROCESS whose lifetime belongs to exactly one run — Playwright
 * kills only servers it started. The owning run finished, killed it, and the
 * adopting run narrated the corpse for ten minutes.
 *
 * Hence: **reuse is now OPT-IN** (`VIZ_REUSE_SERVER=1`). By default an occupied
 * port is skipped even when it IS provably ours, and the run boots its own server on
 * the next free port. Two concurrent runs in one tree become disjoint by
 * construction, which is the property the per-worktree key was reaching for and
 * could not deliver, because the unit of contention is a run, not a tree.
 *
 * ## The rule
 *
 * A viz run may only ever talk to a server it can PROVE belongs to this worktree,
 * AND (unless reuse is explicitly requested) only to one it started itself.
 * Per candidate port, in order from the key-derived base:
 *
 *   * bindable right now              → take it (we will boot our own server);
 *   * occupied, sentinel says US      → reuse ONLY with `VIZ_REUSE_SERVER=1`;
 *                                       otherwise SKIP — it is this worktree's, but
 *                                       it is not THIS RUN's, and its owner may end
 *                                       it at any moment;
 *   * occupied, sentinel says OTHER   → skip;
 *   * occupied, no/unparseable sentinel → skip (FAIL CLOSED — an unidentifiable
 *                                        server is treated as foreign, never as
 *                                        ours; "probably mine" is what the fixed
 *                                        port already assumed and got wrong).
 *
 * The returned `reused` flag is what the Playwright config passes to
 * `reuseExistingServer`, so the resolver's verdict and Playwright's policy are ONE
 * decision instead of two independent ones. `reuseExistingServer: !process.env.CI`
 * was the second decision, and `viz-full-3` is what it looks like when the two
 * contradict: the resolver returned a port valid only if reused, and the config
 * refused to reuse it.
 *
 * Bindability is checked across the whole dual stack (0.0.0.0 + ::1 + 127.0.0.1)
 * by `run-key.mjs::isPortBindable` — an IPv4-only probe is what let a sibling
 * holding `::1:PORT` read as free while the browser, resolving `localhost` to
 * `::1` first, pulled modules from the FOREIGN worktree.
 *
 * The sentinel is `gallerySentinelPlugin()` on the viz package's vite config; it
 * answers `/__worktree` in dev AND preview (`apply: 'serve'` covers both), so the
 * dev showcase and the prod bench are both identifiable.
 *
 * ## Floors
 *
 * `PORT_FLOORS` lives in the SDK and this repo does not own it, so the two viz
 * floors are declared here and are deliberately DISJOINT from every SDK floor
 * (webGallery 20000, desktopGallery 22000, webE2eVite 9000, webE2eBackend 9100,
 * desktopE2eBackend 9600, and the 543xx/546xx Postgres bands) — and from each
 * other, so a single worktree can run the dev leg and the bench leg at once,
 * which the ms-leg project does.
 *
 * Usage (CLI, prints one integer):
 *   node scripts/resolve-viz-port.mjs dev
 *   node scripts/resolve-viz-port.mjs bench
 * `VIZ_E2E_PORT` / `VIZ_BENCH_PORT` pin a one-off and skip resolution entirely.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { reuseRequested } from './harness-origin.mjs'
import { resolveHarnessPort } from './resolve-harness-port.mjs'

/** Viz-tier port floors. Span 200 each, disjoint from every SDK floor and from
 *  each other. Named here (never an inline literal) so they retune in one place. */
export const VIZ_PORT_FLOORS = {
  /** the dev showcase origin (`vite`, was the fixed :1421) */
  vizShowcase: { floor: 21000, span: 200 },
  /** the PROD BENCH origin (`vite preview` over dist-bench, was the fixed :1422) */
  vizBench: { floor: 21400, span: 200 },
}

/** The env var that pins each leg, so a one-off run can bypass resolution. */
export const VIZ_PORT_ENV = { vizShowcase: 'VIZ_E2E_PORT', vizBench: 'VIZ_BENCH_PORT' }

/**
 * NOTE — `sentinelRootsAgree` USED TO LIVE HERE. It asked both localhost families
 * for `/__worktree` and required them to agree, returning a root or null. It has
 * been replaced by `harness-origin.mjs::classifyOrigin`, which asks the same two
 * families but returns WHICH of the failure modes occurred (`absent` /
 * `unidentified` / `foreign` / `split`) instead of collapsing all of them to
 * `null`. That distinction is not cosmetic: `absent` is the corpse case and means
 * "your server died", `unidentified` means "someone else is on your port", and a
 * banner that cannot tell a user which one happened sends them to read a diff.
 * Keeping both would have left two probes to drift apart.
 */

/**
 * Resolve the port for one viz leg. Returns `{ port, reused }`.
 *
 * `reused: true` means a server we PROVED is ours is already listening, so
 * Playwright's `reuseExistingServer` will adopt it. `reused: false` means the
 * port is bindable and we will boot our own with `--strictPort`.
 *
 * `start` overrides the derived search start. It exists for the TESTS, and it
 * exists because the first version of them did not have it and was wrong in the
 * same way item 2's defect was wrong: they occupied the DERIVED base to stage the
 * "foreign server" case, which meant they failed with `EADDRINUSE` the moment this
 * worktree's own showcase was up — i.e. exactly when someone would be running them.
 * A test that stages an occupancy must own the port it occupies.
 */
export async function resolveVizPort(
  which,
  {
    env = process.env,
    maxAttempts = 200,
    start: startOverride = null,
    // Adopting a server this run did not start is opt-in, because "this worktree's
    // server" and "this run's server" are different things and only the second is
    // safe. `viz-showcase.mjs` (the human dev-server launcher, whose whole job is
    // "don't boot a second one") passes true explicitly.
    allowReuse = reuseRequested(env, 'VIZ_REUSE_SERVER'),
  } = {},
) {
  // The WALK itself is `resolve-harness-port.mjs` — shared with the gallery-e2e
  // tier, which had none of these refusals. One implementation, so a rule added for
  // one tier cannot quietly fail to reach the other; this file keeps the viz BANDS
  // and the incident history.
  const { floor, span } = VIZ_PORT_FLOORS[which]
  return resolveHarnessPort({
    floor,
    span,
    envVar: VIZ_PORT_ENV[which],
    env,
    allowReuse,
    maxAttempts,
    start: startOverride,
    label: which,
  })
}

// Path-equality, not a basename match — the form `serve-bench.mjs` settled on. A
// basename comparison would treat any *other* `resolve-viz-port.mjs` on the box as
// "this module", and — the case that matters — an importer whose own filename merely
// ENDED with this one's would flip it. Importing this module must never resolve a port
// as a side effect: `viz-showcase.mjs` imports it and then decides what to do.
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const which = process.argv[2] === 'bench' ? 'vizBench' : 'vizShowcase'
  // `--json` prints the WHOLE verdict, not just the integer. The Playwright config
  // needs `reused` as well as `port`: throwing the reuse decision away and
  // recomputing it as `!process.env.CI` is what let the two contradict.
  const asJson = process.argv.includes('--json')
  resolveVizPort(which)
    .then(({ port, reused, pinned }) => {
      process.stdout.write(asJson ? JSON.stringify({ port, reused, pinned }) : String(port))
    })
    .catch(e => {
      process.stderr.write(`${e.message}\n`)
      process.exit(2)
    })
}
