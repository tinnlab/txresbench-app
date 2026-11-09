/**
 * TEST-UR-13 — txrresults module shape + the PROV-UR-1 route surface
 * (INV-2, INV-4, INV-5; ITEM-1), plus the reconcile-growth TEST-UR-11 rows
 * that also belong to ITEM-1 (the path builders + the reserved
 * `compare`/`methods` segments — the main-enumeration and growth-block
 * numbering collision is recorded in the node's DRIFT-1 ledger).
 *
 * The module is a framework module: auto-discovered by the loader glob in
 * `modules/loader.ts` (`import.meta.glob` over module.tsx files in the
 * modules tree), registering exactly the three run routes under the shell
 * layout, with NO eager store, NO slot, NO component and NO permission
 * predicate (the results store registers whole-store-lazy in its own file,
 * the `DatasetDetail` precedent — `stores: []`). The no-edits assertions
 * below run over the item's own delta (the working tree against HEAD while
 * uncommitted; the tip commit's file set when committed): the plan's
 * no-go list (DEC-16) — no generated client, no OpenAPI, no guard/script,
 * no package.json line, no txrshell edit, no loader edit, no server path.
 * The status-word / design-example-number / study-literal scans cover the
 * module's own `.ts`/`.tsx` files (INV-4/5) — the item's copy carries the
 * boards' words, never the boards' numbers.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppModule } from '@ziee/framework/module-system/types'
import txrResultsModule from './module'
import { TxrLayoutDef } from '../txrshell/module'
import { compareResultsPath, methodResultsPath, resultsPath } from './index'

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

/**
 * The file set DELIVERED BY THIS ITEM, in either of the two states it is
 * verified in. Uncommitted (the item's own verification run): the working
 * tree against HEAD. Committed (the branch gate): the tip commit's own diff
 * — the item commit or its report record commit, both of which are this
 * item's file set. The item base is HEAD, not `main` (main is the untouched
 * epic integration base; see DRIFT-1).
 */
