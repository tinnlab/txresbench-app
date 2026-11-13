#!/usr/bin/env node
/**
 * preland-frontend-health.mjs — a TXRESBENCH-LOCAL, diff-triggered FRONTEND merge gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * A console error on every first-open workbench render landed on `main` and then
 * survived FIVE subsequent landings, because nothing in the landing path ever
 * renders the frontend. The shared agent-kit `merge-gate.mjs` gates the backend
 * (C1 cargo, C3 openapi-regen parity, C5 lifecycle-strip) and knows nothing about
 * browser runtime health. This script closes that hole cheaply.
 *
 * WHY NOT WIRE `npm run gate:ui` INTO agent-kit's merge-gate (the obvious fix)
 * ---------------------------------------------------------------------------
 *   1. `merge-gate.mjs` lives in the `agent-kit` SUBMODULE (shared with txresbench) —
 *      editing it needs a push there + a gitlink bump here.
 *   2. The gate stages the candidate merge into a `git worktree add` tree that
 *      holds TRACKED FILES ONLY — no `node_modules`, no Playwright browsers. A
 *      frontend pass there needs a full `npm install` + `npx playwright install`
 *      + a booted Vite server (~13 min) before it can render anything.
 *      >> THIS IS THE ONE THAT STILL DISQUALIFIES IT. <<
 *   3. (RESOLVED at origin/main 4a9a6503.) `gate:ui` used to ALWAYS exit non-zero
 *      on `main` because its `visual` step needs `playwright.visual.config.ts`,
 *      which was unlanded. `feat/declarative-rendering-hardening` landed it;
 *      `npm run gate:ui` was verified exit 0 (tsc/lint/runtime/visual, 84/84
 *      surfaces) on 4a9a6503.
 *
 * SO: this runs on the BRANCH WORKTREE (where `node_modules` already exists),
 * before the land, and by default invokes ONLY the runtime-health pass — the
 * cheapest thing that catches the regression class, with no overlap with
 * `just check` (which already covers tsc + lint + unit). Pass `--gate-ui` for the
 * full four-criteria `npm run gate:ui` now that its visual step works.
 *
 * TRIGGER
 * -------
 * Runs only when the diff vs the base (default `origin/main`) touches a frontend
 * path: `src-app/ui/` (the processor-package UI arm was removed with the
 * processor package tree; the libs arm with the viz/dock libs, strip node
 * ITEM-2/4). A backend-only branch SKIPS entirely and costs nothing.
 *
 * FOLLOW-UP (recorded, NOT implemented)
 * -------------------------------------
 * The durable form is an optional `MERGE_FRONTEND_GATE_CMD` + `MERGE_FRONTEND_GATE_DIR`
 * pair read from `.claude/app.config` as a new `gateC6` in agent-kit's
 * `merge-gate.mjs` — which fits its existing "every key is OPTIONAL; an unset key
 * SKIPS its gate" design, so txresbench is unaffected until it opts in. Blocker 3 is
 * gone; that leaves blocker 2 — the staging tree still needs `npm install` +
 * Playwright browsers provisioned before any gate there can render a page.
 *
 * THE FIXED-PORT / FOREIGN-REUSE DEFECT THIS SCRIPT USED TO HAVE
 * -------------------------------------------------------------
 * It defaulted to the SHARED port 1420 and reused whatever answered there:
 *
 *     if (await galleryUp()) { console.log('reusing server already on :1420'); return }
 *
 * On a box running ~100 concurrent git worktrees, "whatever answered there" is
 * almost never your own server. Measured on this branch, on a worktree
 * byte-identical to a clean `origin/main` that had just passed 88/88 surfaces
 * with 0 gating HIGH findings on a quiet port:
 *
 *   run A (a sibling worktree's gallery up on :1420)
 *     → "reusing server already on :1420", 90 failing surfaces, 216 gating HIGH,
 *       ALL 216 being a `console.error` marker that exists ONLY in the sibling
 *       worktree's source. The gate audited the wrong tree.
 *   run B (same, plus the sibling's owner editing their files, i.e. HMR churn)
 *     → same command, same code: 21,065 findings, 287 gating HIGH, 71 of them
 *       `request-failed` aborts. A different verdict from run A on identical input.
 *
 * That is the whole "the frontend gate is unusable" symptom: enormous
 * ERR_NETWORK_CHANGED / ERR_ABORTED counts and a failing-surface set that changes
 * between runs of the same code. It was never a UI regression.
 *
 * THE FIX (two halves — a source change alone would not have held)
 *   1. NO FIXED PORT. `gallery.config.json` sets `"port": null`, so the port comes
 *      from the unified per-worktree run key (`@txresbench/gallery/scripts/lib/run-key`),
 *      then the first port bindable across the whole dual stack (0.0.0.0 + ::1 +
 *      127.0.0.1 — an IPv4-only probe is how two vite servers once landed on ONE
 *      port and produced the ERR_NETWORK_CHANGED storm).
 *   2. NO UNVERIFIED REUSE. A server we did not start is reused ONLY if it PROVES
 *      it is serving this worktree: `vite.config.ts` registers
 *      `gallerySentinelPlugin()`, which answers `/__worktree` with the server's own
 *      worktree root, and this script compares it to ours. Foreign root, missing
 *      sentinel, unparseable answer — all mean "not provably ours" and we boot our
 *      own on a fresh port instead. And whatever we end up auditing, ours or not,
 *      the sentinel is re-checked immediately before the pass runs; if it cannot be
 *      proven at that moment the run FAILS CLOSED (exit 2) rather than reporting a
 *      verdict about someone else's tree.
 *
 * USAGE
 *   node scripts/preland-frontend-health.mjs [--base <ref>] [--port <n>]
 *                                            [--force] [--report-only]
 *                                            [--dry-run] [--gate-ui]
 *   just preland-frontend            # same, base=origin/main, port auto-derived
 *   just preland-frontend 1487       # pin a port (args POSITIONAL)
 *
 *   --base <ref>    base to diff against (default: origin/main)
 *   --port <n>      gallery Vite port. Default: $GALLERY_PORT, else the `port` in
 *                   src-app/ui/gallery.config.json, else the PER-WORKTREE
 *                   key-derived base. You no longer need to pass your own port
 *                   when several worktrees run at once — that is now the default
 *                   behaviour — and even an explicitly pinned port is never reused
 *                   without the sentinel proving it is ours.
 *   --force         run even when the diff touches no frontend path
 *   --report-only   print the table but always exit 0 (triage, not a gate)
 *   --dry-run       print the RUN/SKIP trigger decision and exit 0 — renders
 *                   nothing (use to check whether your diff would be gated)
 *   --gate-ui       run the FULL `gate:ui` (tsc + lint + runtime + visual)
 *                   instead of runtime-health alone
 *
 * EXIT 0 = frontend runtime-clean (or skipped); 1 = a surface has HIGH findings;
 *        2 = the pass itself could not run (no server, missing deps, …).
 *
 * RUN IT ON A QUIESCENT WORKTREE. It drives a Vite DEV server: editing (or
 * `git checkout`-ing) any source file while the pass is in flight triggers an HMR
 * invalidation that ABORTS the in-flight module requests, and every abort is
 * recorded as a `request-failed` HIGH. That is a self-inflicted false FAIL, not a
 * regression — don't touch the tree until it prints its RESULT line.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  fetchSentinelRoot,
  pickBindablePort,
  resolveGalleryPort,
  resolveWorktreeRoot,
  serverIsThisWorktree,
  worktreeKey,
} from '@txresbench/gallery/scripts/lib/run-key.mjs'

import { reuseRequested } from '../src-app/ui/scripts/harness-origin.mjs'

/** Adopting a server this run did not start is opt-in here for the same reason it is
 *  in the Playwright tiers: the server dies with the run that started it. */
