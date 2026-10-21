// TEST-54 (ITEM-15) [acceptance] [invariant: INV-7] — the REBUILD-FREE FE leg.
//
// INV-7 promises that a processor package dropped in at RUNTIME — served by the backend,
// never seen by the build-time `import.meta.glob` — renders its declarative UI with no app
// rebuild. The SERVER half of that is already an acceptance test
// (`server/tests/extensions/runtime_dropin_test.rs`: a fresh package written into
// `<data_root>/processors/` at runtime is discovered, its datatype registers, its compute
// resolves on disk). This is the FRONTEND half: that the same package, arriving over
// `GET /api/processors/packages`, registers a working declarative view.
//
// WHY THIS IS NOT THE GALLERY E2E TESTS.md ORIGINALLY DECLARED. The gallery
// (`tests/gallery-e2e`) is deliberately BACKEND-FREE — it boots vite alone. Proving a
// server-served package renders there would mean intercepting the fetch with
// `page.route()`, which the repo's own e2e rules forbid ("no `page.route()` API mocking —
// drive the real backend through the UI"). The seam that makes this testable honestly is
// the one `loadRuntimeProcessors` was BUILT with: its own docstring says the fetch is
// "passed in so it is unit-testable without a live backend". So the HTTP call — the
// external boundary — is the only thing substituted; the discovery, parse, lower and
// register path is the real production code, end to end. See the TESTS.md amendment note.
// vitest, not `node:test`: the parser transitively imports `@ziee/viz`, whose sources are
// `.tsx`, which the plain-node strip-types runner cannot load.
import { test, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Contributions } from '@/modules/workbench/core/contributions/workbenchRegistry'
import { Registry } from '@/modules/workbench/core/contributions/registry'
import { loadRuntimeProcessors, discoverProcessorPackages } from './loadProcessors'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** A fresh, isolated `Contributions` — NOT the process-wide singleton, so this suite
 *  cannot see (or pollute) what the app registered at import time. */
const freshRegistry = (): Contributions => ({
  analyses: new Registry('analyses'),
  views: new Registry('views'),
  statusBarItems: new Registry('statusBarItems'),
  sections: new Registry('sections'),
})
const REPO = path.resolve(HERE, '../../../../../../..')

/** A package that could not possibly be in the build glob: its id names no shipping
 *  processor and its datatype is deliberately outside the single-cell lattice, so this
 *  doubles as an INV-1 check (the app renders a domain it knows nothing about). */
const DROPPED_ID = 'runtime-dropin-fe'
const DROPPED_DATATYPE = 'dropin-acceptance/widget'
/** The package-relative path of the drop-in's view file — the string its analysis' `ui:`
 *  names AND the key its `views` record is stored under. One constant so the two cannot
 *  drift (a `ui:` entry naming a file the package does not carry is a LOAD ERROR). */
const DROPPED_VIEW_PATH = 'ui/inspect.yaml'

function droppedPackage() {
  return {
    manifest: {
      id: DROPPED_ID,
      title: 'Runtime drop-in',
      version: '1.0.0',
      contributes: {
        analyses: [
          {
            id: `${DROPPED_ID}.inspect`,
            category: 'inspect',
            title: 'Inspect widget',
            // `appliesTo`, not `accepts` — the loader HARD-FAILS a package still carrying a
            // removed key (DEC-3), and this drop-in stands in for a third-party package, so
            // it must be written the way a third party would have to write it today. No
            // `required:` either: every entry is required by definition (DEC-5).
            appliesTo: [{ slot: 'input', datatype: DROPPED_DATATYPE }],
            // The analysis NAMES its view file. Registration walks these lists — the
            // `ui/*.yaml` glob is gone — so a package that ships a view no analysis
            // declares registers no view at all. A third-party drop-in has to say this.
            ui: [DROPPED_VIEW_PATH],
          },
        ],
      },
    },
    // `ProcessorPackage.views` — each `ui/*.yaml` view_spec, decoded but not yet
    // validated, KEYED BY ITS PACKAGE-RELATIVE PATH: that key is what an analysis' `ui:`
    // entry names. (It was an array, which the loader could not look a declared path up
    // in; the `as never` at the call site hid the mismatch.) The shape mirrors the
    // shipping specs: a flat `widgets` array whose ORDER is the pane's layout (INV-3 —
    // there is no `layout` key).
    views: {
      [DROPPED_VIEW_PATH]: {
        id: `${DROPPED_ID}.inspect`,
        title: 'Inspect widget',
        permission: 'jobs::use',
        state: { note: { type: 'string', default: '' } },
        widgets: [
          { id: 'noteField', kind: 'text', label: 'Note', value: '$state.note', onChange: 'setNote' },
          { id: 'goBtn', kind: 'button', label: 'Go', onClick: 'noop' },
        ],
        actions: [
          { id: 'setNote', title: 'Set note', permission: 'jobs::use', body: [{ set: { note: '$event.value' } }] },
          { id: 'noop', title: 'Go', permission: 'jobs::use', body: [] },
        ],
      },
    },
  }
}

