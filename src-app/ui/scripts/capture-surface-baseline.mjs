#!/usr/bin/env node
/**
 * capture-surface-baseline.mjs — the DECLARED-SURFACE-DRIFT device.
 *
 * WHAT IT GUARANTEES (as of the 2026-08-10 re-capture): the workbench's
 * externally-observable SURFACE in the tree under test is IDENTICAL to the surface
 * captured from `origin/main`, except for differences enumerated in
 * `surface-baseline-expected-delta.json` — each attributed to an authorising item, and,
 * where the entry claims a relocation / narrowing / installer move, VERIFIED against the
 * tree rather than believed. An undeclared difference FAILS. A declared difference that
 * does not materialise ALSO fails, so a stale allowance cannot silently widen the gate.
 *
 * WHAT IT NO LONGER GUARANTEES — retired, deliberately. The device was built for the
 * `processor-ui-language` round as its BEFORE/AFTER equivalence argument (INV-4): the
 * baseline was a real worktree at the PRE-refactor commit 06d99c65, and every allowance
 * was one of that refactor's deletions. That argument is now unavailable and its shell
 * was actively harmful:
 *
 *   - the refactor landed long ago and main advanced 621 commits past 06d99c65, so a
 *     difference against that snapshot no longer told you whose change it was; the
 *     manifest had to grow `carried-in: <sha>` allowances for main's own work.
 *   - 28 of its 257 `viewSpecs` allowances sat at depth <= 2 (`cell-filter/checks`,
 *     `qc/canvas`, `cell-filter/layout`, ...). A depth-2 allowance is a BLANKET PERMIT
 *     over a whole subtree: measured 2026-08-10, a brand-new schema-valid `check`
 *     inserted into the shipped `cell-filter.yaml` produced 602 differences and ZERO
 *     UNEXPECTED — the gate could not see it.
 *
 * Re-capturing against current main retires the equivalence claim and empties the
 * allowance list, so there is no blanket permit left to hide behind. The baseline is now
 * the SAME tree shape as the tree under test, which means a self-comparison is the
 * expected steady state (0 differences) rather than a proof of nothing: what carries the
 * weight is no longer "before vs after", it is "declared vs undeclared".
 *
 * MAINTENANCE CONSEQUENCE, stated so it is chosen and not discovered: the baseline is a
 * LOCK on main's surface. A branch that legitimately changes the surface must declare each
 * difference in the delta manifest; a merge that lands such a change must re-capture the
 * baseline (`npm run capture:surface-baseline`) and empty the manifest in the same commit.
 *
 * NINE FACETS are captured by REALLY LOADING the tree's own sources (a `node:module`
 * hook transpiles TS/TSX through that tree's own `typescript`), never by reading a
 * checked-in list. EIGHT of them are DIFFED (`DIFFED_SET_FACETS` + `viewSpecs`); the
 * ninth, `moduleExports`, is a VERIFICATION SET only — see below.
 *
 *   apiValueExports    runtime `Object.keys()` of the public workbench barrel
 *   apiDeclaredExports the barrel's full DECLARED export set (types included), via the
 *                      TS AST, following `export * from` transitively
 *   extensionExports   the same, for the tree's `extensions/index.ts` — the second public
 *                      entry point, so a symbol that moved core -> extensions is provably
 *                      RELOCATED rather than merely gone (INV-6). DIFFED as a facet in its
 *                      own right AND used to verify `relocated` claims: it is a published
 *                      contract, so losing a symbol from it must fail like losing one from
 *                      the core barrel.
 *   contributionKinds  `CONTRIBUTION_KINDS` from that barrel
 *   paneKinds          `PANE_KINDS` from the dock pane model
 *   formWidgetKinds    `registeredWidgetKinds()` after the FORM-CONTROL installer alone
 *   widgetKinds        the same after the tree's canonical install-every-builtin-widget
 *                      entry point — what a real mount path actually gets
 *   viewSpecs          `parseViewSpec()` applied to BOTH shipping `ui/*.yaml`
 *                      (`cell-filter`, `qc`) — the parsed + lowered form, deep-compared
 *   moduleExports      every name exported by ANY file in the workbench tree. NOT diffed
 *                      (it is internal, and churning it is ordinary work); it exists so an
 *                      `unexported` claim can be VERIFIED rather than believed.
 *
 * FAIL-CLOSED BY POSITIVE COUNT. Every facet carries a committed minimum
 * (`FLOORS`). A capture that loaded nothing, or a comparison whose baseline
 * facet is empty, EXITS NON-ZERO instead of reporting "no differences found".
 * "Zero surfaces compared" is the failure this device exists to make impossible.
 * A COLLAPSE and a CHANGE are separate verdicts: the floors answer "did the scan load
 * anything?" only where there is no reference population; where there is one (the baseline
 * being compared against, or the one a re-capture is about to replace) the same question is
 * asked of RETENTION, so a facet that fell by one member is REPORTED as a removal instead of
 * aborting the run. See `COLLAPSE_RETENTION` / `collapseThreshold`.
 *
 * Usage
 *   capture --root <repoRoot> --out <file.json> [--label <text>]
 *   compare --baseline <file.json> [--root <repoRoot>] [--delta <file.json>] [--json]
 *
 * `--delta` names the committed expectation file: every difference the branch
 * DELIBERATELY makes, each attributed to the item that authorised it. A difference not
 * listed there fails the comparison. An expectation that does not materialise ALSO fails
 * it (a stale allowance cannot silently widen the gate).
 *
 * EVERY allowance must be ATTRIBUTED (`item`, `disposition`, `why`) — `evaluate` enforces
 * that, because the CLI's success line claims it. A `{facet,kind,name}` triple with no
 * authorising item used to pass while the gate printed "item-attributed".
 *
 * ALLOWANCE SCOPE — the hole that made this device blind. `viewSpecs` allowances match on
 * the EXACT JSON-Pointer path `pointerDiff` reports, and `pointerDiff` reports the
 * SHALLOWEST differing path. So `cell-filter/checks` — reported once, because the pre-move
 * spec had no `checks` key at all — kept naming that same path no matter how many checks
 * were added underneath it. One allowance, permanently blind subtree. TWO independent
 * narrowings now apply, because neither alone is sufficient:
 *
 *   1. CONTENT-BINDING. A `viewSpecs` allowance must carry the `detail` string of the
 *      difference it permits, and it is matched. An allowance is then a permit for ONE
 *      observed change, not for a path. This binds at EVERY depth — the depth rule alone
 *      would not, since `dkey` is `facet:kind:name` and ignores content.
 *      RESIDUAL, stated because it is real: `pointerDiff` truncates `detail` at 200 chars,
 *      so two changes to a large subtree that agree on the first 200 characters of their
 *      serialisation are indistinguishable to this check. That is what (2) is for.
 *   2. DEPTH. An allowance at pointer depth <= BLANKET_ALLOWANCE_DEPTH covers a whole
 *      top-level section or list element, which is where the truncation residual bites, so
 *      it must additionally say `"blanket": true` out loud.
 *
 * A genuine wholesale replacement is still declarable; it just cannot be written by
 * ACCIDENT, and it is visible in review as `blanket`.
 *
 * ARRAY IDENTITY. The other half of "an allowance names ONE change": arrays whose elements
 * carry an authored `id` are compared BY THAT ID, not by position, so inserting a widget is
 * one added entry rather than a renumbering of every later sibling (measured: 72 -> 1). The
 * order of the surviving elements is compared separately, so render order stays surface.
 * See `idKeyable` / `idKeyedDiff`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as presolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOADER = pathToFileURL(join(HERE, 'surface-baseline-loader.mjs')).href

/** Committed minimum size per facet — the expected count used when there is NO reference
 *  population to be relative to (a first-ever capture, or a facet the reference predates),
 *  and the rule the BASELINE FILE itself is always checked against.
 *  These are POSITIVE expected counts, deliberately not "> 0": a facet that collapsed
 *  to a handful of entries is the same silent-narrowing bug as one that collapsed to
 *  none. Their job is to stop a LOAD FAILURE (or a truncated baseline FILE) from reading
 *  as "identical"; exact-set equality against the baseline is what catches a real change.
 *
 *  Observed at the 2026-08-10 re-capture (main 8a4bd011, post layout):
 *    apiValueExports=92 apiDeclaredExports=223 contributionKinds=3 paneKinds=15
 *    widgetKinds=17 formWidgetKinds=12 viewSpecs=2
 *
 *  `contributionKinds` sits EXACTLY on its floor (3), and that is what forced the split
 *  between a COLLAPSE and a CHANGE. A flat number cannot tell them apart for a facet whose
 *  healthy population is itself a handful — removing one kind used to ABORT the capture
 *  ("SCAN SET COLLAPSED") instead of reporting a difference, so the operator saw the tool
 *  refusing to run rather than a diff naming what changed. These values are unchanged and
 *  MUST NOT be lowered (that weakens the device everywhere to fix one facet); what changed
 *  is that where a reference population exists, the question is asked of RETENTION instead
 *  — see `COLLAPSE_RETENTION` / `collapseThreshold`. */