const REUSE_REQUESTED = reuseRequested(process.env, 'GALLERY_REUSE_SERVER')

// ── args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (n, d) => {
  const eq = argv.find(a => a.startsWith(`--${n}=`))
  if (eq) return eq.slice(n.length + 3)
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const flag = n => argv.includes(`--${n}`)

const BASE = arg('base', 'origin/main')
const FORCE = flag('force')
const REPORT_ONLY = flag('report-only')
const DRY_RUN = flag('dry-run') // evaluate the trigger + exit; never boots a browser
const GATE_UI = flag('gate-ui') // full gate:ui instead of runtime-health alone

// ── anchors ────────────────────────────────────────────────────────────────
const git = (args, opts = {}) =>
  spawnSync('git', args, { encoding: 'utf8', ...opts })

const top = git(['rev-parse', '--show-toplevel'])
if (top.status !== 0) {
  console.error('preland-frontend-health: not in a git repo')
  process.exit(2)
}
const REPO = top.stdout.trim()
const UI_DIR = path.join(REPO, 'src-app/ui')
// Anchor on the app's gallery.config.json (the same file @txresbench/gallery reads) so
// the dir/URL/port never drift from the pass this script drives.
// NOTE the `port: null` default — "derive per worktree", NOT the historical fixed
// 1420. A default that is a real port number is a shared mutable resource on a
// multi-worktree box, which is the whole defect documented in the header.
let GCFG = { galleryDir: 'src/dev/gallery', galleryUrl: '/gallery.html', port: null }
const GCFG_PATH = path.join(UI_DIR, 'gallery.config.json')
if (fs.existsSync(GCFG_PATH)) {
  try {
    GCFG = { ...GCFG, ...JSON.parse(fs.readFileSync(GCFG_PATH, 'utf8')) }
  } catch (e) {
    console.error(`preland-frontend-health: cannot parse ${GCFG_PATH}: ${e.message}`)
    process.exit(2)
  }
}
// The per-worktree identity every port decision hangs off. `OWN_ROOT` is what the
// gallery server's `/__worktree` sentinel must echo back for a reuse to be legal.
const OWN_ROOT = resolveWorktreeRoot(REPO)
const OWN_KEY = worktreeKey(REPO)

