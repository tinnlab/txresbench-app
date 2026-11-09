/**
 * TEST-HELP-4 — the txrhelp module shape + the `/help` route handoff
 * (ITEM-4, TEST-QA-4).
 *
 * The module is a framework module: auto-discovered by the loader glob in
 * `modules/loader.ts` (`import.meta.glob` over module.tsx files in the
 * modules tree), registering exactly the one `/help` route under the shell
 * layout, with NO store (the page is static content), NO slot, NO
 * component and NO permission predicate (all routes are `requiresAuth`
 * under the local single-user session).
 *
 * The no-edits assertions below run over the item's own delta (working tree
 * against HEAD while uncommitted; the tip commit's file set when committed
 * — the same dual-state convention the sibling module tests use). The
 * sanctioned exceptions of THIS item: `txrshell/module.tsx` (the `/help`
 * handoff) + `txrshell/pages/ShellPage.tsx` (the scaffold page the shell
 * no longer references — removed with the handoff) + the `txrintake` files
 * (the problem-list help links: module.tsx dependency line, the
 * TxrProblemList component, the TxrFileCard test's router wrapper and the
 * module test's stale pins) + the sibling module test files whose shell
 * pins the handoff invalidates (`txrhistory`, `txrmodels`, `txrrun`).
 *
 * The status-word / design-example-number / URL / study-token covers scan
 * the module's own publish surface (non-test source + comments).
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppModule } from '@ziee/framework/module-system/types'
import txrHelpModule from './module'
import { TxrLayoutDef } from '../txrshell/module'
import txrShellModule from '../txrshell/module'
import { helpPath } from './index'

type RouteEntry = {
  path?: string
  requiresAuth?: boolean
  layout?: unknown
  permission?: unknown
}

function routesOf(module: unknown): RouteEntry[] {
  return (module as AppModule & { routes?: RouteEntry[] }).routes ?? []
}

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))
const SHELL = 'src-app/ui/src/modules/txrshell/module.tsx'

/**
 * The file set DELIVERED BY THIS ITEM, in either of the two states it is
 * verified in (the sibling module tests' convention).
 */
function itemDelta(): string[] {
  // The tests run from `src-app/ui`, and git prints STATUS/LS-FILES paths
  // relative to the working directory while DIFF paths are repo-root
  // relative — so the three sources must be read from the ROOT with `-C`,
  // otherwise an untracked file (the new spec) would be dropped below.
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const git = (args: string[]): string[] => {
    try {
      return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    } catch {
      return []
    }
  }
  if (git(['status', '--porcelain']).length > 0) {
    return [
      ...new Set([
        ...git(['diff', '--name-only', 'HEAD']),
        ...git(['diff', '--name-only', '--cached']),
        ...git(['ls-files', '--others', '--exclude-standard']),
      ]),
    ].sort()
  }
  return git(['show', '--name-only', '--format=', 'HEAD']).sort()
}

/** Every `.ts`/`.tsx` file under the module dir (the publish surface). */
function ownSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...ownSourceFiles(p))
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(p)
    }
  }
  return out
}

/**
 * The shell file's change, as added/removed lines (the sibling tests'
 * convention; this item IS the newest shell-touching item, so while the
 * working tree is dirty the lookup takes the WORKING diff, and once
 * committed the nearest shell-touching commit is this item's).
 */
function shellPatch(): { added: string[]; removed: string[] } {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const git = (args: string[]): string[] => {
    try {
      return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    } catch {
      return []
    }
  }
  const parse = (lines: string[]): { added: string[]; removed: string[] } => ({
    added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)),
    removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1)),
  })
  if (git(['status', '--porcelain']).length > 0) {
    const working = parse(git(['diff', 'HEAD', '--', SHELL]))
    if (working.added.length > 0 || working.removed.length > 0) return working
  }
  const nearest = git(['log', '--format=%H', '-1', '--', SHELL])[0]
  if (nearest !== undefined) {
    const patch = parse(git(['diff', `${nearest}^`, nearest, '--', SHELL]))
    if (patch.added.length > 0 || patch.removed.length > 0) return patch
  }
  return { added: [], removed: [] }
}