export const FLOORS = {
  apiValueExports: 50,
  apiDeclaredExports: 80,
  contributionKinds: 3,
  paneKinds: 10,
  widgetKinds: 8,
  formWidgetKinds: 8,
  viewSpecs: 2,
}

/** The two shipping `ui/*.yaml` consumers — the ONLY real view_spec consumers, so
 *  a change to the shipped declarative UI is precisely "one of these two parses
 *  differently". Both tree shapes keep them at the same repo-relative path. */
const SHIPPING_SPECS = {
  'cell-filter': 'src-app/packages/cell-filter/ui/cell-filter.yaml',
  qc: 'src-app/packages/qc/ui/qc.yaml',
}

// ---------------------------------------------------------------------------
// Tree-shape detection. The `pre` branch is a REMNANT of the round this device was built
// for, when it had to span a tree-shape move; the baseline is now captured from main in the
// same shape as the tree under test, and the suite REQUIRES the two to match. It is kept
// because it costs nothing and a bisect back across the move still needs it — not because
// anything in the normal path exercises it.
// ---------------------------------------------------------------------------

/** @returns {{layout:'pre'|'post', uiRoot:string, barrel:string, paneModel:string,
 *             installWidgets:string, widgetRegistry:string, schema:string}} */
export function detectLayout(root) {
  const uiRoot = presolve(root, 'src-app/ui')
  const post = presolve(uiRoot, 'src/modules/workbench/core/index.ts')
  const pre = presolve(root, 'src-app/libs/workbench-api/src/index.ts')
  if (existsSync(post)) {
    const w = presolve(uiRoot, 'src/modules/workbench')
    return {
      layout: 'post',
      uiRoot,
      barrel: post,
      // The SECOND public entry point. INV-6 says core names no capability and each
      // CONTRACT is exported by the extension that publishes it, so a type that left
      // `core` for `extensions` is RELOCATED, not deleted — and `compare` refuses to
      // accept a "relocated" claim it cannot see landing here.
      extBarrel: join(w, 'extensions/index.ts'),
      paneModel: join(w, 'core/shell/dock/paneModel.tsx'),
      installWidgets: join(w, 'extensions/widgets/installWidgets.ts'),
      widgetRegistry: join(w, 'core/render/registry.ts'),
      schema: join(w, 'core/spec/schema.ts'),
    }
  }
  if (existsSync(pre)) {
    const w = presolve(uiRoot, 'src/modules/workbench')
    return {
      layout: 'pre',
      uiRoot,
      barrel: pre,
      extBarrel: null, // the pre tree has no extensions barrel — that IS the refactor
      paneModel: join(w, 'dock/paneModel.tsx'),
      installWidgets: join(w, 'declarative/installWidgets.ts'),
      widgetRegistry: join(w, 'declarative/registry.ts'),
      schema: join(w, 'declarative/schema.ts'),
    }
  }
  throw new Error(
    `capture-surface-baseline: no recognised workbench layout under ${root} — ` +
      `neither ${post} (post-refactor) nor ${pre} (pre-refactor) exists`,
  )
}

