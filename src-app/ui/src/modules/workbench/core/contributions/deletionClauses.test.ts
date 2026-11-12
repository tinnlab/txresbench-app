// The DECLARED-BUT-UNASSERTED clauses of TEST-7 / 18 / 27 / 28 / 29 / 30 / 32 / 52 / 53.
//
// A phase-8 survey resolved all 56 enumerated tests against the tree and found a recurring
// shape: a test had been RELOCATED intact but a load-bearing sub-clause was dropped in the
// move, so the clause was "true if you go and look" rather than asserted. In every case
// below the underlying deletion IS real today — what was missing is anything that would
// notice it coming back.
//
// They are collected here rather than scattered because they share one method (a source /
// registry scan with a positive count) and because a single file makes the surviving gap
// list auditable. Each block names the TEST-N it closes and the exact clause.
//
// vitest, not `node:test`: the pane + widget registries pull in `.tsx`.
import { test, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONTRIBUTION_KINDS } from './workbenchRegistry'
import { KNOWN_CONTRIBUTES } from '@/modules/workbench/core/manifest/validate'
import { PANE_KINDS, paneRenderers, FallbackPane } from '@/modules/workbench/core/shell/dock/paneModel'
import { registerPanes } from '@/modules/workbench/core/shell/dock/panes'
import { registeredWidgetKinds, hasWidget, __clearWidgetsForTests } from '@/modules/workbench/core/render/registry'
import { installWidgets, __resetInstallWidgetsForTests } from '@/modules/workbench/extensions/widgets/installWidgets'
import { CANVAS_WIDGET_KINDS } from '@/modules/workbench/extensions/canvas/installCanvasWidgets'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WB = path.resolve(HERE, '../..')
const REPO = path.resolve(WB, '../../../../..')

/** Production `.ts`/`.tsx` under core/ + extensions/, comments stripped. */
function productionCode(): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = []
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.(ts|tsx)$/.test(e.name)) continue
      out.push({
        file: path.relative(WB, p),
        code: readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter(l => !/^\s*\/\//.test(l))
          .join('\n'),
      })
    }
  }
  walk(path.join(WB, 'core'))
  walk(path.join(WB, 'extensions'))
  return out
}

function offenders(re: RegExp): string[] {
  const files = productionCode()
  // Shared positive count — every absence assertion below rests on this scan.
  expect(files.length, `scan set collapsed: ${files.length} file(s)`).toBeGreaterThanOrEqual(180)
  return files.filter(f => re.test(f.code)).map(f => f.file)
}

// ── TEST-7 (ITEM-5): the pane-kind set + the PlacedArea-routed kinds ─────────
// TESTS.md declared "all 14 pane kinds still registered". The measured set is 13, and
// `result` is now `artifact` (ITEM-25). Both numbers are pinned rather than left to a
// generic "every kind resolves something" check, which a shrinking set would satisfy.

test('TEST-7: the pane-kind set is exactly the 15 surviving kinds', () => {
  expect([...PANE_KINDS].sort()).toEqual(
    [
      'artifact',
      'artifacts',
      'canvas',
      'compare',
      // The centre canvas grid's surfaces, hosted as panes rather than inside the grid
      // (`regions/paneSurfaceHost.ts`): one pane per OPEN surface, `ref` = the surface's
      // subject — the grid pane it belongs to, or (for `export` alone) the reserved whole-grid
      // sentinel. ADDED kinds, so the pin goes UP — it is a floor against silent shrinkage,
      // not a cap on the vocabulary.
      'data-table',
      'datasets',
      'edit-plot',
      'export',
      'jobs',
      'launcher',
      'rerun',
      'reproducibility',
      'run',
      'view',
      'visualize',
    ].sort(),
  )
  // ITEM-25 renamed the entity; a saved layout carrying `result` migrates.
  expect(PANE_KINDS).not.toContain('result')
  // The `selection` ("Inspector") pane is RETIRED, not renamed: it was a second host for the
  // right dock AREA, so every right-docked analysis rendered twice. A saved layout naming it is
  // dropped by `dropRetiredPanes`.
  expect(PANE_KINDS).not.toContain('selection')
})