// Precedence (run-key.mjs::resolveGalleryPort): explicit --port > $GALLERY_PORT >
// gallery.config.json `port` > key-derived per-worktree base. This is only the
// SEARCH START — the port actually used is decided in bootGallery(), which
// bind-verifies it and refuses to squat on a foreign server.
const PORT_EXPLICIT = arg('port', null)
const PORT_BASE = resolveGalleryPort({
  env: PORT_EXPLICIT ?? process.env.GALLERY_PORT,
  cfgPort: GCFG.port ?? null,
  which: GCFG.portWhich || 'webGallery',
  cwd: REPO,
})
// `PORT` is finalized in bootGallery(); everything downstream reads it AFTER that.
let PORT = PORT_BASE
// Fail FAST on a garbage port. Without this a typo (e.g. `just preland-frontend
// PORT=1487`, which just passes through as the literal string "PORT=1487") makes
// PORT NaN and the script spends 180s "waiting" for a server on `:NaN`.
if (!Number.isInteger(PORT_BASE) || PORT_BASE < 1 || PORT_BASE > 65535) {
  console.error(
    `preland-frontend-health: invalid port "${PORT_EXPLICIT ?? process.env.GALLERY_PORT}" — ` +
      `pass an integer 1-65535 (just recipe args are POSITIONAL: \`just preland-frontend 1487\`).`,
  )
  process.exit(2)
}
const GALLERY_DIR = path.join(UI_DIR, GCFG.galleryDir)
const GALLERY_SCRIPTS = path.join(REPO, 'node_modules/@txresbench/gallery/scripts')
const PASS_SCRIPT = path.join(
  GALLERY_SCRIPTS,
  GATE_UI ? 'gate-ui.mjs' : 'runtime-health.mjs',
)
const PASS_NAME = GATE_UI ? 'gate:ui' : 'runtime-health'

console.log(`== preland-frontend-health (base ${BASE}, repo ${REPO}) ==`)

// ── 1. TRIGGER: does the diff touch the frontend? ──────────────────────────
/** Frontend paths whose change can produce a browser runtime regression. */
const FRONTEND_PATTERNS = [
  /^src-app\/ui\//,
]