// ---------------------------------------------------------------------------
// apiDeclaredExports — the TS AST walk. Runtime keys miss every `export type`, and a
// type silently lost in a 5,976-line move is exactly the regression TEST-1 targets.
// ---------------------------------------------------------------------------

function declaredExports(entry, tsRoot) {
  const ts = createRequire(presolve(tsRoot, 'package.json'))('typescript')
  const names = new Set()
  const seen = new Set()

  const resolveSpec = (from, spec) => {
    if (!spec.startsWith('.')) return null
    const base = presolve(dirname(from), spec)
    for (const c of [base, base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx']) {
      if (existsSync(c)) return c
    }
    // `allowImportingTsExtensions` means the specifier often already carries `.ts`.
    const stripped = base.replace(/\.tsx?$/, '')
    for (const c of [stripped + '.ts', stripped + '.tsx']) if (existsSync(c)) return c
    return null
  }

  const visit = file => {
    if (seen.has(file)) return
    seen.add(file)
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true)
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st)) {
        const spec = st.moduleSpecifier?.text
        if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) names.add(el.name.text)
        } else if (!st.exportClause && spec) {
          // `export * from './x'` — recurse; the re-exported names are ours.
          const t = resolveSpec(file, spec)
          if (t) visit(t)
          else throw new Error(`capture-surface-baseline: unresolved \`export * from '${spec}'\` in ${file}`)
        }
        continue
      }
      const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) || [] : []
      if (!mods.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text)
      } else if (st.name && ts.isIdentifier(st.name)) {
        names.add(st.name.text)
      }
    }
  }

  visit(entry)
  return [...names].sort()
}

/** Every name exported by ANY file in the workbench tree (whether or not it reaches a
 *  barrel). A symbol removed from the public barrel but still present here was
 *  NARROWED, not deleted — a materially different claim, and one the delta file has to
 *  substantiate rather than assert. */
function allModuleExports(L) {
  const roots = [presolve(L.uiRoot, 'src/modules/workbench')]
  if (L.layout === 'pre') roots.push(presolve(L.uiRoot, '../libs/workbench-api/src'))
  const ts = createRequire(presolve(L.uiRoot, 'package.json'))('typescript')
  const names = new Set()
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue
        walk(p)
        continue
      }
      if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue
      const sf = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.ES2022, true)
      for (const st of sf.statements) {
        if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) names.add(el.name.text)
          continue
        }
        const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) || [] : []
        if (!mods.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text)
        } else if (st.name && ts.isIdentifier(st.name)) names.add(st.name.text)
      }
    }
  }
  for (const r of roots) if (existsSync(r)) walk(r)
  return [...names].sort()
}

// ---------------------------------------------------------------------------
// The runtime capture. Runs in a CHILD node process because the module hooks are
// rooted at one specific ui tree; `capture` and `compare` load two different trees in
// one invocation, and a single process cannot host both.
// ---------------------------------------------------------------------------

const CHILD_SRC = `
globalThis.__SURFACE_BASELINE_ENV__ = { DEV: false, PROD: true, MODE: 'production', SSR: false }
import YAML from 'yaml'
import { readFileSync } from 'node:fs'
const L = JSON.parse(process.env.SURFACE_BASELINE_JOB)
const out = {}
const barrel = await import(L.barrel)
out.apiValueExports = Object.keys(barrel).sort()
out.contributionKinds = [...(barrel.CONTRIBUTION_KINDS ?? [])]
const pm = await import(L.paneModel)
out.paneKinds = [...(pm.PANE_KINDS ?? [])]
const wreg = await import(L.widgetRegistry)
// formWidgetKinds: what the FORM-CONTROL installer alone registers — 12 as of the
// 2026-08-10 capture, against 17 for the full mount path below. That 5-kind difference is
// the canvas owning its own plot kinds (DEC-A), and it is only legitimate if the canvas
// re-registers them, which the widgetKinds facet below is what actually proves.
const iw = await import(L.installWidgets)
iw.installWidgets()
out.formWidgetKinds = wreg.registeredWidgetKinds().sort()
// widgetKinds: what a real MOUNT PATH gets: the tree's single canonical install-every-
// builtin-widget entry point. Pre that is installWidgets() itself; post it is
// installBuiltinWidgets() (form controls + the canvas' own plot kinds, DEC-A). This is the
// facet that carries REACHABILITY: a spec instantiating scatter must still find a renderer.
if (L.extBarrel) {
  const ext = await import(L.extBarrel)
  ext.installBuiltinWidgets()
}
out.widgetKinds = wreg.registeredWidgetKinds().sort()
const schema = await import(L.schema)
out.viewSpecs = {}
for (const [name, path] of Object.entries(L.specs)) {
  const raw = YAML.parse(readFileSync(path, 'utf8'))
  const r = schema.parseViewSpec(raw.view_spec ?? raw)
  if (!r.ok) throw new Error('parseViewSpec failed for ' + name + ': ' + JSON.stringify(r.errors))
  out.viewSpecs[name] = r.value
}
process.stdout.write('---BASELINE-JSON---' + JSON.stringify(out))
`

