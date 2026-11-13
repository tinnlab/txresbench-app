/**
 * TEST-RUN-01 — txrrun module shape + the PROV-UI-RUN-1 route surface
 * (INV-2, INV-4, INV-5, INV-6; ITEM-1). The TEST-RUN-02 rows for the path
 * builders live in `routes.test.ts` (their own file, per the TESTS map).
 *
 * The module is a framework module: auto-discovered by the loader glob in
 * `modules/loader.ts` (`import.meta.glob` over module.tsx files in the
 * modules tree), registering exactly the two run routes under the shell
 * layout, with NO eager store (the run store registers whole-store-lazy in
 * its own file, the `datasets`/`txrresults` precedent — `stores: []`), NO
 * slot, NO component and NO permission predicate (the app defines no
 * `X::use` for these screens; both routes are `requiresAuth` under the
 * local single-user session). The no-edits assertions below run over the
 * item's own delta (the working tree against HEAD while uncommitted; the
 * tip commit's file set when committed): the plan's no-go list (DEC-14) —
 * no generated client, no OpenAPI, no guard/script, no package.json line,
 * no txrshell edit, no loader edit, no server path, and no edit inside any
 * OTHER module's directory (BASE.md's conflict surface: the node touches
 * its own `txrrun` subdir only — the qa-fixes ITEM-2 exceptions to both,
 * its DRIFT-1, are recorded at the pins below).
 *
 * The status-word / design-example-number / URL / study-literal scans cover
 * the module's own `.ts`/`.tsx` files (INV-4/5/6) — the item's copy carries
 * the boards' words, never the boards' numbers. The scanned tokens are
 * built from split literals so this test file itself stays clear of them
 * (same discipline the sibling modules' scans use).
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppModule } from '@txresbench/framework/module-system/types'
import txrRunModule from './module'
import { TxrLayoutDef } from '../txrshell/module'

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

describe('txrrun module (TEST-RUN-01)', () => {
  it('registers as a framework module with the planned metadata', () => {
    expect(txrRunModule.metadata).toEqual({
      name: 'txrrun',
      version: '1.0.0',
      description:
        'TxResBench run screens — choose the methods and settings (E), then watch the run (F).',
    })
  })

  it('owns exactly the two run routes, each guarded under the shell layout', () => {
    const routes = routesOf(txrRunModule)
    expect(routes.map(r => r.path)).toEqual(['/choose-methods', '/analysis/:runId/running'])
    for (const route of routes) {
      expect(route.requiresAuth).toBe(true)
      expect(route.layout).toBe(TxrLayoutDef)
      expect(route.permission).toBeUndefined()
    }
  })

  it('registers an empty store list (the run store is whole-store-lazy) and no slot, component or predicate', () => {
    // `stores: []` per PROV-UI-RUN-1: the run store registers with
    // `registerLazyStore` in its own file (the `DatasetDetail` precedent),
    // so the module declares no eager store and no other registration.
    expect(txrRunModule.registerStores?.()).toEqual([])
    expect(
      (txrRunModule as AppModule & { registerComponents?: unknown }).registerComponents,
    ).toBeUndefined()
    expect(
      (txrRunModule as AppModule & { registerSlots?: unknown }).registerSlots,
    ).toBeUndefined()
    expect((txrRunModule as unknown as Record<string, unknown>).shouldLoad).toBeUndefined()
    expect(txrRunModule.initialize).toBeUndefined()
    expect(txrRunModule.cleanup).toBeUndefined()
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).not.toContain("import('./stores/")
    expect(source).not.toContain("from './stores/")
  })

  it('declares the router, the shell, the intake, the shared list and the results module as framework dependencies', () => {
    expect(txrRunModule.registerDependencies?.()).toEqual([
      'router',
      'txrshell',
      'txrintake',
      'txrlist',
      'txrresults',
    ])
  })

  it('is picked up by the loader auto-discovery glob', () => {
    const files = import.meta.glob('./**/module.tsx', { eager: true }) as Record<
      string,
      { default: unknown }
    >
    expect(Object.keys(files)).toContain('./module.tsx')
    expect(files['./module.tsx'].default).toBe(txrRunModule)
  })

  it('routes the two lazy pages the module declares', () => {
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('lazyWithPreload')
    expect(source).toContain("import('./pages/ChooseMethodsPage')")
    expect(source).toContain("import('./pages/RunningPage')")
  })

  it('does not change the generated client, the openapi, the guards, the shell, the loader, the server or any other module (DEC-14)', () => {
    const touched = itemDelta()
    // The qa-fixes ITEM-2 client surface (its DRIFT-1): the regenerated
    // `types.ts` (the new `ENV_IMAGE_MISSING` reason code + the
    // `total_no_env`/`cpus` eligibility+estimate fields) and the
    // regenerated `openapi.json` — the ONLY two generated files this item
    // moves; the pins stay strict for anything else under either prefix.
    // The qa-fixes3 ITEM-3 client surface (its DRIFT-1): the regenerated
    // `apiEndpoints.ts` carries the new `Models.exampleSet` route.
    expect(
      touched.filter(
        p =>
          p.startsWith('src-app/ui/src/api-client/') &&
          p !== 'src-app/ui/src/api-client/types.ts' &&
          p !== 'src-app/ui/src/api-client/apiEndpoints.ts' &&
          // ITEM-4 (its DRIFT-1): the api-client was
          // regenerated wholesale after the OpenAPI regen dropped the
          // removed surface; the three remaining client files moved
          // with it.
          p !== 'src-app/ui/src/api-client/index.ts' &&
          p !== 'src-app/ui/src/api-client/permissionDescriptions.ts' &&
          p !== 'src-app/ui/src/api-client/permissions.ts',
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
          // qa-fixes3 ITEM-5 (the e2e-real --example mode): the driver's
          // three-flow extension + its unit test (scripts/dev-registry/
          // e2e-real.py + e2e_real.test.py).
          p !== 'scripts/dev-registry/e2e-real.py' &&
          p !== 'scripts/dev-registry/e2e_real.test.py' &&
          p !== 'scripts/file-validator/gen_material.py' &&
          p !== 'scripts/file-validator/fixtures/expected/examples/patients.csv' &&
          p !== 'scripts/file-validator/fixtures/expected/examples/measurements.csv' &&
          p !== 'scripts/file-validator/gen_help_catalog.sh' &&
          // qa-fixes2 ITEM-2 (location-neutral copy): the notice generator's
          // header reword — "the TxResBench application", not "desktop
          // application" (the generated THIRD-PARTY-NOTICES.md follows).
          p !== 'scripts/third-party.py' &&
          // qa-fixes3 ITEM-1 (the catalogue's human-name fields): the
          // catalogue generator's title/summary/paper_title derivation +
          // the regenerated fixture-mode expected bytes. Nothing else under
          // scripts/ moves for this item.
          p !== 'scripts/method-catalogue/gen_method_catalogue.py' &&
          p !== 'scripts/method-catalogue/fixtures/expected-catalogue.json' &&
          // qa-fixes3 ITEM-3 (the example family, its DRIFT-1): the
          // generator's rewrite, the regenerated fixture expected bytes
          // (incl. the new predict file) and the allowlist's doi.org
          // entry (the ITEM-1 paper link the guard flagged).
          p !== 'scripts/file-validator/fixtures/expected/examples/predict-measurements.csv' &&
          p !== 'scripts/file-validator/fixtures/expected/templates/patients.csv' &&
          p !== 'scripts/network-allowlist.txt',
      ),
    ).toEqual([])
    // qa-fixes ITEM-7 (X1): the built-CSS url check — one script file
    // (`scripts/check-built-css-urls.mjs`, wired into the vite
    // closeBundle), sanctioned verbatim with the fonts fix.
    expect(touched.filter(p => p.startsWith('src-app/ui/scripts/') &&
          p !== 'src-app/ui/scripts/check-built-css-urls.mjs')).toEqual([])
    expect(touched.filter(p => p === 'src-app/ui/package.json')).toEqual([])
    // TWO shell exceptions. (i) The sanctioned `/models` route handoff of
    // the `feat/ui-models` item: the `txrmodels` module takes over the
    // shell's `/models` scaffold route — the route block is removed from
    // `txrshell/module.tsx` with the handoff comment (that module's own
    // test pins the diff). (ii) The qa-fixes ITEM-4 RES-09 fix: the
    // layout's `<main>` around every module's page becomes a `<div>` (the
    // routes inside each already render their own `<main>` — the nested
    // landmark named no ASI for screen readers); the four `txrintake`
    // pages carry the `role="main"` on their own container instead.
    // Nothing else in the shell moves.
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
          p !== 'src-app/ui/src/modules/txrshell/lib/copyGuard.allowlist.json' &&
          // qa-fixes2 ITEM-4 (global + shell): the title hook + its unit
          // test, the not-found screen + its unit test, the TxrLayout
          // brand-link class (the header ring unification's hook) and the
          // shell's catch-all route (module.tsx is sanctioned above).
          p !== 'src-app/ui/src/modules/txrshell/lib/document-title.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/document-title.test.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/pages/NotFoundPage.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/pages/NotFoundPage.test.tsx' &&
          // app-shell ITEM-1 (its DRIFT-1): the shell's layout primitives —
          // the components dir + the two new lib modules (the rewritten
          // TxrLayout/TxrThemeToggle/gallery files are the entries above).
          !p.startsWith('src-app/ui/src/modules/txrshell/components/') &&
          p !== 'src-app/ui/src/modules/txrshell/lib/shellMode.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/shellMode.test.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/scrollCache.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/scrollCache.test.ts' &&
          // qa-fixes4 ITEM-2 (its DRIFT-1): the ONE shared truthful
          // run-status vocabulary — `txrshell/lib/runStatus.ts` + its unit
          // test (the K chip and the G/H header speak the same words; a
          // txrhistory import back would close a module cycle — the
          // resident precedent is ITEM-1's safeText in the shell).
          p !== 'src-app/ui/src/modules/txrshell/lib/runStatus.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/runStatus.test.ts' &&

    // qa-fixes ITEM-7 (X3): the session guard's loading/failure
    // surface is tokenized with the pages (its own ink was a
    // hard-coded light hex — a light flash before the app loads).
          p !== 'src-app/ui/src/modules/session/SessionGuard.tsx',
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
    // The qa-fixes2 ITEM-6 server half (its DRIFT-1): the R2-3 measured-time
    // calibration — the timing-samples migration + the repository
    // record/read, the method_catalogue calibration module, and the
    // estimate/eligibility/routes/orchestrator calibration wiring (the plan's
    // own "server side" wording), plus the method_catalogue module
    // registration.
    expect(
      touched.filter(
        p =>
          p.startsWith('src-app/server/') &&
          p !== 'src-app/server/src/modules/method_catalogue/types.rs' &&
          // qa-fixes3 ITEM-1 (the catalogue's human-name fields): the
          // `Method`/`MethodSummary` wire additions' serialization pins
          // (`catalogue.rs`, with `types.rs` above).
          p !== 'src-app/server/src/modules/method_catalogue/catalogue.rs' &&
          p !== 'src-app/server/src/modules/method_catalogue/eligibility.rs' &&
          p !== 'src-app/server/src/modules/method_catalogue/estimate.rs' &&
          p !== 'src-app/server/src/modules/method_catalogue/routes.rs' &&
          p !== 'src-app/server/src/modules/method_catalogue/mod.rs' &&
          p !== 'src-app/server/src/modules/method_catalogue/calibration.rs' &&
          p !== 'src-app/server/src/modules/execution_engine/orchestrator.rs' &&
          p !== 'src-app/server/src/modules/execution_engine/repository.rs' &&
          p !==
            'src-app/server/src/modules/execution_engine/migrations/202610260011_txr_timing_samples.sql' &&
          p !== 'src-app/server/src/modules/model_store/types.rs' &&
          p !== 'src-app/server/src/modules/pretrained_catalogue/types.rs' &&
          p !== 'src-app/server/tests/method_catalogue/api_test.rs' &&
          // qa-fixes3 ITEM-1 (the catalogue's human-name fields): the
          // integration fixtures carry the three new required fields.
          p !== 'src-app/server/tests/method_catalogue/catalogue_hygiene_test.rs' &&
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
          p !== 'src-app/server/src/modules/file_validator/rules.rs' &&
          p !== 'src-app/server/src/modules/file_validator/mod.rs' &&
          p !== 'src-app/server/src/modules/file_validator/catalog.rs' &&
          p !== 'src-app/server/tests/file_validator/rules_test.rs' &&
          p !== 'src-app/server/tests/model_store/api_test.rs' &&
          // qa-fixes3 ITEM-3 (the example data + the example saved set,
          // its DRIFT-1): the file_validator example endpoint's third kind
          // (assets/routes/README + the pinned material tests), the shared
          // engine run-runtime seam, the model_store example-set module
          // (state machine + migration + routes/types/repository + the
          // integration suite) and the regenerated api-test pins.
          p !== 'src-app/server/src/modules/execution_engine/mod.rs' &&
          p !== 'src-app/server/src/modules/execution_engine/runtime.rs' &&
          p !== 'src-app/server/src/modules/file_validator/README.md' &&
          p !== 'src-app/server/src/modules/file_validator/assets.rs' &&
          p !== 'src-app/server/src/modules/file_validator/routes.rs' &&
          p !== 'src-app/server/src/modules/model_store/README.md' &&
          p !== 'src-app/server/src/modules/model_store/example.rs' &&
          p !== 'src-app/server/src/modules/model_store/migrations/202610270001_txr_example_set.sql' &&
          p !== 'src-app/server/src/modules/model_store/mod.rs' &&
          p !== 'src-app/server/src/modules/model_store/repository.rs' &&
          p !== 'src-app/server/src/modules/model_store/routes.rs' &&
          p !== 'src-app/server/tests/file_validator/api_test.rs' &&
          p !== 'src-app/server/tests/file_validator/material_test.rs' &&
          p !== 'src-app/server/tests/model_store/example_test.rs' &&
          p !== 'src-app/server/tests/model_store/mod.rs' &&
          // qa-fixes2 ITEM-7 (R2-04): the K row's `predicted` doc grows
          // the distinct-patient meaning — history_store/types.rs.
          p !== 'src-app/server/src/modules/history_store/types.rs' &&
          // qa-fixes4 ITEM-2 (its DRIFT-1): the history list item carries the
          // engine's OWN per-state counts (TxrHistoryItem.counts, assembled
          // from txr_runs.counts — history_store/repository.rs;
          // history_store/types.rs above); the Stop-all shape's stopped/
          // skipped rows again surface through the same execution_engine
          // run-record pick (execution_engine/repository.rs, already
          // sanctioned above).
          p !== 'src-app/server/src/modules/history_store/repository.rs',
      ),
    ).toEqual([])
    // The ITEM-13 provider-file exception (DRIFT-1 #3) — the ui-list
    // adapter's null-performance guard, the `=== undefined` check that
    // threw before the null branch of the adapter's own DEC-17 contract —
    // is SUBSUMED by the qa-fixes ITEM-2 wholesale `txrlist` dir sanction
    // below (the same file list, now the whole module).
    // THREE further exceptions (the `feat/ui-models` item, recorded in its
    // DRIFT-1 #8): the new `txrmodels` module dir (a new auto-discovered
    // module is an addition, not a global edit of an existing module), the
    // `txrmodels` item's maintenance of THIS node's sibling stale pin in
    // `txrintake/module.test.ts` (the shell route handoff it performs
    // invalidated that pin), and nothing else outside this module moves.
    // ONE further exception (the `feat/ui-history` item — the `/history`
    // route handoff, its DRIFT-1 #1): the new `txrhistory` module dir (the
    // same addition class), the `txrhistory` item's maintenance of the
    // stale pins in `txrmodels/module.test.ts` + `txrintake/module.test.ts`
    // and this node's own sweep line here.
    // FIVE further exceptions (the qa-hardening ITEM-4 `/help` handoff):
    // the new `txrhelp` module dir (the same addition class), the scaffold
    // `ShellPage.tsx` the handoff removes, and the `txrintake` files the
    // validation problems' help links touch (module.tsx dependency line,
    // `TxrProblemList.tsx`, the TxrFileCard test's router wrapper).
    // SEVEN further exceptions (the qa-fixes ITEM-1 cross-module fixes —
    // its DRIFT-1): the null-vs-undefined audit's finds in
    // `txrintake/lib/flow.ts` + its test, and the failed-run results
    // state (RES-02) in the `txrresults` pages/components/tests (the same
    // file list the `txrhistory` sweep sanctions, its own comment).
    // The qa-fixes ITEM-2 cross-module surface (its DRIFT-1): the whole
    // `txrlist` module dir is now the item's list/estimate/format surface,
    // sanctioned wholesale per the sibling-dir convention (this subsumes
    // the ITEM-13 single-file pin above), and the four `txrintake` preview
    // fixtures/pins the estimate/eligibility field additions require.
    expect(
      touched.filter(
        p =>
          p.startsWith('src-app/ui/src/modules/') &&
          !p.startsWith('src-app/ui/src/modules/txrrun/') &&
          !p.startsWith('src-app/ui/src/modules/txrlist/') &&
          !p.startsWith('src-app/ui/src/modules/txrmodels/') &&
          !p.startsWith('src-app/ui/src/modules/txrhistory/') &&
          !p.startsWith('src-app/ui/src/modules/txrhelp/') &&
          !p.startsWith('src-app/ui/src/modules/txrintake/') &&
          !p.startsWith('src-app/ui/src/modules/txrresults/') &&
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
          p !== 'src-app/ui/src/modules/txrshell/lib/copyGuard.allowlist.json' &&
          // qa-fixes2 ITEM-4 (global + shell): the title hook + its unit
          // test, the not-found screen + its unit test, the TxrLayout
          // brand-link class (the header ring unification's hook) and the
          // shell's catch-all route (module.tsx is sanctioned above).
          p !== 'src-app/ui/src/modules/txrshell/lib/document-title.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/document-title.test.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/pages/NotFoundPage.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/pages/NotFoundPage.test.tsx' &&
          // app-shell ITEM-1 (its DRIFT-1): the shell's layout primitives —
          // the components dir + the two new lib modules (the rewritten
          // TxrLayout/TxrThemeToggle/gallery files are the entries above).
          !p.startsWith('src-app/ui/src/modules/txrshell/components/') &&
          p !== 'src-app/ui/src/modules/txrshell/lib/shellMode.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/shellMode.test.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/scrollCache.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/scrollCache.test.ts' &&
          // qa-fixes4 ITEM-2 (its DRIFT-1): the ONE shared truthful
          // run-status vocabulary — `txrshell/lib/runStatus.ts` + its unit
          // test (the K chip and the G/H header speak the same words; a
          // txrhistory import back would close a module cycle — the
          // resident precedent is ITEM-1's safeText in the shell).
          p !== 'src-app/ui/src/modules/txrshell/lib/runStatus.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/runStatus.test.ts' &&

          p !== 'src-app/ui/src/modules/session/SessionGuard.tsx',
      ),
    ).toEqual([])
  })

  it('carries no status words, no literal design-example numbers and no URL literal in its own copy (INV-5/6)', () => {
    // The scan's target is SHIPPED COPY — the module's own source, comments
    // and fixtures; any spelling there fails. Test files are excluded, the
    // same scope the study-literal scan below uses: they PIN the formatter
    // outputs verbatim (TEST-RUN-04's "4 min 40 s" / "about 7 minutes left"
    // / "160 of 250 MB" — the boards' own bytes as EXPECTED values), which
    // is precisely what an INV-5/6 scan must allow outside shipped copy.
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
    // The boards' example facts (Busy / BusyRunning boards) — never code.
    const designExampleBareCounts = [
      'running 12 me' + 'thods',
      '12 me' + 'thods',
      '38 me' + 'thods',
      '26 o' + 'f 38',
      '151 pa' + 'tients',
      'about 14 mi' + 'nutes',
      'about 7 mi' + 'nutes',
      '4 min 40' + ' s',
      '1 min 52' + ' s',
      '160 of 2' + '50',
    ]
    for (const phrase of designExampleBareCounts) {
      expect(own).not.toContain(phrase)
    }
    expect(own).not.toContain('http' + '://')
  })

  it('spells no study literal in its own source files (INV-4)', () => {
    // The publish surface only — the test file itself may name the scanned
    // token (the tree scan excludes `*.test.ts` files, which is also how
    // the module's copy stays scannable by the guard's own rules).
    const own = ownSourceFiles(MODULE_DIR)
      .filter(p => !/\.test\.(ts|tsx)$/.test(p))
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .toLowerCase()
    const studyRe = new RegExp('st' + 'ud(y|ies)', 'i')
    expect(studyRe.test(own)).toBe(false)
  })
})