function changedFiles() {
  const files = new Set()
  // Every git call is rooted at REPO so `just`/a subdir cwd can't skew the paths.
  const at = { cwd: REPO }
  // Committed branch work: merge-base..HEAD (the real surface — never HEAD..base).
  const mb = git(['merge-base', BASE, 'HEAD'], at)
  if (mb.status === 0 && mb.stdout.trim()) {
    const d = git(['diff', '--name-only', `${mb.stdout.trim()}`, 'HEAD'], at)
    if (d.status === 0)
      for (const f of d.stdout.split('\n')) if (f.trim()) files.add(f.trim())
  } else {
    console.log(`  ! no merge-base for ${BASE}..HEAD — falling back to worktree state`)
  }
  // Uncommitted work counts too: a pre-land check must see what you're about to
  // commit, not just what you already did. (Porcelain paths are repo-root-relative.)
  const st = git(['status', '--porcelain'], at)
  if (st.status === 0)
    for (const line of st.stdout.split('\n')) {
      const p = line.slice(3).trim()
      if (!p) continue
      // `R  old -> new` — take the destination.
      files.add(p.includes(' -> ') ? p.split(' -> ')[1] : p)
    }
  return [...files]
}

const changed = changedFiles()
const feTouched = changed.filter(f => FRONTEND_PATTERNS.some(re => re.test(f)))

if (!feTouched.length && !FORCE) {
  console.log(
    `  SKIP  trigger        ${changed.length} changed file(s), none under ` +
      `src-app/ui/ — backend-only diff.`,
  )
  console.log('== RESULT: SKIP (no frontend surface in this diff) ==')
  process.exit(0)
}
console.log(
  `  RUN   trigger        ${feTouched.length} frontend file(s) changed` +
    (FORCE && !feTouched.length ? ' (none — forced with --force)' : ''),
)
for (const f of feTouched.slice(0, 10)) console.log(`          ${f}`)
if (feTouched.length > 10) console.log(`          … +${feTouched.length - 10} more`)

if (DRY_RUN) {
  console.log('== RESULT: WOULD-RUN (--dry-run: trigger only, nothing rendered) ==')
  process.exit(0)
}

// ── 2. preconditions ───────────────────────────────────────────────────────
if (!fs.existsSync(PASS_SCRIPT)) {
  console.error(
    `  FAIL  deps           ${path.relative(REPO, PASS_SCRIPT)} missing — run \`npm install\` at the repo root.`,
  )
  process.exit(2)
}

// ── 3. boot (or reuse) the gallery Vite server ─────────────────────────────
//
// THE INVARIANT: the server this gate audits must be OUR server, serving OUR
// worktree. It is asserted against the RUNNING SERVER'S OWN ANSWER (`/__worktree`,
// served by `gallerySentinelPlugin` in `src-app/ui/vite.config.ts`), never inferred
// from "something replied on the port I expected" — that inference is exactly what
// made this gate report 90 failing surfaces for a sibling worktree's code.
const galleryUp = async port => {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 2000)
    const r = await fetch(`http://localhost:${port}${GCFG.galleryUrl}`, {
      signal: ac.signal,
    })
    clearTimeout(t)
    return r.ok
  } catch {
    return false
  }
}

/** null = provably ours · string = a foreign/unprovable server's reported root or
 *  the literal '<no sentinel>' · undefined = nothing is listening at all. */
async function occupantOf(port) {
  if (!(await galleryUp(port))) return undefined
  const root = await fetchSentinelRoot(port)
  if (serverIsThisWorktree(root, OWN_ROOT)) return null
  return root || '<no sentinel — an old server, or a vite.config without gallerySentinelPlugin>'
}