function runtimeCapture(root, L) {
  const specs = {}
  for (const [k, rel] of Object.entries(SHIPPING_SPECS)) {
    const p = presolve(root, rel)
    if (!existsSync(p)) throw new Error(`capture-surface-baseline: shipping spec missing: ${p}`)
    specs[k] = p
  }
  const job = {
    barrel: pathToFileURL(L.barrel).href,
    paneModel: pathToFileURL(L.paneModel).href,
    installWidgets: pathToFileURL(L.installWidgets).href,
    extBarrel: L.extBarrel && existsSync(L.extBarrel) ? pathToFileURL(L.extBarrel).href : null,
    widgetRegistry: pathToFileURL(L.widgetRegistry).href,
    schema: pathToFileURL(L.schema).href,
    specs,
  }
  for (const [k, v] of Object.entries(job)) {
    if (k === 'specs' || v === null) continue
    if (!existsSync(fileURLToPath(v))) throw new Error(`capture-surface-baseline: ${k} missing at ${v}`)
  }
  // The register shim goes to a temp dir, never into `scripts/` — a generated file inside
  // the repo would show up as an untracked artifact and trip the phase-8 clean-tree gate.
  const reg = join(mkdtempSync(join(tmpdir(), 'surface-baseline-')), 'register.mjs')
  writeFileSync(reg, `import { register } from 'node:module'\nregister(${JSON.stringify(LOADER)}, import.meta.url)\n`)
  const r = spawnSync(process.execPath, ['--import', reg, '--input-type=module', '-e', CHILD_SRC], {
    cwd: L.uiRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SURFACE_BASELINE_UI_ROOT: L.uiRoot, SURFACE_BASELINE_JOB: JSON.stringify(job) },
  })
  const marker = '---BASELINE-JSON---'
  const i = (r.stdout || '').indexOf(marker)
  if (r.status !== 0 || i < 0) {
    throw new Error(
      `capture-surface-baseline: runtime capture FAILED for ${L.uiRoot} (exit ${r.status})\n` +
        `${(r.stderr || '').slice(-4000)}`,
    )
  }
  return JSON.parse(r.stdout.slice(i + marker.length))
}

/**
 * @param root      the tree to capture
 * @param label     free text recorded in the snapshot
 * @param reference the facet-set this capture is measured against for COLLAPSE (the baseline
 *                  being compared to, or the baseline about to be overwritten). REQUIRED —
 *                  no default — so a new call site has to say `null` out loud rather than
 *                  fall into the weaker reference-less rule by omission.
 */
export function capture(root, label, reference) {
  const L = detectLayout(root)
  const facets = runtimeCapture(root, L)
  facets.apiDeclaredExports = declaredExports(L.barrel, L.uiRoot)
  facets.extensionExports = L.extBarrel && existsSync(L.extBarrel) ? declaredExports(L.extBarrel, L.uiRoot) : []
  facets.moduleExports = allModuleExports(L)
  assertPopulations(facets, reference, `capture of ${root}`)
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return {
    schema: 1,
    capturedFrom: {
      // No absolute `root`: this snapshot is COMMITTED, and the capturing machine's
      // filesystem layout is not part of the surface. `barrel` below is repo-relative.
      layout: L.layout,
      commit: (head.stdout || '').trim() || 'unknown',
      label: label || null,
      barrel: L.barrel.slice(root.length + 1),
    },
    facets,
  }
}

/** The size of a captured facet, whatever shape it is stored in (a set is a list, `viewSpecs`
 *  is a keyed object). An ABSENT facet is 0 here — `collapseThreshold` distinguishes absent
 *  from empty on the REFERENCE side, where the difference matters. */
const facetSize = v => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0)

/**
 * The fraction of a REFERENCE population a facet must retain before its shortfall stops
 * reading as a change and starts reading as a COLLAPSE.
 *
 * Half is not a tuning knob to be nudged when something goes red — it is the line between
 * the two failures. A broken load (the barrel did not resolve, the walk found nothing, the
 * TS hook threw) empties a facet or leaves a token remnant; a tree change removes members
 * one at a time. Retaining more than half is arithmetically incompatible with the first and
 * routine for the second.
 */
export const COLLAPSE_RETENTION = 0.5

/**
 * The population `key` must reach for the scan to be believable.
 *
 * WITH a reference — the baseline being compared against, or the baseline about to be
 * overwritten by a re-capture — it is retention-relative. WITHOUT one (a first-ever capture,
 * or a facet the reference predates) it is the committed floor, which is the only expected
 * count available at that point.
 *
 * WHY IT IS NOT JUST THE FLOOR. The floor answers "did the scan load anything?" with a fixed
 * number, and a fixed number cannot answer it for a facet whose HEALTHY population is itself
 * a handful: `contributionKinds` sits at exactly 3, so the next legitimate removal aborted
 * the capture — the operator saw the tool refusing to run instead of a diff naming what
 * changed, which is the wrong failure mode for a change that is merely undeclared. Lowering
 * the floor would have been worse: it weakens the device everywhere to fix one facet.
 *
 * The trade is stated rather than hidden. For a facet whose reference is more than twice its
 * floor the relative rule is STRICTER than the floor ever was (`apiDeclaredExports`: 223
 * observed, floor 80, threshold 112) — half a barrel vanishing now aborts where the flat
 * floor waved it through. For a facet sitting near its floor it is LOOSER by design, and
 * what fills the gap is not nothing: the missing members flow into `diffFacets` and come out
 * as named `removed` entries, which fail the comparison unless the manifest declares them.
 * The guarantee "zero surfaces compared can never read as OK" is untouched either way.
 */