test('TEST-54: the dropped package is NOT in the build-time glob (the precondition)', () => {
  // Without this the test could pass because the package was baked in all along — which
  // is precisely the claim INV-7 is about.
  const baked = discoverProcessorPackages()
  // POSITIVE COUNT: the glob must actually be finding the two shipping packages, or
  // "not in the glob" is trivially true of everything.
  expect(baked.length, `the build-time glob found ${baked.length} package(s); expected ≥2`).toBeGreaterThanOrEqual(2)
  const ids = baked.map(p => p?.manifest?.id)
  expect(ids.includes('cell-filter') || ids.includes('qc'), `baked ids: ${ids.join(', ')}`).toBe(true)
  expect(ids.includes(DROPPED_ID), 'the fixture must not be a baked package').toBe(false)
})

// visualize-pane ITEM-69 — the GLOB and the PATH PARSER must name the same directory.
//
// The build-time discovery is two coupled halves: an `import.meta.glob` over
// `packages/*/{manifest.yaml,ui/*.yaml}`, and two REGEXES that pull the package name and
// the package-relative view path back out of each glob KEY. A rename that moves the glob
// and misses the regexes leaves them naming different directories — and the failure is
// silent in the only place it matters:
//
//   · the package still DECODES, because its id comes from the manifest body, not the path;
//   · so the count above still passes, and every id assertion still passes;
//   · but `viewPathParts` returns null for every key, so EVERY baked `ui/*.yaml` view is
//     dropped, and the app renders no declarative surface at all.
//
// That is exactly what happened during the rename, with 2868 unit tests green: the glob
// was rewritten (it is a plain string) and the two regexes were not (they spell the
// separator `\/`). This asserts the half no id check can see.
test('ITEM-69: the build-time glob yields VIEWS, not just manifests (the glob and its path parser agree)', () => {
  const baked = discoverProcessorPackages()
  const withViews = baked.filter(p => Object.keys(p?.views ?? {}).length > 0)
  expect(
    withViews.length,
    `no baked package carried a view — the glob and its path parser name different directories`,
  ).toBeGreaterThanOrEqual(1)
  // Every view key is a PACKAGE-RELATIVE path (`ui/<file>.yaml`), which is what an
  // analysis' `ui:` entry names. A parser that failed to match would have produced the
  // whole absolute glob key here instead.
  for (const pkg of withViews) {
    for (const key of Object.keys(pkg.views)) {
      expect(key, `a view key is not package-relative: ${key}`).toMatch(/^ui\/[^/]+\.yaml$/)
    }
  }
  // …and the package NAME parser agrees too: a manifest key that failed to match returns
  // the whole path, so no baked package may be named by something path-shaped.
  for (const pkg of baked) {
    expect(String(pkg?.manifest?.id ?? ''), 'a baked package id looks like a path').not.toContain('/')
  }
})

test('TEST-54: no app source names the dropped package or its datatype (INV-1 / INV-7)', () => {
  // The FE analog of the server test's clause (d): the binary knows nothing about this
  // package. If any app file named it, "it rendered" would prove nothing about drop-in.
  const src = path.join(REPO, 'src-app/ui/src')
  const hits: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.(ts|tsx)$/.test(e.name)) continue
      if (readFileSync(p, 'utf8').includes(DROPPED_ID)) hits.push(path.relative(src, p))
    }
  }
  walk(src)
  expect(hits, 'an app source names the drop-in fixture — it is not a drop-in then').toEqual([])
})