test('TEST-12 (visualize-pane ITEM-6): exactly ONE pane kind routes through PlacedArea — and `visualize` routes through SectionStack', () => {
  // ── Why this clause asserts TWO things ────────────────────────────────────────────────
  //
  // It used to read "exactly TWO pane kinds route through PlacedArea", the two being
  // `canvas` and `visualize` — the clause that stops a future contribution quietly
  // re-acquiring a pane. visualize-pane ITEM-5 moves `visualize` off `PlacedArea` and onto
  // `SectionStack`, so the old assertion has to change.
  //
  // The DANGEROUS rewrite is the obvious one: change `['canvas','visualize']` to
  // `['canvas']` and stop. That passes the moment `visualize` stops MATCHING THE REGEX — a
  // deleted registration, a renamed component, a typo — so it would certify the deletion
  // and assert nothing at all about the replacement. A clause that can be satisfied by
  // removing the thing it guards is not a guard.
  //
  // So both halves are asserted together: the centre hero is still the ONE area-routed
  // pane, AND `visualize` is positively routed to the section stack.
  const src = readFileSync(path.join(WB, 'core/shell/dock/panes.tsx'), 'utf8')
  const routed = [...src.matchAll(/registerPaneRenderer\('([^']+)',\s*\(\)\s*=>\s*<PlacedArea/g)].map(m => m[1])
  // Was three, then two. `selection` was retired (a SECOND host for an area whose views
  // already reconcile into their own right-region `view` panes); `visualize` is now a
  // section stack.
  expect(routed).toEqual(['canvas'])
  const sectioned = [...src.matchAll(/registerPaneRenderer\('([^']+)',\s*\(\)\s*=>\s*<SectionStack pane="([^"]+)"/g)]
  expect(sectioned.map(m => [m[1], m[2]])).toEqual([['visualize', 'visualize']])
  // …and the mobile shell agrees. The desktop pane and the mobile LEFT sheet are two
  // separate render sites for one surface, and a rewrite that fixed only the desktop one
  // would leave the phone rendering the retired area — which is exactly the split that
  // makes a surface "work" in the tests and not on a device.
  const mobile = readFileSync(path.join(WB, 'core/shell/MobileShell.tsx'), 'utf8')
  expect(mobile).toMatch(/area === 'left'\) return <SectionStack pane="visualize"/)
  expect(mobile).toMatch(/<PlacedArea area=\{area\} \/>/)
})

test('TEST-7: every pane kind resolves a renderer after registration; unknown falls back VISIBLY', () => {
  registerPanes()
  const unresolved = PANE_KINDS.filter(k => !paneRenderers[k])
  expect(unresolved, 'these pane kinds have no renderer').toEqual([])
  // The fallback contract that makes an unknown kind safe.
  expect(typeof FallbackPane).toBe('function')
})

// ── TEST-18 (ITEM-13/36): installWidgets alone registers the form controls, NONE of the 5 ──
// The existing coverage only ran the COMBINED installer, which by construction cannot
// distinguish "installWidgets excludes the plot kinds" from "they are registered anyway".
//
// The count went 11 → 12 with `artifact_ref` (ITEM-7): the VISIBLE form of an analysis
// input is a core form control, so the form-control installer is where it belongs.
// 12 → 14 with `tabs` (ITEM-16) + `token-input` (ITEM-17), geneset increment 1: both are
// generic form-vocabulary controls (a segmented tab group + a chip list), so they register
// through the SAME form-control installer. (The `lineage` widget (DEC-11) is a DISPLAY widget
// registered by the VISUALIZE extension, NOT here — see primitivesDisposition's mount-path count.)

test('TEST-18: `installWidgets()` ALONE registers exactly the 14 form-control kinds', () => {
  __resetInstallWidgetsForTests()
  __clearWidgetsForTests()
  installWidgets()
  expect(registeredWidgetKinds().sort()).toEqual(
    [
      'alert',
      'artifact_ref',
      'button',
      'dataset-picker',
      'group',
      'list-editor',
      'multiselect',
      'range_slider',
      'select',
      'stat',
      'table',
      'tabs',
      'text',
      'token-input',
    ].sort(),
  )
})

test('TEST-18: `installWidgets()` registers NONE of the 5 plot kinds — viz.tsx did not travel', () => {
  __resetInstallWidgetsForTests()
  __clearWidgetsForTests()
  installWidgets()
  const leaked = [...CANVAS_WIDGET_KINDS].filter(k => hasWidget(k))
  expect(leaked, 'a plot kind is registered by the FORM-CONTROL installer').toEqual([])
  // Positive control: those kinds are real and canvas owns exactly five of them.
  expect([...CANVAS_WIDGET_KINDS].sort()).toEqual(['bar', 'histogram', 'image', 'scatter', 'violin'])
})

// ── TEST-27 (ITEM-33) / TEST-28 (ITEM-34): the TYPE + manifest-key + schema removals ──
// The existing coverage asserted the registry SLOT is gone. The declared clauses also
// covered the contribution TYPE, the `validate.ts` entry and the `schema.json` property —
// each a separate place the deleted concept could survive and be re-grown from.

test('TEST-27: the `FieldProviderContribution` type is gone from production code', () => {
  expect(offenders(/\bFieldProviderContribution\b/)).toEqual([])
})

test('TEST-28: the `PlotTypeContribution` type + the conformance subtree are gone', () => {
  expect(offenders(/\bPlotTypeContribution\b/)).toEqual([])
  expect(offenders(/\b(registerViewKind|runViewKindConformance|allViewKinds)\b/)).toEqual([])
  expect(existsSync(path.join(WB, 'core/conformance')), 'the conformance subtree survived DEC-L').toBe(false)
})

test('TEST-27/28: neither key survives in `validate.ts` OR in the manifest JSON schema', () => {
  // Two independent places a manifest key lives. A key removed from one and not the other
  // means a manifest can still DECLARE it and be silently accepted (or rejected) by turns.
  for (const k of ['fieldProviders', 'plotTypes', 'resultRenderers', 'selectionActions', 'collections', 'commands'])
    expect(KNOWN_CONTRIBUTES.has(k), `validate.ts still accepts the \`${k}\` manifest key`).toBe(false)
  // Positive control: the survivors ARE accepted.
  for (const k of CONTRIBUTION_KINDS) expect(KNOWN_CONTRIBUTES.has(k), `validate.ts dropped \`${k}\``).toBe(true)

  const schema = JSON.parse(readFileSync(path.join(WB, 'core/manifest/schema.json'), 'utf8'))
  const props = JSON.stringify(schema)
  for (const k of ['plotTypes', 'fieldProviders', 'resultRenderers'])
    expect(props.includes(`"${k}"`), `schema.json still declares a \`${k}\` property`).toBe(false)
  // Positive control: the schema is a real schema.
  expect(props.includes('"analyses"'), 'schema.json lost its analyses property').toBe(true)
})

test('TEST-28: `analysis/discovery.ts` no longer reads a `plot_type` source', () => {
  const code = readFileSync(path.join(WB, 'extensions/analysis/discovery.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !/^\s*\/\//.test(l))
    .join('\n')
  expect(code).not.toMatch(/plot_type|plotTypes/)
  // Positive control: discovery still reads the sources it SHOULD.
  expect(code).toMatch(/fromSources|produces/)
})

// ── TEST-29 (ITEM-35): each SURVIVING slot has ≥1 production registrar ───────
// The sweep's criterion was "a slot with zero production contributors is deleted". The
// existing coverage pinned the survivor LIST; this enforces the criterion going forward,
// so a slot that quietly loses its last registrar is caught rather than re-measured by hand.

test('TEST-29: every surviving contribution slot has ≥1 PRODUCTION registrar', () => {
  const files = productionCode().filter(f => !f.file.includes('__testutil__'))
  expect(files.length).toBeGreaterThanOrEqual(180)
  for (const kind of CONTRIBUTION_KINDS) {
    const re = new RegExp(`\\.${kind}\\.register\\s*\\(`)
    const registrars = files.filter(f => re.test(f.code)).map(f => f.file)
    expect(
      registrars.length,
      `contribution slot \`${kind}\` has NO production registrar — by the ITEM-35 criterion it ` +
        'should be deleted, not kept',
    ).toBeGreaterThanOrEqual(1)
  }
})

// ── TEST-30 (ITEM-31 / DEC-G): `StandardResultTable` is gone ────────────────

test('TEST-30: `StandardResultTable` does not resolve anywhere in production code', () => {
  expect(offenders(/\bStandardResultTable\b/)).toEqual([])
})

// ── TEST-32 (ITEM-15/16): the processor-packages directory + the demo analysis ──

test('TEST-32: `ui/src/processor-packages/` does not exist', () => {
  expect(existsSync(path.join(REPO, 'src-app/ui/src/processor-packages'))).toBe(false)
})

test('TEST-32: no production code globs `processor-packages`, and `selection.demo` is unregistered', () => {
  expect(offenders(/processor-packages/)).toEqual([])
  expect(offenders(/['"`]selection\.demo['"`]/)).toEqual([])
  // Positive control: the two surviving processor DATA globs are still there — deleting
  // the FE-code glob must not have taken the data globs with it.
  const loader = readFileSync(path.join(WB, 'core/runtime/loadProcessors.ts'), 'utf8')
  expect(loader).toMatch(/import\.meta\.glob/)
  expect(loader).toMatch(/manifest\.yaml/)
  expect(loader).toMatch(/ui\/\*\.yaml/)
})

// ── TEST-52 (INV-5): no code path EVALUATES a string supplied by a view_spec ──
// The clause the existing coverage omitted. `EFFECT_OPS` being a closed set is necessary
// but not sufficient: an `eval` anywhere in the interpreter would reopen it.

test('TEST-52: no production module evaluates a spec-supplied string or function', () => {
  const files = productionCode()
  expect(files.length).toBeGreaterThanOrEqual(180)
  const bad = files
    .filter(f => /\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]|\bunsafeEval\b/.test(f.code))
    .map(f => f.file)
  expect(bad, 'a dynamic-evaluation primitive reached the declarative engine — INV-5 is open').toEqual([])
})

// ── TEST-53 (INV-6): each capability CONTRACT is exported by its publishing extension ──
// The existing coverage asserted core names no capability. The other half — that the
// contract is published SOMEWHERE — was not asserted, and a contract exported by nobody
// is just a deleted contract.

test('TEST-53: every published capability contract is exported by its extension barrel', () => {
  const extBarrel = readFileSync(path.join(WB, 'extensions/index.ts'), 'utf8')
  // The two capabilities registered at module evaluation.
  for (const id of ['DATA_CAPABILITY_ID', 'JOBS_CAPABILITY_ID'])
    expect(extBarrel, `${id} is not published by the extensions barrel`).toContain(id)
  for (const contract of ["'./data/contract'", "'./jobs/contract'"])
    expect(extBarrel, `the ${contract} module is not re-exported`).toContain(contract)
  // And core does NOT name them — the INV-6 direction the broker test already covers,
  // asserted here against the two REAL ids rather than a regex over type names.
  const coreBarrel = readFileSync(path.join(WB, 'core/index.ts'), 'utf8')
  for (const id of ['DATA_CAPABILITY_ID', 'JOBS_CAPABILITY_ID'])
    expect(coreBarrel, `core/index.ts names the capability \`${id}\` — INV-6 forbids it`).not.toContain(id)
})

// ── TEST-5 [covers: ITEM-1b] — SIX parsers of one file must agree on `sections` ──
//
// `contributes.sections` is gated in six independent places: TWO Rust parsers (the
// runtime `extensions/types.rs` and the `deny_unknown_fields` build lint that PANICS
// `build.rs`) and FOUR TypeScript ones (`schema.json`'s `additionalProperties:false`
// `contributes` block, `validate.ts`'s `KNOWN_CONTRIBUTES`, `workbenchRegistry.ts`'s
// `CONTRIBUTION_KINDS`, and the `ManifestContributes` interface, which fails `tsc` on
// an unknown key). Four of the six are lint/compile-level rather than runtime gates,
// which is exactly why omitting one fails a CHECK somewhere far away instead of the
// app — and why the six are pinned together, here, in one place that names all of them.
//
// The Rust two are asserted through their SOURCE (this is a vitest process; it cannot
// run cargo). Their behavioural proof is TEST-1/TEST-2/TEST-3 on the Rust side; what
// this adds is that a TS-side change can never silently drift away from them.

test('TEST-5: all six manifest gates accept `sections` as a contribution kind', () => {
  const SERVER = path.join(REPO, 'src-app/server')

  // (1) the registry kinds — the slot the shell renders from
  expect([...CONTRIBUTION_KINDS], 'CONTRIBUTION_KINDS is missing `sections`').toContain('sections')

  // (2) validate.ts — the manifest-key allowlist
  expect(KNOWN_CONTRIBUTES.has('sections'), 'validate.ts rejects the `sections` manifest key').toBe(true)

  // (3) schema.json — `contributes` is additionalProperties:false, so an undeclared
  //     property is a schema violation, not an ignored key.
  const schema = JSON.parse(readFileSync(path.join(WB, 'core/manifest/schema.json'), 'utf8'))
  const contributes = schema.properties?.contributes
  expect(contributes?.additionalProperties, 'the schema stopped denying unknown contributes keys')
    .toBe(false)
  expect(Object.keys(contributes?.properties ?? {}), 'schema.json declares no `sections` property')
    .toContain('sections')

  // (4) ManifestContributes — the compile-time gate. `tsc` is the real enforcement;
  //     this asserts the declaration exists at all, so a deletion is caught even by a
  //     tree that happens not to read the key yet.
  const manifestTypes = readFileSync(path.join(WB, 'core/manifest/types.ts'), 'utf8')
  expect(manifestTypes, 'ManifestContributes declares no `sections` key').toMatch(
    /interface ManifestContributes[\s\S]*?\n}/,
  )
  const contributesBlock = manifestTypes.match(/interface ManifestContributes[\s\S]*?\n}/)![0]
  expect(contributesBlock, 'ManifestContributes is missing `sections?`').toMatch(/\bsections\?:/)

  // (5) the RUNTIME Rust parser
  const rustRuntime = readFileSync(path.join(SERVER, 'src/modules/extensions/types.rs'), 'utf8')
  expect(rustRuntime, 'extensions/types.rs has no `sections` field on `Contributes`').toMatch(
    /pub sections: Vec<SectionContribution>/,
  )

  // (6) the BUILD LINT — the one whose absence is a broken build rather than a failing
  //     test, because it is `deny_unknown_fields` and `build.rs` panics on it.
  const rustLint = readFileSync(path.join(SERVER, 'build_helper/processor_manifest.rs'), 'utf8')
  expect(rustLint, 'the build lint has no `sections` field — a declaring package would PANIC build.rs')
    .toMatch(/sections: Vec<Section>/)

  // Positive control: the scan is reading real files, not empty strings.
  expect(rustRuntime.length, 'extensions/types.rs read empty').toBeGreaterThan(1000)
  expect(rustLint.length, 'processor_manifest.rs read empty').toBeGreaterThan(1000)
  expect(manifestTypes.length, 'manifest/types.ts read empty').toBeGreaterThan(500)
})

// ── TEST-87 (visualize-pane ITEM-69): the two senses of "packages" are SEPARATED ──────
//
// The rename gave one word two jobs and then took one back: `src-app/packages/` used to
// hold the two npm LIBRARIES (`@txresbench/viz`, `@txresbench/dock`) and now holds the contributed
// DATA packages, with the libraries moved out to `src-app/libs/`.
//
// The hazard is silent in BOTH directions, which is why this asserts both:
//
//   · npm IGNORES a `workspaces`-glob-matched directory that has no `package.json`. So
//     leaving `src-app/packages/*` in the globs after the move would neither error nor
//     do anything — it would simply sit there naming the wrong tree, and the first
//     reader to add a `package.json` under a contributed package would silently acquire
//     a workspace.
//   · a glob that no longer resolves the libraries is equally silent at install time and
//     surfaces much later as an unresolvable `@txresbench/viz` import.
//
// So: the globs must REACH the libraries at their new home, must NOT claim the
// contributed-package tree — and that tree must really be the one with no `package.json`
// in it. Its members are DISCOVERED, never named: what makes a folder there a package is
// its `manifest.yaml`, and that is the property asserted.

test('TEST-87 (ITEM-69): the workspace globs reach src-app/libs and do NOT claim src-app/packages', () => {
  const rootPkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
    workspaces: string[]
  }
  const globs = rootPkg.workspaces
  expect(globs, 'the root package.json declares no workspaces').toBeInstanceOf(Array)

  // The libraries' new home is declared…
  expect(globs).toContain('src-app/libs/*')
  // …and the contributed-package tree is NOT a JS workspace root any more.
  expect(globs).not.toContain('src-app/packages/*')

  // The glob RESOLVES: both libraries are on disk under it, each with the package.json
  // that makes it a workspace (this is the half a glob edit alone cannot promise).
  for (const [dir, name] of [
    ['libs/viz', '@txresbench/viz'],
    ['libs/dock', '@txresbench/dock'],
  ]) {
    const manifest = path.join(REPO, 'src-app', dir, 'package.json')
    expect(existsSync(manifest), `${dir}/package.json is missing — the glob resolves nothing`).toBe(true)
    expect(JSON.parse(readFileSync(manifest, 'utf8')).name).toBe(name)
  }

  // The contributed packages really are the OTHER kind of package: the tree is populated
  // and not one of its entries carries a `package.json`. That is what makes the retired
  // glob harmless rather than merely unused — and it is the property that would break
  // first if the two senses ever started to merge again.
  const contributed = path.join(REPO, 'src-app/packages')
  const entries = readdirSync(contributed, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__')
    .map(e => e.name)
  // Positive control on the SCAN, not on any one member: the tree really is the package
  // tree (its members carry manifests), so the absence assertion below is not vacuous.
  const withManifest = entries.filter(n => existsSync(path.join(contributed, n, 'manifest.yaml')))
  expect(withManifest.length, 'the contributed-package tree resolved nothing — the move did not land')
    .toBeGreaterThanOrEqual(5)
  const withPackageJson = entries.filter(n => existsSync(path.join(contributed, n, 'package.json')))
  expect(withPackageJson, 'a contributed package carries a package.json').toEqual([])
})