export function collapseThreshold(key, reference) {
  if (!reference || !(key in reference)) return FLOORS[key]
  return Math.max(1, Math.ceil(facetSize(reference[key]) * COLLAPSE_RETENTION))
}

/** Fail-closed: a facet below its committed floor means the capture LOADED
 *  ALMOST NOTHING, which must never read as "identical". The reference-less case of
 *  {@link assertPopulations}, kept as its own name because that is what a BASELINE FILE is
 *  checked against — there is nothing behind a baseline to compare it to. */
export function assertFloors(facets, what) {
  return assertPopulations(facets, null, what)
}

/**
 * Fail-closed on a COLLAPSED scan set, measured against `reference` where one exists (see
 * {@link collapseThreshold}). Throws; a shortfall that is not a collapse is left to the diff
 * to REPORT, which is the whole point.
 */
export function assertPopulations(facets, reference, what) {
  const bad = []
  for (const k of Object.keys(FLOORS)) {
    const n = facetSize(facets[k])
    const min = collapseThreshold(k, reference)
    if (n >= min) continue
    bad.push(
      reference && k in reference
        ? `${k}: ${n} < ${min} (under ${COLLAPSE_RETENTION * 100}% of the reference population ${facetSize(reference[k])})`
        : `${k}: ${n} < committed floor ${min}`,
    )
  }
  if (bad.length) {
    throw new Error(
      `capture-surface-baseline: SCAN SET COLLAPSED in ${what} — ${bad.join('; ')}. ` +
        'The device was about to report a surface comparison it never actually made.',
    )
  }
}

// ---------------------------------------------------------------------------
// Comparison.
// ---------------------------------------------------------------------------

const stable = v =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map(k => [k, stable(v[k])]),
        )
      : v

/** The SET-shaped facets, diffed by membership. `extensionExports` is here because it is a
 *  PUBLISHED entry point (the extensions barrel), not merely the evidence for a `relocated`
 *  claim: a contract vanishing from it must fail exactly like one vanishing from the core
 *  barrel. `moduleExports` is deliberately absent — it is the tree's INTERNAL export set,
 *  churned by ordinary refactoring, and exists only to verify `unexported` claims. */
export const DIFFED_SET_FACETS = [
  'apiValueExports',
  'apiDeclaredExports',
  'extensionExports',
  'contributionKinds',
  'paneKinds',
  'widgetKinds',
  'formWidgetKinds',
]

/** @returns {{facet:string, kind:'removed'|'added'|'changed', name:string, detail?:string}[]} */
export function diffFacets(before, after) {
  const out = []
  for (const facet of DIFFED_SET_FACETS) {
    const b = new Set(before[facet] || [])
    const a = new Set(after[facet] || [])
    for (const n of [...b].filter(x => !a.has(x)).sort()) out.push({ facet, kind: 'removed', name: n })
    for (const n of [...a].filter(x => !b.has(x)).sort()) out.push({ facet, kind: 'added', name: n })
  }
  const bs = before.viewSpecs || {}
  const as = after.viewSpecs || {}
  for (const n of Object.keys(bs).filter(k => !(k in as)).sort()) out.push({ facet: 'viewSpecs', kind: 'removed', name: n })
  for (const n of Object.keys(as).filter(k => !(k in bs)).sort()) out.push({ facet: 'viewSpecs', kind: 'added', name: n })
  // A whole-spec "changed" verdict would be a blanket allowance: once granted it would
  // permit ANY later edit to the lowered spec. Diff to JSON-POINTER granularity so each
  // allowance names one path, and a second, unrelated change to the same spec still fails.
  for (const n of Object.keys(bs).filter(k => k in as).sort()) {
    for (const d of pointerDiff(stable(bs[n]), stable(as[n]), ''))
      out.push({ facet: 'viewSpecs', kind: 'changed', name: `${n}${d.path}`, detail: d.detail })
  }
  return out
}

/** RFC-6901 segment escaping. Without it a key containing `/` would inflate the reported
 *  depth and slip the blanket-allowance guard; view-spec `state`/`data`/`derived`/`const`
 *  keys are free-form, so such a key is expressible even though none exists today. */
const ptrSeg = k => String(k).replace(/~/g, '~0').replace(/\//g, '~1')

/**
 * IDENTITY, not position — the rule that decides how an array is compared.
 *
 * THE DEFECT IT FIXES. Comparing array elements positionally meant inserting ONE widget at
 * index N reported every element after N as changed. Measured 2026-08-10 on the real tree:
 * adding a single alert to `cell-filter.yaml` made the gate demand 72 allowances — 71 pure
 * renumbering plus one blanket for the shifted trailing element — instead of the 1 real
 * difference. That is not a stricter gate, it is a manifest nobody reads: the same failure
 * mode as the whole-subtree blanket permits removed in f5943a4d, reached from the other
 * direction. It also made every widget insertion an expensive edit to a file that is a live
 * merge hotspot.
 *
 * THE RULE, deliberately structural rather than a list of key names (`widgets`, `checks`,
 * `actions`, `canvas/datasets`, `canvas/series` all qualify today; a sixth authored-identity
 * array qualifies the day it exists, with no edit here). An array is identity-keyed when
 * EVERY element is an object carrying a non-empty string `id` that is unique within that
 * array. `columns`, `parts`, `body`, `switchTo`, `excludes` and every array of primitives
 * carry no `id` and keep the positional rule; so does an array whose ids are not unique,
 * because a Map keyed on a duplicated id would silently stop comparing the second element.
 * An EMPTY array satisfies this vacuously, so `[] -> [{id}]` is keyed too and reports the
 * addition by name; `[] -> []` never reaches here (JSON-equal returns first).
 */
function idKeyable(arr) {
  if (!Array.isArray(arr)) return false
  const seen = new Set()
  for (const el of arr) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return false
    if (typeof el.id !== 'string' || el.id === '') return false
    if (seen.has(el.id)) return false
    seen.add(el.id)
  }
  return true
}