let vite = null
async function bootGallery() {
  const occupant = await occupantOf(PORT_BASE)

  // `occupant === null` means the sentinel PROVED this worktree. That was treated as
  // sufficient to reuse, and it is not: it proves the server belongs to this TREE,
  // while its lifetime belongs to whichever RUN started it. Two preland passes (or a
  // preland pass and a viz/gallery run) in one worktree therefore shared one server,
  // and the first to finish took it down under the other — which is exactly how
  // `viz-full-2.log` produced 132 `ERR_CONNECTION_REFUSED` in 10.6 minutes and looked
  // like a code regression. Here the same corpse would surface as a page of
  // request-failed / console-error findings attributed to the diff under review.
  //
  // So reuse is OPT-IN (`HARNESS_REUSE_SERVER=1`), matching the Playwright tiers.
  // Without it, an occupied port is stepped over even when it is ours, and this pass
  // boots a server it owns for its own lifetime.
  if (occupant === null && REUSE_REQUESTED) {
    PORT = PORT_BASE
    console.log(
      `  OK    gallery        reusing THIS worktree's server on :${PORT} ` +
        `(sentinel verified: ${OWN_ROOT}; HARNESS_REUSE_SERVER=1)`,
    )
    return true
  }

  if (occupant === null) {
    console.log(
      `  !     gallery        :${PORT_BASE} holds a server of THIS worktree that belongs to\n` +
        '                       ANOTHER RUN. It would die with that run, mid-pass.\n' +
        '                       Stepping aside to a free port (HARNESS_REUSE_SERVER=1 to adopt it).',
    )
  }

  if (occupant !== undefined) {
    // NOT ours, or not provably ours. Do NOT reuse and do NOT try to bind over it
    // (--strictPort would just fail, and a non-strict bind would land somewhere we
    // never announced). Step aside to a port nobody holds.
    console.log(
      `  !     gallery        :${PORT_BASE} holds a server that is NOT this worktree's\n` +
        `                       reported root: ${occupant}\n` +
        `                       ours:          ${OWN_ROOT}\n` +
        `                       REFUSING to reuse it — booting our own on a free port`,
    )
  }

  PORT = await pickBindablePort(PORT_BASE)
  console.log(
    `  ..    gallery        booting vite on :${PORT} (worktree key ${OWN_KEY}, base ${PORT_BASE}) …`,
  )
  vite = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    cwd: UI_DIR,
    stdio: 'ignore',
    // Own process group so the whole vite tree dies with us, not just `npm`.
    detached: true,
  })
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (await galleryUp(PORT)) {
      console.log(`  OK    gallery        up on :${PORT}`)
      return true
    }
    if (vite.exitCode !== null) break
    await new Promise(r => setTimeout(r, 500))
  }
  console.error(`  FAIL  gallery        did not come up on :${PORT} within 180s`)
  return false
}

/**
 * The FAIL-CLOSED re-check, run immediately before the pass and after the boot
 * settled. Two things it catches that the boot decision cannot:
 *   - a race: someone else grabbed the port between our bind probe and vite's listen
 *     (--strictPort makes vite die, but the port may now answer as SOMEONE ELSE);
 *   - a `vite.config.ts` that lost `gallerySentinelPlugin()`, which would silently
 *     return this gate to "reuse anything that answers".
 * Unprovable ⇒ refuse to render. A gate that cannot say whose code it is looking at
 * has nothing to report.
 */
async function assertServingThisWorktree() {
  const root = await fetchSentinelRoot(PORT)
  if (serverIsThisWorktree(root, OWN_ROOT)) return true
  console.error(
    `  FAIL  gallery        the server on :${PORT} does not prove it serves THIS worktree.\n` +
      `                       /__worktree said: ${root ?? '(no answer)'}\n` +
      `                       this worktree is: ${OWN_ROOT}\n` +
      `                       If /__worktree is unanswered, src-app/ui/vite.config.ts is missing\n` +
      `                       gallerySentinelPlugin() — without it this gate cannot tell your code\n` +
      `                       from a sibling worktree's, so it refuses to report a verdict.`,
  )
  return false
}