function itemDelta(): string[] {
  // The tests run from `src-app/ui`, and git prints STATUS/LS-FILES paths
  // relative to the working directory while DIFF paths are repo-root
  // relative — so the three sources must be read from the ROOT with `-C`,
  // otherwise an untracked file (qa-fixes ITEM-7's new files) would be
  // reported on the wrong base and the no-edit pins would misfire
  // (`src-app/ui/scripts/…` arriving as `scripts/…`). The txrhelp sweep's
  // convention.
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

/** Every `.ts`/`.tsx` file under the module dir (the publish surface of the module). */
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

const ROUTES = '/analysis/:runId/results'

describe('txrresults module (TEST-UR-13)', () => {
  it('registers as a framework module with the planned metadata', () => {
    expect(txrResultsModule.metadata).toEqual({
      name: 'txrresults',
      version: '1.0.0',
      description:
        'TxResBench results — patient × method heatmap (G) and one-method detail (H)',
    })
  })

  it('owns exactly the three run routes, each guarded under the shell layout', () => {
    const routes = routesOf(txrResultsModule)
    expect(routes.map(r => r.path)).toEqual([
      `${ROUTES}`,
      `${ROUTES}/compare`,
      `${ROUTES}/methods/:methodId`,
    ])
    for (const route of routes) {
      expect(route.requiresAuth).toBe(true)
      expect(route.layout).toBe(TxrLayoutDef)
      expect(route.permission).toBeUndefined()
    }
  })

  it('registers an empty store list (the store is whole-store-lazy) and no slot, component or predicate', () => {
    // `stores: []` per PROV-UR-1: the results store registers with
    // `registerLazyStore` in its own file (the `DatasetDetail` precedent),
    // so the module declares no eager store and no other registration.
    expect(txrResultsModule.registerStores?.()).toEqual([])
    expect(
      (txrResultsModule as AppModule & { registerComponents?: unknown }).registerComponents,
    ).toBeUndefined()
    expect(
      (txrResultsModule as AppModule & { registerSlots?: unknown }).registerSlots,
    ).toBeUndefined()
    expect((txrResultsModule as unknown as Record<string, unknown>).shouldLoad).toBeUndefined()
    expect(txrResultsModule.initialize).toBeUndefined()
    expect(txrResultsModule.cleanup).toBeUndefined()
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).not.toContain("import('./stores/")
    expect(source).not.toContain("from './stores/")
  })

  it('declares exactly the router and the shell as framework dependencies', () => {
    expect(txrResultsModule.registerDependencies?.()).toEqual(['router', 'txrshell'])
  })

  it('is picked up by the loader auto-discovery glob', () => {
    const files = import.meta.glob('./**/module.tsx', { eager: true }) as Record<
      string,
      { default: unknown }
    >
    expect(Object.keys(files)).toContain('./module.tsx')
    expect(files['./module.tsx'].default).toBe(txrResultsModule)
  })

  it('routes the two lazy pages the module declares', () => {
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('lazyWithPreload')
    expect(source).toContain("import('./pages/ResultsPage')")
    expect(source).toContain("import('./pages/MethodResultsPage')")
  })

  it('does not change the generated client, the openapi, the guards, the shell or the loader (DEC-16)', () => {
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
    // TWO shell exceptions. (i) The sanctioned `/models` route handoff of
    // the `feat/ui-models` item (recorded in its DRIFT-1 #8): the
    // `txrmodels` module takes over the shell's `/models` scaffold route —
    // the route block is removed from `txrshell/module.tsx` with the
    // handoff comment. (ii) The qa-fixes ITEM-4 RES-09 fix: the layout's
    // `<main>` around every module's page becomes a `<div>` (the routes
    // inside each already render their own `<main>` — the nested landmark
    // named no ASI for screen readers); the four `txrintake` pages carry
    // the `role="main"` on their own container instead. Nothing else in
    // the shell moves.
    expect(
      touched.filter(
        p =>
          p.startsWith('src-app/ui/src/modules/txrshell/') &&
          p !== 'src-app/ui/src/modules/txrshell/module.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/pages/ShellPage.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/TxrLayout.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/TxrLayout.test.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/gallery.tsx' &&
          // qa-fixes2 ITEM-1 (the theme switch): the new toggle component + its unit test.
          p !== 'src-app/ui/src/modules/txrshell/TxrThemeToggle.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/TxrThemeToggle.test.tsx' &&
          // qa-fixes2 ITEM-2 (the location-neutral copy guard): its test file
          // + allow-list, the item's own new txrshell files.
          p !== 'src-app/ui/src/modules/txrshell/lib/copyGuard.test.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/copyGuard.allowlist.json' ,

      ),
    ).toEqual([])
    expect(touched.filter(p => p === 'src-app/ui/src/modules/loader.ts')).toEqual([])
    // The whole server half of the qa-fixes ITEM-2 delta (its DRIFT-1):
    // the method_catalogue eligibility/estimate/routes/types rework
    // (CM-1/CM-6/CM-7), the execution_engine environment-classify detail,
    // the model_store + pretrained reason-code vocabulary growth and the
    // method_catalogue API test, plus the execution_engine types/README + the
    // integration tests whose ENV_UNKNOWN pins the one-vocabulary change
    // reclassifies (DRIFT-1 ITEM-2 #2) — pinned verbatim; anything else under
    // `src-app/server/` still fails.
    // The qa-fixes ITEM-4 server half (its DRIFT-1): the predictions
    // response grows the per-column `label` (the saved model's name for a
    // reuse run) and resolves its group label through that name — the
    // execution_engine `types.rs` (again, ITEM-2's file) + `routes.rs`.
    // Nothing else under `src-app/server/` moves.
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
  })

  it('carries no status words and no literal design-example numbers in its own files (INV-4/5)', () => {
    // The status-word scan targets SHIPPED COPY that promises or announces
    // work not yet done. The kit `Input`/`MultiSelect` input-hint props
    // (spelled exactly like one of those status words) are INPUT AFFORDANCES,
    // not copy marks — their API occurrences (`placeholder="…"`,
    // `searchPlaceholder="…"`) are stripped before the word scan; any other
    // spelling in comments, copy or fixtures still fails. Same precision as
    // the txrintake scan (its ITEM-5); DRIFT-1 ITEM-6.
    const kitHintProp = new RegExp('place' + 'holder' + '\\s*=\\s*"[^"]*"', 'gi')
    const own = ownSourceFiles(MODULE_DIR)
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .replace(kitHintProp, '')
      .toLowerCase()
    const statusWords = ['to' + 'do', 't' + 'bd', 'place' + 'holder', 'coming so' + 'on', 'in pro' + 'gress']
    for (const word of statusWords) {
      expect(own).not.toContain(word)
    }
    // The boards' example facts (BusyResults/Results boards) — never code.
    const designExampleBareCounts = [
      'p04' + '12',
      'p03' + '88',
      '38 pa' + 'tients',
      '40 pa' + 'tients',
      '151 pa' + 'tients',
      '11 of ' + '12',
      '14 of ' + '38',
      'show all ' + '38',
    ]
    for (const phrase of designExampleBareCounts) {
      expect(own).not.toContain(phrase)
    }
  })

  it('spells no study literal in its own source files (INV-4)', () => {
    // The publish surface only — the test file itself may name the scanned
    // token (this build of the scan excludes `*.test.ts` files, which is
    // also how the module's copy stays scannable by the guard's own rules).
    const own = ownSourceFiles(MODULE_DIR)
      .filter(p => !/\.test\.(ts|tsx)$/.test(p))
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .toLowerCase()
    const studyRe = new RegExp('st' + 'ud(y|ies)', 'i')
    expect(studyRe.test(own)).toBe(false)
  })
})