/** The pointer segment for an identity-keyed element. The `#` marker is load-bearing: ids
 *  are author-controlled STRINGS, and `"2"` is a perfectly legal id, so a bare id would be
 *  indistinguishable from an array INDEX and one allowance written for positional
 *  `widgets/2` would stand permit over the element whose id is `2`. `id -> '#' + ptrSeg(id)`
 *  is injective, so two distinct ids can never collide on one pointer. */
const idSeg = id => `#${ptrSeg(id)}`

/** Diff two identity-keyed arrays: each element is compared to the element sharing its
 *  `id`, wherever either one sits. An insertion is therefore ONE added entry and its
 *  siblings are untouched.
 *
 *  ORDER IS STILL SURFACE, and keying by id would otherwise make it invisible — swapping
 *  two widgets changes what the user sees while every element matches its twin exactly.
 *  So the order of the SURVIVING (common) elements is compared in its own right and
 *  reported at the array itself. Restricting it to the common elements is what keeps a
 *  plain insertion from reading as a reorder as well. */
function idKeyedDiff(b, a, path) {
  const bm = new Map(b.map(x => [x.id, x]))
  const am = new Map(a.map(x => [x.id, x]))
  const out = []
  for (const id of [...new Set([...bm.keys(), ...am.keys()])].sort()) {
    const p = `${path}/${idSeg(id)}`
    if (!bm.has(id)) out.push({ path: p, detail: `added: ${JSON.stringify(am.get(id)).slice(0, 200)}` })
    else if (!am.has(id)) out.push({ path: p, detail: `removed: ${JSON.stringify(bm.get(id)).slice(0, 200)}` })
    else out.push(...pointerDiff(bm.get(id), am.get(id), p))
  }
  const bOrder = b.filter(x => am.has(x.id)).map(x => x.id)
  const aOrder = a.filter(x => bm.has(x.id)).map(x => x.id)
  if (JSON.stringify(bOrder) !== JSON.stringify(aOrder)) {
    // Reported at the array path, which is shallow — so the blanket-allowance rule already
    // requires a reorder to be declared out loud, which is also the backstop for this
    // `detail` being truncated on a long list.
    out.push({
      path,
      detail: `reordered: ${JSON.stringify(bOrder).slice(0, 100)} -> ${JSON.stringify(aOrder).slice(0, 100)}`,
    })
  }
  return out
}

/** Deep diff to JSON-Pointer paths. Reports the SHALLOWEST differing path (an added
 *  subtree is one entry, not one per leaf). Arrays are compared by IDENTITY where the
 *  elements carry one (see {@link idKeyable}) and positionally otherwise. */
function pointerDiff(b, a, path) {
  if (JSON.stringify(b) === JSON.stringify(a)) return []
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
  if (isObj(b) && isObj(a)) {
    const out = []
    for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      const p = `${path}/${ptrSeg(k)}`
      if (!(k in b)) out.push({ path: p, detail: `added: ${JSON.stringify(a[k]).slice(0, 200)}` })
      else if (!(k in a)) out.push({ path: p, detail: `removed: ${JSON.stringify(b[k]).slice(0, 200)}` })
      else out.push(...pointerDiff(b[k], a[k], p))
    }
    return out
  }
  if (Array.isArray(b) && Array.isArray(a)) {
    if (idKeyable(b) && idKeyable(a)) return idKeyedDiff(b, a, path)
    const out = []
    for (let i = 0; i < Math.max(b.length, a.length); i++) {
      if (i >= b.length) out.push({ path: `${path}/${i}`, detail: `added: ${JSON.stringify(a[i]).slice(0, 200)}` })
      else if (i >= a.length) out.push({ path: `${path}/${i}`, detail: `removed: ${JSON.stringify(b[i]).slice(0, 200)}` })
      else out.push(...pointerDiff(b[i], a[i], `${path}/${i}`))
    }
    return out
  }
  return [{ path, detail: `${JSON.stringify(b).slice(0, 120)} -> ${JSON.stringify(a).slice(0, 120)}` }]
}

const dkey = d => `${d.facet}:${d.kind}:${d.name}`

/** A `viewSpecs` allowance name is `<specName>/<pointer...>`; its DEPTH is the number of
 *  pointer segments below the spec name. `cell-filter/checks` is depth 1 (a whole
 *  top-level section), `cell-filter/widgets/#runBtn` depth 2 (a whole widget). Because
 *  `pointerDiff` reports the shallowest differing path, an allowance at either depth is a
 *  standing permit over that entire subtree. Identity-keying does not change this: a
 *  `#`-keyed element sits at exactly the depth its index used to, and both `#`-segments and
 *  object keys are RFC-6901 escaped so a `/`-bearing id cannot present a depth-2 element as
 *  a depth-3 leaf. */
export const BLANKET_ALLOWANCE_DEPTH = 2
export const allowanceDepth = name => name.split('/').length - 1

/** The dispositions an allowance may claim. A CLOSED set: inventing one fails. */
export const DISPOSITIONS = new Set(['deleted', 'relocated', 'unexported', 'relocated-installer', 'renamed', 'added', 'moved'])