function killGallery() {
  if (!vite) return
  try {
    process.kill(-vite.pid, 'SIGTERM')
  } catch {
    try {
      vite.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}

// ── 4. per-surface rollup (mirrors gate-ui.mjs's formula) ──────────────────
/** Fail a surface iff it has a HIGH finding that is neither baselined nor harness-noise. */
function surfaceVerdicts() {
  const p = path.join(GALLERY_DIR, 'RUNTIME_FINDINGS.jsonl')
  if (!fs.existsSync(p)) return []
  const surfaces = {}
  for (const line of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    let f
    try {
      f = JSON.parse(line)
    } catch {
      continue
    }
    const s = (surfaces[f.surface] ??= { high: 0, medium: 0, low: 0, baselined: 0 })
    if (f.baselined || f.harness) s.baselined++
    else s[String(f.severity).toLowerCase()]++
  }
  return Object.entries(surfaces)
    .map(([surface, c]) => ({ surface, ...c, ok: c.high === 0 }))
    .sort((a, b) => b.high - a.high || a.surface.localeCompare(b.surface))
}

/** Run the pass, streaming its output live AND capturing it for parsing. */
function runPass() {
  return new Promise(resolve => {
    // NOT --report-only: the pass's own exit code is part of the gate.
    const p = spawn('node', [PASS_SCRIPT], {
      cwd: UI_DIR,
      env: { ...process.env, GALLERY_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    // Tee: stream live (a buffered pipe makes a 10-minute pass look hung) and
    // keep the text so the cell-count line can be parsed for the honest total.
    p.stdout.on('data', d => {
      out += d
      process.stdout.write(d)
    })
    p.stderr.on('data', d => {
      out += d
      process.stderr.write(d)
    })
    p.on('close', code => resolve({ code: code ?? 2, out }))
  })
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!(await bootGallery())) {
    killGallery()
    process.exit(2)
  }
  if (!(await assertServingThisWorktree())) {
    killGallery()
    process.exit(2)
  }
  const startedAt = Date.now()
  let code, out
  try {
    console.log(
      `  ..    ${PASS_NAME}  rendering every surface × state × theme …\n`,
    )
    ;({ code, out } = await runPass())
    if (code === 2) {
      console.error(`  FAIL  ${PASS_NAME}  the pass itself errored (exit 2)`)
      return 2
    }
  } finally {
    killGallery()
  }

  // ── false-clean guard ────────────────────────────────────────────────────
  // A clean exit is only trustworthy if the pass ACTUALLY rendered this run. The
  // authoritative signal is a FRESH findings JSONL (a stale one from a previous
  // run would otherwise read as a clean result).
  const jsonl = path.join(GALLERY_DIR, 'RUNTIME_FINDINGS.jsonl')
  const fresh =
    fs.existsSync(jsonl) && fs.statSync(jsonl).mtimeMs >= startedAt - 1000
  // Cell count when the pass prints it. gate-ui only echoes runtime-health's LAST
  // few lines, so the enumeration line is absent in --gate-ui mode — hence this is
  // reported when available, never used as the liveness test.
  const cells = Number((out.match(/=\s*(\d+)\s+surface\/state cells/) || [])[1] || 0)
  const verdicts = surfaceVerdicts()
  if (!fresh || !verdicts.length) {
    console.error(
      `== RESULT: FAIL — no fresh ${path.relative(REPO, jsonl)} from this run ` +
        '(the pass rendered nothing); refusing to report a false clean ==',
    )
    return 2
  }

  // ── the per-surface PASS/FAIL table (paste this into the landing report) ──
  const fails = verdicts.filter(v => !v.ok)
  console.log(
    `\n--- per-surface runtime verdict: ${verdicts.length - fails.length}/${verdicts.length} ` +
      `PASS (of the surfaces that reported ≥1 finding${cells ? `; ${cells} cells rendered` : ''}) ---`,
  )
  if (fails.length) {
    for (const v of fails)
      console.log(`   FAIL ${v.surface}  (HIGH ${v.high}, MEDIUM ${v.medium})`)
    console.log(
      `\n   detail → ${path.relative(REPO, path.join(GALLERY_DIR, 'RUNTIME_FINDINGS.md'))}`,
    )
  } else {
    console.log('   PASS every surface is runtime-clean of gating HIGH findings')
  }

  if (code !== 0 || fails.length > 0) {
    const why = fails.length
      ? `${fails.length} surface(s) with gating HIGH findings`
      : `the ${PASS_NAME} pass failed (exit ${code}) with no per-surface HIGH — see its output above`
    console.log(
      `== RESULT: ${REPORT_ONLY ? 'FAIL (report-only — not gating)' : 'FAIL'} — ${why} ==`,
    )
    return REPORT_ONLY ? 0 : 1
  }
  console.log(
    `== RESULT: PASS — ${PASS_NAME}${cells ? `, ${cells} cells rendered` : ''}, ` +
      `${verdicts.length} surfaces, 0 gating HIGH findings ` +
      `(:${PORT}, sentinel-verified ${OWN_ROOT}) ==`,
  )
  return 0
}

main()
  .then(c => process.exit(c))
  .catch(e => {
    console.error(e)
    killGallery()
    process.exit(2)
  })