describe('PROV-UR-1 — the path builders (reconcile-growth TEST-UR-11)', () => {
  it('builds the three documented paths', () => {
    expect(resultsPath('run-1')).toBe('/analysis/run-1/results')
    expect(compareResultsPath('run-1')).toBe('/analysis/run-1/results/compare')
    expect(methodResultsPath('run-1', 'landmark-cox-current')).toBe(
      '/analysis/run-1/results/methods/landmark-cox-current',
    )
  })

  it('keeps `compare` and `methods` reserved path words, never method ids', () => {
    // The route table has exactly the three routes: the segment after
    // /analysis/<runId>/results is either the literal `compare` or the
    // literal `methods`, and a method id is spliced only after `methods/`.
    const routes = routesOf(txrResultsModule).map(r => r.path)
    expect(routes).not.toContain(`${ROUTES}/:tab`)
    expect(methodResultsPath('run-1', 'compare')).toBe(
      '/analysis/run-1/results/methods/compare',
    )
    // The builders never interpolate the reserved words as id prefixes.
    const source = readFileSync(fileURLToPath(new URL('./routes.ts', import.meta.url)), 'utf8')
    expect(source).toContain('`/analysis/${runId}/results/compare`')
    expect(source).toContain('`/analysis/${runId}/results/methods/${methodId}`')
  })

  it('re-exports the three builders from the module barrel', () => {
    const barrel = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
    expect(barrel).toContain("export * from './routes'")
  })

  it('README documents the routes, the events, the provider binding and the copy source', () => {
    const readme = readFileSync(fileURLToPath(new URL('./README.md', import.meta.url)), 'utf8')
    expect(readme).toContain('/analysis/:runId/results')
    expect(readme).toContain('txr:save-models-requested')
    expect(readme).toContain('txr:save-one-model-requested')
    expect(readme).toContain('ui-models')
    expect(readme).toContain('provider-owned')
    expect(readme).toContain('verbatim')
    expect(readme).toContain('design examples')
  })
})