/** The SHAPE rule for one allowance, enforced by `evaluate` and NOT only by a test — the
 *  CLI success line claims every difference is "declared, item-attributed and verified",
 *  and a `{facet,kind,name}` triple with no `item` used to satisfy it silently.
 *  @returns {string[]} human-readable reasons this entry is malformed (empty = fine) */
export function allowanceProblems(e) {
  const bad = []
  if (!e || !e.facet || !e.kind || !e.name) return ['missing facet/kind/name']
  if (!e.item) bad.push('no authorising `item`')
  if (!DISPOSITIONS.has(e.disposition)) bad.push(`unknown disposition ${JSON.stringify(e.disposition)}`)
  if (!e.why || e.why.length <= 20) bad.push('no `why` rationale (>20 chars)')
  // CONTENT-BINDING for viewSpecs: an allowance permits ONE observed change, not a path.
  // `dkey` is facet:kind:name and ignores content, so without this a single allowance at
  // ANY depth stands permit over whatever that path later becomes.
  if (e.facet === 'viewSpecs' && typeof e.detail !== 'string')
    bad.push('a viewSpecs allowance must carry the `detail` of the difference it permits')
  return bad
}

/**
 * The whole verdict, as a PURE function of two captured facet-sets and the allowance
 * list. Extracted from `compare` so the device's own claim is directly testable without a
 * two-minute real-tree load: everything below is what "every difference is declared,
 * item-attributed and — where it claims one — VERIFIED" actually means, mechanically.
 */
export function evaluate(beforeFacets, afterFacets, expectedEntries) {
  const diffs = diffFacets(beforeFacets, afterFacets)

  const allowed = new Map()
  for (const e of expectedEntries || []) allowed.set(dkey(e), e)

  const unexpected = diffs.filter(d => !allowed.has(dkey(d)))
  const unmet = [...allowed.keys()].filter(k => !diffs.some(d => dkey(d) === k))

  // Every allowance must be attributed + (for viewSpecs) content-bound.
  const malformed = []
  for (const e of allowed.values()) {
    const problems = allowanceProblems(e)
    if (problems.length) malformed.push(`${e.facet}:${e.kind}:${e.name} — ${problems.join('; ')}`)
  }

  // CONTENT-BINDING, enforced: the permitted difference must be the one that happened.
  // A matched allowance whose `detail` disagrees is a permit being reused for a DIFFERENT
  // change at the same path — the exact reuse that made a shallow allowance permanent.
  const contentMismatch = []
  for (const d of diffs) {
    const e = allowed.get(dkey(d))
    if (!e || e.facet !== 'viewSpecs' || typeof e.detail !== 'string') continue
    if (e.detail !== (d.detail ?? ''))
      contentMismatch.push(`${d.name} — allowance permits ${JSON.stringify(e.detail).slice(0, 120)} but the tree shows ${JSON.stringify(d.detail ?? '').slice(0, 120)}`)
  }

  // A `disposition: "relocated"` allowance is a CLAIM that the symbol left `core` for
  // the extensions barrel (INV-6). Verify it against the tree's real extensions barrel;
  // an unverifiable claim is a deletion wearing a relocation's clothes.
  const extNow = new Set(afterFacets.extensionExports || [])
  const relocClaims = [...allowed.values()].filter(e => e.disposition === 'relocated')
  const badRelocations = relocClaims.filter(e => !extNow.has(e.name)).map(e => e.name)

  // A `disposition: "unexported"` allowance claims the symbol survives INSIDE the tree
  // and merely left the public barrel. Verify against the tree's real module-export set;
  // an unverifiable claim is a deletion mislabelled as a narrowing.
  const modNow = new Set(afterFacets.moduleExports || [])
  const unexpClaims = [...allowed.values()].filter(e => e.disposition === 'unexported')
  const badUnexported = unexpClaims.filter(e => !modNow.has(e.name)).map(e => e.name)

  // A `disposition: "relocated-installer"` allowance claims a widget kind left the
  // form-control installer for another extension's installer (DEC-A: canvas owns its
  // plot kinds). Verify it is STILL REACHABLE from the canonical mount path; otherwise
  // a shipping spec instantiating that kind renders nothing.
  const kindsNow = new Set(afterFacets.widgetKinds || [])
  const instClaims = [...allowed.values()].filter(e => e.disposition === 'relocated-installer')
  const badInstaller = instClaims.filter(e => !kindsNow.has(e.name)).map(e => e.name)

  // THE BLIND SPOT, closed. A shallow `viewSpecs` allowance permits every future edit
  // inside its subtree; that is how a brand-new schema-valid `check` once passed unseen.
  // Declarable, but only on purpose: `"blanket": true` makes it say so out loud.
  const blanketPermits = [...allowed.values()]
    .filter(e => e.facet === 'viewSpecs' && allowanceDepth(e.name) <= BLANKET_ALLOWANCE_DEPTH && e.blanket !== true)
    .map(e => e.name)

  return {
    diffs,
    unexpected,
    unmet,
    malformed,
    contentMismatch,
    badRelocations,
    badUnexported,
    badInstaller,
    blanketPermits,
    extensionExports: (afterFacets.extensionExports || []).length,
    relocationsVerified: relocClaims.length - badRelocations.length,
    narrowingsVerified: unexpClaims.length - badUnexported.length,
    installerMovesVerified: instClaims.length - badInstaller.length,
    ok:
      unexpected.length === 0 &&
      unmet.length === 0 &&
      malformed.length === 0 &&
      contentMismatch.length === 0 &&
      badRelocations.length === 0 &&
      badUnexported.length === 0 &&
      badInstaller.length === 0 &&
      blanketPermits.length === 0,
  }
}

