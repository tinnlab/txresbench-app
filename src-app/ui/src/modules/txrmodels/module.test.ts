/**
 * TEST-MOD-01 — txrmodels module shape + the PROV-UI-MODELS-1 route/slot
 * surface (INV-5, INV-6, INV-7; ITEM-1). The TEST-MOD-02 rows for the path
 * builders live in `routes.test.ts` (their own file, per the TESTS map).
 *
 * The module is a framework module: auto-discovered by the loader glob in
 * `modules/loader.ts` (`import.meta.glob` over module.tsx files in the
 * modules tree), registering exactly the three model routes under the shell
 * layout, with NO eager store (the model store registers whole-store-lazy
 * in its own file, the `datasets`/`txrresults` precedent — `stores: []`),
 * NO component, NO permission predicate (the app defines no `X::use` for
 * these screens; all routes are `requiresAuth` under the local single-user
 * session) and exactly ONE slot registration: the routerEffects dialog
 * host (PROV-UI-MODELS-2).
 *
 * The no-edits assertions below run over the item's own delta (working tree
 * against HEAD while uncommitted; the tip commit's file set when committed —
 * the same dual-state convention the sibling module tests use). The plan's
 * no-go list: no generated client, no OpenAPI, no guard/script, no
 * package.json line, no loader edit, no server path, and NO other module
 * directory except the sanctioned pins: `txrshell/module.tsx` (the `/models`
 * route handoff, pinned separately below — the shell's NEWEST handoff, the
 * `/history` one from `feat/ui-history` ITEM-1, is what the byte pin below
 * now asserts, since the walk-back takes the nearest shell-touching
 * commit), `txrintake/module.test.ts`, `txrrun/module.test.ts` and
 * `txrresults/module.test.ts` (their shell-route / no-other-module pins
 * went stale with the handoff and were updated by this item — DRIFT-1 #8)
 * and the `txrhistory/**` module dir (the `feat/ui-history` item's own
 * module — a new auto-discovered module is an addition, not a global edit,
 * the same class as this module's dir exception).
 *
 * The status-word / design-example-number / URL / scan covers the module's
 * own publish surface (non-test source, comments, README-listed fixtures —
 * same scope the sibling scans use); the route builders' scan additionally
 * covers the whole module directory (TEST-MOD-02). Scanned tokens are built
 * from split literals so this test file itself stays clear of them.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppModule } from '@ziee/framework/module-system/types'
import txrModelsModule from './module'
import { TxrLayoutDef } from '../txrshell/module'
import txrShellModule from '../txrshell/module'
import { TxrModelsDialogHost } from './components/TxrModelsDialogHost'

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
 * verified in. Uncommitted (the item's own verification run): the working
 * tree against HEAD. Committed (the branch gate): the tip commit's diff —
 * the item commit or its report record commit, both of which are this
 * item's file set.
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

/**
 * The shell file's change, as added/removed lines. The working tree first
 * (a LATER shell edit surfaces here and the pin sees it); when the working
 * tree has no shell change, the committed walk-back: the NEAREST commit
 * whose shell diff is non-empty — the item that last touched the shell.
 * The look-up is the full branch history, deliberately with NO window: the
 * shell handoff is ITEM-1's, and each item's report-impl commit pair
 * pushes it one further back — the ITEM-1/2 "at most three" window went
 * stale at ITEM-3 (fixed by the 12-commit window), and that window went
 * stale at ITEM-7 again (the shell commit was HEAD~13, measured — the
 * ITEM-6 state had it at HEAD~11). The byte-shape assertions below are
 * the pin; the search breadth is a device detail, never a weakening.
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
    // The working tree is clean for the shell (a stale pin state): fall
    // through to the committed walk-back, like the clean-tree branch.
  }
  const nearest = git(['log', '--format=%H', '-1', '--', SHELL])[0]
  if (nearest !== undefined) {
    const patch = parse(git(['diff', `${nearest}^`, nearest, '--', SHELL]))
    if (patch.added.length > 0 || patch.removed.length > 0) return patch
  }
  return { added: [], removed: [] }
}

describe('txrmodels module (TEST-MOD-01)', () => {
  it('registers as a framework module with the planned metadata', () => {
    expect(txrModelsModule.metadata).toEqual({
      name: 'txrmodels',
      version: '1.0.0',
      description:
        'TxResBench models — choose pretrained (D) and saved (I) models to run, the Your-models inventory (J), and the save dialogs (L/L2/L3)',
    })
  })

  it('owns exactly the three model routes, each guarded under the shell layout', () => {
    const routes = routesOf(txrModelsModule)
    expect(routes.map(r => r.path)).toEqual(['/pretrained-models', '/saved-models', '/models'])
    for (const route of routes) {
      expect(route.requiresAuth).toBe(true)
      expect(route.layout).toBe(TxrLayoutDef)
      expect(route.permission).toBeUndefined()
    }
  })

  it('registers an empty store list (the model store is whole-store-lazy) and no component or predicate', () => {
    // `stores: []` per PROV-UI-MODELS-3: the model store registers with
    // `registerLazyStore` in its own file (the `DatasetDetail` precedent),
    // so the module declares no eager store and no other registration.
    expect(txrModelsModule.registerStores?.()).toEqual([])
    expect(
      (txrModelsModule as AppModule & { registerComponents?: unknown }).registerComponents,
    ).toBeUndefined()
    expect((txrModelsModule as unknown as Record<string, unknown>).shouldLoad).toBeUndefined()
    expect(txrModelsModule.initialize).toBeUndefined()
    expect(txrModelsModule.cleanup).toBeUndefined()
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).not.toContain("import('./stores/")
    expect(source).not.toContain("from './stores/")
  })

  it('registers exactly the dialog-host slot (PROV-UI-MODELS-2)', () => {
    expect(txrModelsModule.registerSlots?.()).toEqual({
      routerEffects: [
        {
          id: 'txr-models-dialog-host',
          component: TxrModelsDialogHost,
        },
      ],
    })
    // The host is a component (ITEM-9 fills in the subscription + the
    // dialogs; TEST-MOD-12 exercises the rendered behavior — including
    // "renders null when no dialog is open" — in the jsdom suite). The
    // ITEM-1 pin called the function directly, which a hook-owning host
    // can no longer do: a component function is only called by React.
    expect(typeof TxrModelsDialogHost).toBe('function')
  })

  it('declares the router, the shell, the intake, the shared list, the run and the results modules as framework dependencies', () => {
    expect(txrModelsModule.registerDependencies?.()).toEqual([
      'router',
      'txrshell',
      'txrintake',
      'txrlist',
      'txrrun',
      'txrresults',
    ])
  })

  it('is picked up by the loader auto-discovery glob', () => {
    const files = import.meta.glob('./**/module.tsx', { eager: true }) as Record<
      string,
      { default: unknown }
    >
    expect(Object.keys(files)).toContain('./module.tsx')
    expect(files['./module.tsx'].default).toBe(txrModelsModule)
  })

  it('routes the three lazy pages the module declares', () => {
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('lazyWithPreload')
    expect(source).toContain("import('./pages/PretrainedModelsPage')")
    expect(source).toContain("import('./pages/SavedModelsPage')")
    expect(source).toContain("import('./pages/ModelsPage')")
  })

  it('does not change the generated client, the openapi, the guards, the loader, the server or any other module (DEC-2/17/18)', () => {
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
          p !== 'scripts/method-catalogue/fixtures/expected-catalogue.json',
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
          // qa-fixes3 ITEM-1 (the catalogue's human-name fields): the
          // `Method`/`MethodSummary` wire additions' serialization pins
          // (`catalogue.rs`, with `types.rs` above).
          p !== 'src-app/server/src/modules/method_catalogue/catalogue.rs' &&
          p !== 'src-app/server/src/modules/method_catalogue/eligibility.rs' &&
          p !== 'src-app/server/src/modules/method_catalogue/estimate.rs' &&
          p !== 'src-app/server/src/modules/method_catalogue/routes.rs' &&
          p !== 'src-app/server/src/modules/execution_engine/orchestrator.rs' &&
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
          // qa-fixes2 ITEM-7 (R2-04): the K row's `predicted` doc grows
          // the distinct-patient meaning — history_store/types.rs.
          p !== 'src-app/server/src/modules/history_store/types.rs',
      ),
    ).toEqual([])
    // TEN sanctioned exceptions (the DRIFT-1 #8 class + the `/history` +
    // the ITEM-4 `/help` handoffs): the shell handoff files themselves
    // (`txrshell/module.tsx` + the scaffold `ShellPage.tsx` the `/help`
    // handoff removes), the sibling module test files whose pins went
    // stale with the handoffs and are updated by this item, the
    // `txrhistory` and `txrhelp` module dirs (new auto-discovered modules
    // are additions, not global edits), the `txrintake` files the
    // validation problems' help links touch (module.tsx dependency line,
    // `TxrProblemList.tsx`, the TxrFileCard test's router wrapper), and
    // the qa-fixes ITEM-1 cross-module fixes (its DRIFT-1): the
    // null-vs-undefined audit's finds in `txrrun/lib/format.ts` +
    // `txrintake/lib/flow.ts` + their tests, and the failed-run results
    // state (RES-02) in the `txrresults` pages/components/tests (the same
    // file list the `txrhistory` sweep sanctions, its own comment).
    // Nothing else outside this module moves.
    // The qa-fixes ITEM-2 cross-module surface (its DRIFT-1): the
    // `txrlist` module dir — the item's list/estimate/format rework
    // (CM-1's no-env count, CM-4's rounded durations, CM-5's dark-mode
    // checkboxes), sanctioned wholesale per the sibling-dir convention —
    // the whole `txrrun` module dir — the run screens' qa-fixes ITEM-2
    // settings rework + ITEM-3's running-page rework (header/strip/tabs/
    // table/log-panel/at-a-time, its DRIFT-1), sanctioned wholesale per
    // the sibling-dir convention — and the `txrintake` preview
    // fixtures/pins the estimate/eligibility field additions require.
    expect(
      touched.filter(
        p =>
          p.startsWith('src-app/ui/src/modules/') &&
          !p.startsWith('src-app/ui/src/modules/txrmodels/') &&
          !p.startsWith('src-app/ui/src/modules/txrhistory/') &&
          !p.startsWith('src-app/ui/src/modules/txrhelp/') &&
          !p.startsWith('src-app/ui/src/modules/txrlist/') &&
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
          // shell's catch-all route itself (module.tsx is sanctioned above;
          // the module test pins the routes array).
          p !== 'src-app/ui/src/modules/txrshell/lib/document-title.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/lib/document-title.test.ts' &&
          p !== 'src-app/ui/src/modules/txrshell/pages/NotFoundPage.tsx' &&
          p !== 'src-app/ui/src/modules/txrshell/pages/NotFoundPage.test.tsx' &&

    // qa-fixes ITEM-7 (X3): the session guard's loading/failure
    // surface is tokenized with the pages (its own ink was a
    // hard-coded light hex — a light flash before the app loads).
          p !== 'src-app/ui/src/modules/session/SessionGuard.tsx' &&
          !p.startsWith('src-app/ui/src/modules/txrintake/') &&
          !p.startsWith('src-app/ui/src/modules/txrrun/') &&
          !p.startsWith('src-app/ui/src/modules/txrresults/'),
      ),
    ).toEqual([])
  })

  it('records the txrshell route handoffs: the `/models` route is gone, the handoff comment is there, nothing else in the shell moves', () => {
    // The current shell state (all four handoffs' result): no screen route
    // — `/help` left the shell with the ITEM-4 handoff (`txrhelp` owns it);
    // the ONE route the shell keeps is the global catch-all (qa-fixes2
    // ITEM-4, R2-G2).
    expect(routesOf(txrShellModule).map(r => r.path)).toEqual(['*'])
    const shellSource = readFileSync(
      fileURLToPath(new URL('../txrshell/module.tsx', import.meta.url)),
      'utf8',
    )
    expect(shellSource).toContain('`txrmodels` module')
    expect(shellSource).not.toContain("path: '/models'")
    // The `/history` handoff (the feat/ui-history item, same file, its
    // own block) — the shell comment names the incoming module.
    expect(shellSource).toContain('`txrhistory` module')
    expect(shellSource).not.toContain("path: '/history'")
    // The `/help` handoff (the qa-hardening ITEM-4, same file) — the last
    // scaffold route; the shell owns the layout only.
    expect(shellSource).toContain('`txrhelp` module')
    expect(shellSource).not.toContain("path: '/help'")
    expect(shellSource).not.toContain('ShellPage') // the scaffold component left with the route

    // The patch itself: with this item's working-tree diff the walk-back
    // takes THIS item's shell patch (qa-fixes2 ITEM-4 — the catch-all), so
    // the byte pin asserts THAT patch: removed lines are the old empty
    // `routes: []` only; added lines are the NotFoundPage import + the
    // catch-all comment block + the catch-all route block only. Byte-pins
    // "NO other change" (DEC-2).
    const { added, removed } = shellPatch()
    const commentLine = (l: string) => /^(\s*\/\*\*|\s*\*(?:\s.*)?|\s*\*\/)$/.test(l)
    const routeBlockLine = (l: string) =>
      [
        "import { NotFoundPage } from './pages/NotFoundPage'",
        '  routes: [',
        '    {',
        "      path: '*',",
        '      element: <NotFoundPage />,',
        '      requiresAuth: true,',
        '      layout: TxrLayoutDef,',
        '    },',
        '  ],',
      ].includes(l)
    expect(removed.length).toBeGreaterThan(0)
    expect(removed).toEqual(['  routes: [],'])
    for (const line of added) {
      // The new comment block words the catch-all (asserted on the source
      // above); every added line is comment text or the catch-all route
      // block.
      expect(commentLine(line) || routeBlockLine(line)).toBe(true)
    }
    expect(added).toContain("      path: '*',")
  })

  it('carries no status words, no literal design-example numbers and no URL literal in its own copy (INV-5/6)', () => {
    // The scan's target is SHIPPED COPY — the module's own source, comments
    // and fixtures; any spelling there fails. Test files are excluded, the
    // same scope the sibling token scans use: they PIN the boards'
    // bytes as EXPECTED values, which is precisely what an INV-5/6 scan
    // must allow outside shipped copy.
    // The kit `Input` input-hint prop (spelled exactly like one of those
    // status words) is an INPUT AFFORDANCE, not a copy mark — its API
    // occurrence (`placeholder="…"`) is stripped before the word scan, the
    // same precision the txrresults/txrintake scans use (qa-fixes ITEM-4:
    // the save dialog's "Name this set" hint); any other spelling in
    // comments, copy or fixtures still fails.
    const kitHintProp = new RegExp('place' + 'holder' + '\\s*=\\s*"[^"]*"', 'gi')
    const own = ownSourceFiles(MODULE_DIR)
      .filter(p => !/\.test\.(ts|tsx)$/.test(p))
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .replace(kitHintProp, '')
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
    // The boards' example facts (Pretrained / Saved / Models boards) —
    // never code or fixture constants (INV-4).
    const designExampleBareCounts = [
      '38 pa' + 'tients',
      '5 ca' + 'n run',
      '13 sa' + 'ved models',
      '151 pa' + 'tients',
      'of 3' + '8',
      '50 m' + 'b',
      '11 m' + 'odels',
      '0.' + '64',
    ]
    for (const phrase of designExampleBareCounts) {
      expect(own).not.toContain(phrase)
    }
    expect(own).not.toContain('http' + '://')
  })

  it('spells no forbidden literal in its own source files (INV-4)', () => {
    const own = ownSourceFiles(MODULE_DIR)
      .filter(p => !/\.test\.(ts|tsx)$/.test(p))
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .toLowerCase()
    const tokenRe = new RegExp('st' + 'ud(y|ies)', 'i')
    expect(tokenRe.test(own)).toBe(false)
  })
})