describe('txrhelp module (TEST-HELP-4)', () => {
  it('registers as a framework module with the planned metadata', () => {
    expect(txrHelpModule.metadata).toEqual({
      name: 'txrhelp',
      version: '1.0.0',
      description: 'TxResBench help — what the app does and how to use it.',
    })
  })

  it('owns exactly the one help route, guarded under the shell layout', () => {
    const routes = routesOf(txrHelpModule)
    expect(routes.map(r => r.path)).toEqual(['/help'])
    for (const route of routes) {
      expect(route.requiresAuth).toBe(true)
      expect(route.layout).toBe(TxrLayoutDef)
      expect(route.permission).toBeUndefined()
    }
  })

  it('registers no store, no slot, no component and no predicate (the page is static content)', () => {
    expect(txrHelpModule.registerStores?.()).toEqual([])
    expect(
      (txrHelpModule as AppModule & { registerComponents?: unknown }).registerComponents,
    ).toBeUndefined()
    expect((txrHelpModule as AppModule & { registerSlots?: unknown }).registerSlots).toBeUndefined()
    expect(
      (txrHelpModule as unknown as Record<string, unknown>).shouldLoad,
    ).toBeUndefined()
    expect(txrHelpModule.initialize).toBeUndefined()
    expect(txrHelpModule.cleanup).toBeUndefined()
  })

  it('declares the router and the shell as framework dependencies', () => {
    expect(txrHelpModule.registerDependencies?.()).toEqual(['router', 'txrshell'])
  })

  it('is picked up by the loader auto-discovery glob', () => {
    const files = import.meta.glob('./**/module.tsx', { eager: true }) as Record<
      string,
      { default: unknown }
    >
    expect(Object.keys(files)).toContain('./module.tsx')
    expect(files['./module.tsx'].default).toBe(txrHelpModule)
  })

  it('routes the one lazy page the module declares', () => {
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('lazyWithPreload')
    expect(source).toContain("import('./pages/HelpPage')")
  })

  it('exposes the module façade through the barrel: the help path builder', () => {
    expect(helpPath()).toBe('/help')
    expect(helpPath('problem-r03')).toBe('/help#problem-r03')
    const barrel = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
    expect(barrel).toContain("export * from './routes'")
    expect(barrel).toContain("export * from './types'")
    expect(barrel).toContain('problemAnchorOf')
  })

  it('does not change the generated client, the openapi, the guards, the loader or the server (DEC-15)', () => {
    const touched = itemDelta()
    // The qa-fixes ITEM-2 client surface (its DRIFT-1): the regenerated
    // `types.ts` (the new `ENV_IMAGE_MISSING` reason code + the
    // `total_no_env`/`cpus` eligibility+estimate fields) and the
    // regenerated `openapi.json` — the ONLY two generated files this item
    // moves; the pins stay strict for anything else under either prefix.
    expect(
      touched.filter(
        p =>
          p.startsWith('src-app/ui/src/api-client/') &&
          p !== 'src-app/ui/src/api-client/types.ts',
      ),
    ).toEqual([])
    expect(
      touched.filter(
        p => p.startsWith('src-app/ui/openapi/') && p !== 'src-app/ui/openapi/openapi.json',
      ),
    ).toEqual([])
        // The qa-fixes ITEM-6 scripts half (its DRIFT-1): the input converter's
    // F8 unit fix (scripts/dev-registry/make-real-inputs.py + its new test)
    // and the file-validator generator's F6 example rounding
    // (scripts/file-validator/gen_material.py + the regenerated fixture
    // expected example bytes). Nothing else under scripts/ moves.
    expect(
      touched.filter(
        p =>
          p.startsWith('scripts/') &&
          p !== 'scripts/dev-registry/make-real-inputs.py' &&
          p !== 'scripts/dev-registry/make_real_inputs.test.py' &&
          p !== 'scripts/file-validator/gen_material.py' &&
          p !== 'scripts/file-validator/fixtures/expected/examples/patients.csv' &&
          p !== 'scripts/file-validator/fixtures/expected/examples/measurements.csv',
      ),
    ).toEqual([])
    // qa-fixes ITEM-7 (X1): the built-CSS url check — one script file
    // (`scripts/check-built-css-urls.mjs`, wired into the vite
    // closeBundle), sanctioned verbatim with the fonts fix.
    expect(touched.filter(p => p.startsWith('src-app/ui/scripts/') &&
          p !== 'src-app/ui/scripts/check-built-css-urls.mjs')).toEqual([])
    expect(touched.filter(p => p === 'src-app/ui/package.json')).toEqual([])
    expect(touched.filter(p => p === 'src-app/ui/package-lock.json')).toEqual([])
    expect(touched.filter(p => p === 'src-app/ui/scripts/domain-baseline.json')).toEqual([])
    expect(touched.filter(p => p === 'src-app/ui/src/modules/loader.ts')).toEqual([])
    // The whole server half of the qa-fixes ITEM-2 delta (its DRIFT-1):
    // the method_catalogue eligibility/estimate/routes/types rework
    // (CM-1/CM-6/CM-7), the execution_engine environment-classify detail,
    // the model_store + pretrained reason-code vocabulary growth and the
    // method_catalogue API test, plus the execution_engine types/README + the
    // integration tests whose ENV_UNKNOWN pins the one-vocabulary change
    // reclassifies (DRIFT-1 ITEM-2 #2) — pinned verbatim; anything else under
    // `src-app/server/` still fails.
    // The qa-fixes ITEM-5 server half (its DRIFT-1): ModelSummary grows
    // the `marker_kind` fact (model_store types.rs + store.rs) — the J
    // "any marker" subline for the catalogue-`any` rows (RES-19) — and the
    // A04 unit note stops quoting a blank canonical unit
    // (file_validator/units.rs, RES-24). Nothing else moves.
    // The qa-fixes ITEM-6 server half (its DRIFT-1): the patients summary
    // grows the `primary_outcome_events` fact (file_validator types.rs +
    // validate.rs — the board's "N progressions or deaths" is the EVENTS
    // count, never with_primary_outcome; F1) and the A04 "no unit-family
    // agreement" wording reads plainly (units.rs again, F5e).
    expect(
      touched.filter(
        p =>
          p.startsWith('src-app/server/') &&
          p !== 'src-app/server/src/modules/method_catalogue/types.rs' &&
          p !== 'src-app/server/src/modules/method_catalogue/eligibility.rs' &&
          p !== 'src-app/server/src/modules/method_catalogue/estimate.rs' &&
          p !== 'src-app/server/src/modules/method_catalogue/routes.rs' &&
          p !== 'src-app/server/src/modules/execution_engine/orchestrator.rs' &&
          p !== 'src-app/server/src/modules/model_store/types.rs' &&
          p !== 'src-app/server/src/modules/pretrained_catalogue/types.rs' &&
          p !== 'src-app/server/tests/method_catalogue/api_test.rs' &&
          p !== 'src-app/server/src/modules/execution_engine/types.rs' &&
          p !== 'src-app/server/src/modules/execution_engine/routes.rs' &&
          p !== 'src-app/server/src/modules/execution_engine/README.md' &&
          p !== 'src-app/server/tests/execution_engine/api_test.rs' &&
          p !== 'src-app/server/tests/execution_engine/bundle_test.rs' &&
          p !== 'src-app/server/tests/history_store/mod.rs' &&
          p !== 'src-app/server/src/modules/model_store/store.rs' &&
          p !== 'src-app/server/src/modules/file_validator/types.rs' &&
          p !== 'src-app/server/src/modules/file_validator/validate.rs' &&
          p !== 'src-app/server/src/modules/file_validator/units.rs' &&
          p !== 'src-app/server/tests/model_store/api_test.rs',
      ),
    ).toEqual([])
    expect(touched.filter(p => p.startsWith('src-app/desktop/'))).toEqual([])
    // The SANCTIONED exceptions (this item's own list, the txrhistory
    // precedent): the `/help` route handoff itself (`txrshell/module.tsx`
    // + the scaffold `ShellPage.tsx` it no longer references), the
    // `txrintake` files the problem-list help links touch (module.tsx
    // dependency line, `TxrProblemList.tsx`, the intake tests whose
    // problem-line pins the appended code link invalidates — TxrFileCard,
    // FilesPage, PredictFilesPage), the sibling module test files
    // whose shell/handoff pins this item maintains, and the qa-fixes
    // ITEM-1 cross-module fixes (its DRIFT-1): the `txrhistory` dir (the
    // RES-01 crash fix + its tests — sanctioned wholesale, the sibling
    // sweeps' convention), the null-vs-undefined
    // audit's finds in `txrintake/lib/flow.ts` + `txrrun/lib/format.ts` +
    // their tests, and the failed-run results state (RES-02) in the
    // `txrresults` pages/components/tests (the same file list the
    // `txrhistory` sweep sanctions, its own comment). The new `txrhelp` dir is an addition (a new
    // auto-discovered module), never an edit of an existing module.
    // The qa-fixes ITEM-2 cross-module surface (its DRIFT-1): the
    // `txrlist` module dir — the item's list/estimate/format rework
    // (CM-1's no-env count, CM-4's rounded durations, CM-5's dark-mode
    // checkboxes), sanctioned wholesale per the sibling-dir convention —
    // the whole `txrrun` module dir — the run screens' qa-fixes ITEM-2
    // settings rework + ITEM-3's running-page rework (header/strip/tabs/
    // table/log-panel/at-a-time, its DRIFT-1), sanctioned wholesale per
    // the sibling-dir convention — and the `txrintake` preview
    // fixtures/pins the estimate/eligibility field additions require.
    // The qa-fixes ITEM-4 shell touch (its DRIFT-1, RES-09): the
    // `txrshell/TxrLayout.tsx` nested-landmark fix — the layout's
    // `<main>` becomes a `<div>` (each route already renders its own
    // `<main>`; the four `txrintake` pages take the `role="main"`).
    expect(
      touched.filter(
        p =>
          p.startsWith('src-app/ui/src/modules/') &&
          !p.startsWith('src-app/ui/src/modules/txrhelp/') &&
          !p.startsWith('src-app/ui/src/modules/txrlist/') &&
          !p.startsWith('src-app/ui/src/modules/txrhistory/') &&
          p !== 'src-app/ui/src/modules/txrshell/module.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/pages/ShellPage.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/TxrLayout.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/TxrLayout.test.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/gallery.tsx' &&
    // qa-fixes ITEM-7 (X3): the session guard's loading/failure
    // surface is tokenized with the pages (its own ink was a
    // hard-coded light hex — a light flash before the app loads).
          p !== 'src-app/ui/src/modules/session/SessionGuard.tsx' &&
          p !== 'src-app/ui/src/modules/txrhistory/module.test.ts' &&
          !p.startsWith('src-app/ui/src/modules/txrrun/') &&
          !p.startsWith('src-app/ui/src/modules/txrresults/') &&
          !p.startsWith('src-app/ui/src/modules/txrmodels/') &&
          !p.startsWith('src-app/ui/src/modules/txrintake/'),
      ),
    ).toEqual([])
    // The specs under tests/ (ITEM-4's own light/dark + narrow render
    // check TEST-QA-4; the qa-fixes ITEM-3 pins in the two txr-run specs,
    // its own DRIFT-1) — nothing else under tests/ moves. The pin is
    // state-aware: `itemDelta` is the CURRENT item's delta, so in ITEM-4's
    // own uncommitted state the delta carries exactly the one spec, and
    // once ITEM-4 is committed a later item's delta carries NO tests/
    // change at all (the spec is part of HEAD, not of the later diff) —
    // the a-posteriori state was failing on the branch's own tip (the
    // qa-fixes plan commit), a stale-pin failure, recorded in qa-fixes
    // DRIFT-1 ITEM-1 #5. At most the sanctioned specs may ever move; a
    // later item adds its own to its own sweep.
    const testsTouched = touched.filter(p => p.startsWith('src-app/ui/tests/'))
    const sanctionedTests = new Set([
      'src-app/ui/tests/gallery-e2e/txr-help.spec.ts',
      'src-app/ui/tests/gallery-e2e/txr-run.spec.ts',
      'src-app/ui/tests/e2e/txrrun/run.spec.ts',
      'src-app/ui/tests/gallery-e2e/txr-results.spec.ts',
      'src-app/ui/tests/e2e/txr-results/results.spec.ts',
      // The qa-fixes ITEM-5 pins in the txr-models gallery spec: the
      // one-accounting totals line and the J subline/fixture growth + the
      // 390 px J story's no-overflow assertion (its own DRIFT-1).
      'src-app/ui/tests/gallery-e2e/txr-models.spec.ts',
      // The qa-fixes ITEM-6 pins in the two txr-intake specs (its own
      // DRIFT-1): the events-line + bounded draw-days + backtick-free
      // problem-line needles in the gallery story, and the same facts
      // through the real backend in the full e2e spec (the " of " fit
      // count, the 206-events/216-day patients line, "draws on 9 days").
      'src-app/ui/tests/gallery-e2e/txr-intake.spec.ts',
      'src-app/ui/tests/e2e/txrintake/txr-intake-full.spec.ts',
      // The qa-fixes ITEM-7 spec (its own DRIFT-1): the 390 px sweep over
      // every txr surface + the shell story + the dark no-light-only pass
      // (TEST-QF-7).
      'src-app/ui/tests/gallery-e2e/txr-theme-phone.spec.ts',
    ])
    expect(testsTouched.length).toBeLessThanOrEqual(sanctionedTests.size)
    for (const file of testsTouched) {
      expect(sanctionedTests, file).toContain(file)
    }
  })

  it('records the txrshell `/help` handoff: every scaffold route is gone, the comment names every takeover', () => {
    expect(routesOf(txrShellModule).map(r => r.path)).toEqual([])
    const shellSource = readFileSync(
      fileURLToPath(new URL('../txrshell/module.tsx', import.meta.url)),
      'utf8',
    )
    expect(shellSource).toContain('`txrintake` module')
    expect(shellSource).toContain('`txrmodels` module')
    expect(shellSource).toContain('`txrhistory` module')
    expect(shellSource).toContain('`txrhelp` module')
    expect(shellSource).not.toContain("path: '/'")
    expect(shellSource).not.toContain("path: '/models'")
    expect(shellSource).not.toContain("path: '/history'")
    expect(shellSource).not.toContain("path: '/help'")
    expect(fileURLToPath(new URL('../txrshell/pages/ShellPage.tsx', import.meta.url))).toBeTruthy()
    expect(existsSync(fileURLToPath(new URL('../txrshell/pages/ShellPage.tsx', import.meta.url)))).toBe(false)

    // The patch itself: removed lines are the `/help` route block + the
    // ShellPage import, added lines are the new comment + the empty routes
    // array; the byte-pin asserts "no other change" (DEC-2).
    const { added, removed } = shellPatch()
    expect(removed.length).toBeGreaterThan(0)
    expect(removed).toContain("      path: '/help',")
    expect(removed).toContain("      element: <ShellPage title=\"Help\" />,")
    expect(removed).toContain("import { ShellPage } from './pages/ShellPage'")
    expect(added.includes('  routes: [],')).toBe(true)
  })

  it('carries no status words, no literal design-example numbers and no URL literal in its own copy (INV-5/6)', () => {
    const own = ownSourceFiles(MODULE_DIR)
      .filter(p => !/\.test\.(ts|tsx)$/.test(p))
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .toLowerCase()
    const statusWords = [
      'to' + 'do',
      't' + 'bd',
      'place' + 'holder',
      'coming so' + 'on',
      'in pro' + 'gress',
    ]
    for (const word of statusWords) {
      expect(own).not.toContain(word)
    }
    // The other pages' board example facts — never help content constants.
    const designExampleBareCounts = [
      '151 pa' + 'tients',
      '38 pa' + 'tients',
      '40 pa' + 'tients',
      '231 da' + 'ys',
      '11 of ' + '12',
      '312 m' + 'b',
      '9 mo' + 'dels',
      '38 me' + 'thods',
      '26 of ' + '38',
      'p04' + '12',
      'p03' + '88',
    ]
    for (const phrase of designExampleBareCounts) {
      expect(own).not.toContain(phrase)
    }
    expect(own).not.toContain('http' + '://')
  })
  // (The study-literal scan the sibling modules carry is deliberately NOT
  // reproduced here: the Help page must name screen B "Your study" — the
  // product's own vocabulary, exactly the txrintake module's case. The
  // real rename guard excludes the txr module family by design (recorded
  // red + unwired on main, the txrintake README + OWNER-5), and THIS
  // module's copy inside the family is the guard's own exclusion — never a
  // baseline of a hit that should be fixed.)
})