export function compare(baselineFile, root, deltaFile) {
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'))
  // The BASELINE FILE is checked absolutely — there is nothing behind it to be relative to,
  // and a truncated fixture must still abort. The CURRENT tree is then measured against that
  // (now-trusted) population, so a facet that fell by one is reported as a removal rather
  // than aborting a comparison the operator asked for.
  assertFloors(baseline.facets, `BASELINE ${baselineFile}`)
  const now = capture(root, 'current', baseline.facets)

  const expected = deltaFile && existsSync(deltaFile) ? JSON.parse(readFileSync(deltaFile, 'utf8')) : null
  if (deltaFile && !expected) throw new Error(`capture-surface-baseline: --delta file not found: ${deltaFile}`)

  const verdict = evaluate(baseline.facets, now.facets, expected?.expected || [])

  return {
    baseline: { file: baselineFile, commit: baseline.capturedFrom?.commit, layout: baseline.capturedFrom?.layout },
    current: { root, commit: now.capturedFrom.commit, layout: now.capturedFrom.layout },
    compared: Object.fromEntries(
      Object.keys(FLOORS).map(k => {
        const v = baseline.facets[k]
        return [k, Array.isArray(v) ? v.length : Object.keys(v || {}).length]
      }),
    ),
    ...verdict,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const mode = process.argv[2]
  try {
    if (mode === 'capture') {
      const root = presolve(arg('root', presolve(HERE, '../../..')))
      const out = arg('out')
      if (!out) throw new Error('capture requires --out <file.json>')
      // A re-capture measures itself against the baseline it is about to REPLACE: that file
      // is the last healthy scan of this same tree, which is a far better collapse detector
      // than a fixed number, and it is what lets a legitimate removal re-capture at all.
      // Absent (a first-ever capture) ⇒ the committed floors.
      const previous = existsSync(presolve(out)) ? JSON.parse(readFileSync(presolve(out), 'utf8')).facets : null
      const snap = capture(root, arg('label'), previous ?? null)
      mkdirSync(dirname(presolve(out)), { recursive: true })
      writeFileSync(presolve(out), JSON.stringify(snap, null, 2) + '\n')
      const c = Object.fromEntries(
        Object.keys(FLOORS).map(k => {
          const v = snap.facets[k]
          return [k, Array.isArray(v) ? v.length : Object.keys(v || {}).length]
        }),
      )
      console.log(
        `[surface-baseline] captured ${snap.capturedFrom.layout} layout @ ${snap.capturedFrom.commit.slice(0, 8)} -> ${out}`,
      )
      console.log(`[surface-baseline] ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    } else if (mode === 'compare') {
      const baseline = arg('baseline')
      if (!baseline) throw new Error('compare requires --baseline <file.json>')
      const root = presolve(arg('root', presolve(HERE, '../../..')))
      const delta = arg('delta', presolve(HERE, 'surface-baseline-expected-delta.json'))
      const r = compare(presolve(baseline), root, delta)
      if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2))
      console.log(
        `[surface-baseline] baseline ${r.baseline.commit?.slice(0, 8)} (${r.baseline.layout}) vs current ` +
          `${r.current.commit?.slice(0, 8)} (${r.current.layout})`,
      )
      console.log(
        `[surface-baseline] compared ${Object.entries(r.compared).map(([k, v]) => `${k}=${v}`).join(' ')}`,
      )
      console.log(`[surface-baseline] ${r.diffs.length} difference(s); ${r.unexpected.length} UNEXPECTED, ${r.unmet.length} declared-but-absent`)
      console.log(`[surface-baseline] ${r.relocationsVerified} relocation(s) verified against the extensions barrel (${r.extensionExports} exports); ${r.narrowingsVerified} narrowing(s) verified against the module-export set; ${r.installerMovesVerified} installer move(s) verified against the mount-path widget registry`)
      for (const d of r.unexpected) console.error(`  UNEXPECTED ${d.facet} ${d.kind} ${d.name}${d.detail ? ' — ' + d.detail : ''}`)
      for (const k of r.unmet) console.error(`  DECLARED-BUT-ABSENT ${k} — the delta file allows a change that did not happen; remove the stale allowance`)
      for (const n of r.badRelocations) console.error(`  UNVERIFIED RELOCATION ${n} — declared "relocated" but absent from the extensions barrel; it was DELETED, not moved`)
      for (const n of r.badUnexported) console.error(`  UNVERIFIED NARROWING ${n} — declared "unexported" but absent from every workbench module; it was DELETED, not narrowed`)
      for (const n of r.badInstaller) console.error(`  UNVERIFIED INSTALLER MOVE ${n} — declared "relocated-installer" but NOT registered by the canonical mount path; a spec using it would render nothing`)
      for (const n of r.malformed) console.error(`  UNATTRIBUTED ALLOWANCE ${n}`)
      for (const n of r.contentMismatch) console.error(`  ALLOWANCE REUSED ${n}`)
      for (const n of r.blanketPermits) console.error(`  BLANKET PERMIT ${n} — a viewSpecs allowance at pointer depth <= ${BLANKET_ALLOWANCE_DEPTH} covers a whole section or list element, where \`detail\`'s 200-char truncation stops binding it to one change. Write the allowance at the depth the change actually is; if the change genuinely IS wholesale (an added or removed spec/section), declare "blanket": true on purpose`)
      if (!r.ok) process.exit(1)
      console.log(
        `[surface-baseline] OK — the surface matches the baseline captured from main; every difference is declared, item-attributed and verified`,
      )
    } else {
      console.error('usage: capture-surface-baseline.mjs capture --root <r> --out <f> | compare --baseline <f> [--root <r>] [--delta <f>]')
      process.exit(2)
    }
  } catch (e) {
    console.error(String(e?.stack || e))
    process.exit(1)
  }
}