test('TEST-54: a RUNTIME-served package registers its declarative view with no rebuild', async () => {
  const registry = freshRegistry()
  // Precondition: a fresh registry knows nothing.
  expect(registry.views.get(`${DROPPED_ID}.inspect::region::right`)).toBeUndefined()
  expect(registry.analyses.get(`${DROPPED_ID}.inspect`)).toBeUndefined()

  const result = await loadRuntimeProcessors(
    registry,
    new Set(['cell-filter', 'qc']), // the baked ids — the delta is the dropped package
    async () => [droppedPackage() as never],
  )

  expect(result.errors, 'the dropped package must load without errors').toEqual([])
  expect(result.analysisIds).toEqual([`${DROPPED_ID}.inspect`])
  // ONE view contribution per spec (INV-3), registered under the bare spec id — not the
  // `<viewId>::region::<region>` alias the region fan used to mint.
  expect(result.viewContributionIds).toEqual([`${DROPPED_ID}.inspect`])

  // The load is only meaningful if what landed is a USABLE view contribution.
  const view = registry.views.get(`${DROPPED_ID}.inspect`)
  expect(view, 'the runtime-dropped view contribution is registered').toBeTruthy()
  expect(view!.title).toBe('Inspect widget')
  expect(view!.extensionId, 'the contribution is attributed to the dropped package').toBe(DROPPED_ID)

  const analysis = registry.analyses.get(`${DROPPED_ID}.inspect`)
  expect(analysis, 'the runtime-dropped analysis is registered').toBeTruthy()
})

test('TEST-54: the dropped view_spec parses through the REAL parser', () => {
  // Registration alone would be satisfied by a spec the renderer then chokes on. The
  // parser is the thing that decides whether it can render.
  const spec = droppedPackage().views[DROPPED_VIEW_PATH]
  const r = parseViewSpec(spec)
  expect(r.ok, `the dropped view_spec must parse: ${JSON.stringify((r as { errors?: unknown }).errors)}`).toBe(true)
})

test('TEST-54: a package ALREADY baked is not registered twice by the runtime leg', () => {
  // The delta rule. Without it a runtime fetch would re-register every baked package and
  // the "idempotent-with-warning" registry path would paper over it.
  const registry = freshRegistry()
  return loadRuntimeProcessors(
    registry,
    new Set([DROPPED_ID]), // pretend it IS baked
    async () => [droppedPackage() as never],
  ).then(res => {
    expect(res.analysisIds, 'a baked id must be skipped by the runtime leg').toEqual([])
    expect(registry.views.get(`${DROPPED_ID}.inspect::region::right`)).toBeUndefined()
  })
})

test('TEST-54: a failed runtime fetch degrades silently (the baked baseline still rendered)', async () => {
  const registry = freshRegistry()
  const res = await loadRuntimeProcessors(registry, new Set(), async () => {
    throw new Error('network down')
  })
  expect(res.errors, 'a fetch failure is non-fatal — the baked baseline already rendered').toEqual([])
  expect(res.analysisIds).toEqual([])
})

test('TEST-54: the SERVER half of INV-7 is covered by its own acceptance test', () => {
  // Cross-reference rather than re-implementation: this file proves the FE leg, and the
  // server leg has a real spawned-server acceptance test. Asserting the file exists keeps
  // the two halves from drifting apart silently — if that test is deleted, INV-7 loses
  // half its proof and this says so.
  const server = path.join(REPO, 'src-app/server/tests/extensions/runtime_dropin_test.rs')
  expect(existsSync(server), `the server-side INV-7 acceptance test is missing: ${server}`).toBe(true)
  const src = readFileSync(server, 'utf8')
  expect(src).toMatch(/invariant: INV-3, INV-7/)
  expect(src).toMatch(/a_separate_repo_package_dropped_at_runtime_is_discovered_with_no_rebuild/)
})
