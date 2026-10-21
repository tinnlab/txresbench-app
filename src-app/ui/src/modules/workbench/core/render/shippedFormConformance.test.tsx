// @vitest-environment jsdom
//
// ═══════════════════════════════════════════════════════════════════════════════════════
// SHIPPED-FORM CONFORMANCE — the tier that was missing.
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// For EVERY shipped processor view, MOUNTED against project data shaped exactly as the
// endpoint the app actually calls returns it, assert three properties:
//
//   P1  what the form SHOWS == what STATE holds == what the RUN would receive   (INV-4)
//   P2  every affordance the form RENDERS is reachable, operable, and HONEST about
//       what it does; and every declared mutating action has a way in
//   P3  a control whose options depend on another control RESOLVES against the same
//       catalog the run is launched from
//
// ── Why this level, and not another ───────────────────────────────────────────────────
//
// Three user-visible defects survived a 9-phase lifecycle WITH a blind audit, because
// every existing layer tested its own slice with the neighbouring slice replaced by a
// fixture:
//
//   · The per-view `*Surface.test.ts` suites load the REAL shipped YAML — with the DOM
//     removed. They assert the picker is DECLARED, never that it OFFERS anything.
//   · `artifactRefWidget.test.tsx` mounts the real control — over a HAND-WRITTEN spec, with
//     no view store, asserting the bound ACTION WAS CALLED. An action call is not a state
//     landing, and a state landing is not a launch.
//   · The `*RunInputs.test.ts` suite reaches the real `RunInput[]` — from state set DIRECTLY
//     (`store.set(k, v)`), so the question "could a user have PUT that there?" is never asked.
//   · The e2e acceptance fixture seeds TWO candidate matrices, so it exercises the picker
//     arm and never the auto-select arm — which is the arm every single-dataset project hits.
//
// And every one of those layers hand-writes its catalog rows with `source_dataset_id` set,
// while the endpoint the pickers actually read cannot carry that field at all. That is why
// the fixture here is typed as the WIRE type and mapped through the REAL wire→row mapper
// (see `wireCatalog`): a fixture that can express more than the wire can is a fixture that
// proves nothing about the wire.
//
// jsdom rather than Playwright, deliberately. This tier's job is BREADTH — every shipped
// view × every affordance × every candidate cardinality, in seconds, with no backend and no
// sandbox — so it can be a gate rather than a nightly. The e2e journey spec
// (`tests/e2e/14-declarative-qc/full-journey.spec.ts`) is the DEPTH counterpart: it proves
// the chain holds once, for real. Neither substitutes for the other.
//
// The repo has already paid for the alternative once: `railIsolation.test.ts`'s
// source-scanning guards were replaced by a mounted harness after 20 audit rounds showed a
// static analyser's evasion space is unbounded. The same principle applies here — every
// assertion below is made against the MOUNTED thing and the LIVE store, never against the
// YAML's text.
//
// ── Vocabulary ────────────────────────────────────────────────────────────────────────
//
// This file names NO domain datatype, axis, or column. Every id it uses is read out of the
// shipped packages at runtime — which is also what makes requirement 3 hold: the view set,
// the datatype lattice and the synthetic catalog are all DERIVED, so a processor added
// tomorrow is covered by default rather than by someone remembering to extend a list.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import * as React from 'react'
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { parse as parseYaml } from 'yaml'

import type {
  Artifact as WireArtifact,
  ListedArtifact,
  ProjectCatalog as WireProjectCatalog,
} from '@/api-client/types'
import { datatypeRegistry } from '@/core/datatypes/registry'
import { BOOTSTRAP_LATTICE } from '@/core/datatypes/builtin'
import type { Datatype } from '@/core/datatypes/types'

import type {
  ArtifactRefWidget,
  TableColumnSpec,
  TableWidget,
  ViewSpec,
  WidgetSpec,
} from '@/modules/workbench/core/manifest/viewSpec'
import type { ProcessorPackage } from '@/modules/workbench/core/manifest/processorPackage'
import { registerProcessorPackage } from '@/modules/workbench/core/runtime/loadProcessors'
import { workbenchRegistry, createWorkbenchApi, type WorkbenchHost } from '@/modules/workbench/core'
import { isDeclarativeRenderSpec, type DeclarativeRenderSpec } from '@/modules/workbench/core/runtime/seam'
import { evalExpr, expandForEach } from '@/modules/workbench/core/runtime/expr'
import { tableRowParts, tableRowPrimitives } from '@/modules/workbench/core/spec/schema'
import {
  anchorId,
  axisColumnRows,
  declaredAxes,
  declaredValueKinds,
  isAxisScopedSource,
  resolveArtifactRefSource,
  valueKindsFor,
} from '@/modules/workbench/core/runtime/axisSource'
import { INTEGRATION_GRID_SOURCE } from '@/modules/workbench/core/runtime/integrationGrid'
// Both picker arms are POPOVER controls, so their options do not exist in the DOM until the
// control is opened and a choice is committed by clicking a row. The shared driver is the two
// gestures a user makes — open, click a row — so every property below is still asserted against
// the rendered control, driven the way a user drives it, never by writing the binding behind it.
import {
  choosePicker,
  isPicker,
  isSinglePicker,
  pickerOptions,
  pickerShownValues,
} from '@/modules/workbench/core/__testutil__/pickerDriver'
import { peekStore, __resetDeclarativeMountsForTests } from './declarativeMount'
import { DeclarativeStack } from './DeclarativeRegion'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
import { workbenchLattice } from '@/modules/workbench/core/host/createHost'
import { toArtifactRow, toProjectCatalog, makeFakeDataHost } from '@/modules/workbench/extensions/data/dataHost'
import type { DataHost } from '@/modules/workbench/extensions/data/contract'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { DATA_CAPABILITY_ID, JOBS_CAPABILITY_ID } from '@/modules/workbench/extensions'
import type { ComputeHost } from '@/modules/workbench/extensions/jobs/contract'

// ── jsdom gaps the kit's base-ui controls probe at mount ──────────────────────────────
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
  else if (typeof globalThis.CSS.escape !== 'function') {
    ;(globalThis.CSS as { escape: (v: string) => string }).escape = (v: string) => v
  }
  // jsdom implements no layout, so it ships no `scrollIntoView`. The `multiple` picker's
  // option list scrolls its active row into view the moment it OPENS — so without this the
  // very act of opening that list throws inside the control and the widget's error boundary
  // replaces it. It reads as "the picker is broken", which is how a missing DOM stub gets
  // mistaken for a product defect (and, before this tier could open one, why the multi arm's
  // whole option list was unreachable here).
  Element.prototype.scrollIntoView ??= function scrollIntoView(): void {}
  // base-ui's Checkbox constructs a PointerEvent on click; jsdom ships none.
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = (
      globalThis as { PointerEvent?: unknown }
    ).PointerEvent
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      onchange: null,
    })) as never
  }
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// 1. ENUMERATE the shipped packages — never a hand-written list (requirement 3)
// ═══════════════════════════════════════════════════════════════════════════════════════

/** The shipped-package root, resolved from the RUNNER's cwd rather than `import.meta.url`:
 *  under `@vitest-environment jsdom` the module URL is an `http:` one and
 *  `fileURLToPath` refuses it. Walks up so the file is not pinned to one cwd. */
function findProcessorsDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'packages')
    if (existsSync(candidate) && readdirSync(candidate).some(d => existsSync(join(candidate, d, 'manifest.yaml')))) {
      return candidate
    }
    dir = join(dir, '..')
  }
  throw new Error('shipped-form conformance: no packages/ package root found from ' + process.cwd())
}

const PROCESSORS_DIR = findProcessorsDir()

interface ShippedPackage {
  dir: string
  pkg: ProcessorPackage
  /** the `ui/*.yaml` paths, in directory order. */
  uiPaths: string[]
}

function readShippedPackages(): ShippedPackage[] {
  const out: ShippedPackage[] = []
  for (const dir of readdirSync(PROCESSORS_DIR).sort()) {
    const manifestPath = join(PROCESSORS_DIR, dir, 'manifest.yaml')
    if (!existsSync(manifestPath)) continue
    const manifest = parseYaml(readFileSync(manifestPath, 'utf8'))
    if (!manifest || typeof manifest.id !== 'string') continue
    const uiDir = join(PROCESSORS_DIR, dir, 'ui')
    const uiPaths = existsSync(uiDir)
      ? readdirSync(uiDir)
          .filter(f => f.endsWith('.yaml'))
          .sort()
          .map(f => `ui/${f}`)
      : []
    const views: Record<string, unknown> = {}
    for (const rel of uiPaths) views[rel] = parseYaml(readFileSync(join(PROCESSORS_DIR, dir, rel), 'utf8'))
    out.push({ dir, pkg: { manifest, views }, uiPaths })
  }
  return out
}

const PACKAGES = readShippedPackages()

/**
 * The packages this tier is ABOUT: the ones that register an analysis PANE.
 *
 * Every check below mounts `registerProcessorPackage`'s pane contribution and reasons about
 * an analysis FORM — its Run affordance, its launch, its input-anchored dependent controls.
 * A package whose `ui/*.yaml` are named by `contributes.sections[]` instead
 * (visualize-pane ITEM-65) registers into `registry.sections` and NEVER into
 * `registry.views` — that is INV-12, "a section is not a view", and it is the whole point of
 * the separate slot. Selecting on "has any `ui/` file" therefore asserted `registered a
 * pane` against a package that must not register one, i.e. it read the invariant holding as
 * a failure.
 *
 * Narrowed to the OWNERSHIP relation rather than to a package name, so a future package that
 * contributes BOTH an analysis and a section is still covered for its analysis half.
 */
/**
 * …and the SECOND deliberate exclusion: an analysis marked `launchable: false`.
 *
 * A package's COMPUTE may land before its FORM does, so the analysis is real and runnable
 * while its view is still a placeholder that declares no controls. Every check in this
 * tier would be VACUOUS against such a view — "declares at least one input
 * control", "offers no two candidates a user cannot tell apart", "the affordance that
 * LAUNCHES the run sits in the footer" all assert nothing about a form with no controls
 * that launches nothing.
 *
 * Described by the KIND rather than by naming the package, for the same reason the
 * section-only exclusion below is: a name would make this comment go stale the moment a
 * second such package appears. (It would also carry a DOMAIN noun into the app tree, which
 * `lint-no-domain-in-builtin` refuses — measured, after a first draft of this comment named
 * the package and became the only finding in the tree.)
 *
 * Keyed on the manifest DECLARATION, never on the derived "has no controls": excluding on
 * the property under test would be circular — the suite would stop covering exactly the
 * views that fail its premise — and would silently swallow a real form that lost its
 * controls in a refactor. A flag has to be written by hand, and deleting it puts the
 * package back under the full tier, where it will fail until the form is genuinely done.
 */
const isFormPlaceholder = (a: { launchable?: boolean }): boolean => a.launchable === false

const PACKAGES_WITH_UI = PACKAGES.filter(p =>
  ((p.pkg.manifest as {
    contributes?: { analyses?: Array<{ ui?: string[]; launchable?: boolean }> }
  } | undefined)?.contributes?.analyses ?? [])
    .some(a => (a.ui ?? []).length > 0 && !isFormPlaceholder(a)),
)

it('a FORM-PLACEHOLDER package is excluded from the pane tier deliberately, not by accident', () => {
  // Same both-directions shape as the section-only case below, and for the same reason: a
  // narrowing that quietly stopped matching is indistinguishable from one that is working.
  // A PACKAGE is a form-placeholder only when EVERY view-bearing analysis in it is one.
  //
  // This used to be `.some(isFormPlaceholder)` over ALL its analyses, which is two mistakes
  // at once, and both fired the moment a package held a mix. `launchable: false` is
  // legitimate on an analysis that has NO view — a preflight another form reads through
  // `job.result` has no user surface by design and never will — so `some` classified the
  // whole package as a placeholder because of an analysis that has no form to be a
  // placeholder FOR. And because the package's OTHER analysis does ship a real, launchable
  // form, it is correctly in `PACKAGES_WITH_UI`, so the loop below then reported the tier as
  // covering a package it had ruled out. The predicate now matches `PACKAGES_WITH_UI`'s own:
  // it is about VIEW-BEARING analyses, and a package with even one launchable form is in.
  const viewBearing = (p: (typeof PACKAGES)[number]): Array<{ ui?: string[]; launchable?: boolean }> =>
    (
      (p.pkg.manifest as { contributes?: { analyses?: Array<{ ui?: string[]; launchable?: boolean }> } } | undefined)
        ?.contributes?.analyses ?? []
    ).filter(a => (a.ui ?? []).length > 0)
  const formPlaceholders = PACKAGES.filter(p => {
    const analyses = viewBearing(p)
    return analyses.length > 0 && analyses.every(isFormPlaceholder)
  })
  // NON-VACUITY, and it is the assertion this test was missing: with an empty set the loop
  // below is a no-op and the ratchet is trivially true, so the test provided ZERO signal in
  // exactly the scenario it names — a narrowing that quietly stopped matching. Proven by a
  // blind audit: renaming the manifest key made the three tier checks fail while THIS test
  // passed. The sibling section-only case has had the equivalent guard all along.
  //
  // AMENDED: the floor above was `formPlaceholders.length >= 1`, which conflates two different
  // claims — "the exclusion MECHANISM still works" (an invariant) and "a placeholder ships
  // today" (a transient fact about the tree). The tree legitimately reached zero placeholders
  // when the last one grew its real form, and a floor over transient state fails on the very
  // event it should celebrate. So the mechanism is asserted DIRECTLY against a synthetic
  // declaration, which cannot go vacuous however the tree changes, and the live set is still
  // walked when it is non-empty.
  expect(
    isFormPlaceholder({ launchable: false }),
    'the exclusion predicate no longer recognises a non-launchable analysis that ships a view — ' +
      'the narrowing has stopped matching, which is what makes the loop below vacuous',
  ).toBe(true)
  expect(
    isFormPlaceholder({}),
    'the predicate must NOT claim an ordinary launchable analysis, or it would exclude the tree',
  ).toBe(false)
  for (const p of formPlaceholders) {
    expect(PACKAGES_WITH_UI.map(x => x.dir)).not.toContain(p.dir)
    expect(
      p.uiPaths.length,
      'and it DOES ship a view file — the exclusion is about the DECLARATION, not about emptiness',
    ).toBeGreaterThan(0)
  }
  // The exclusion must not become a dumping ground: it is for packages awaiting their
  // FORM, and a tree where most analyses are placeholders is a tree where this tier has
  // quietly stopped covering anything.
  expect(
    formPlaceholders.length,
    'more packages are form-placeholders than have real forms — this exclusion is being used to avoid the tier',
  ).toBeLessThanOrEqual(PACKAGES_WITH_UI.length)
})

it('the section-only package is EXCLUDED from the pane tier deliberately, not by accident', () => {
  // Without this, the narrowing above is indistinguishable from a filter that quietly
  // stopped matching — a suite silently covering fewer packages is the failure mode the
  // discovery guards in this file exist to prevent. It asserts BOTH directions: a
  // section-only package is out, and the analysis packages are still in.
  const sectionOnly = PACKAGES.filter(p => {
    const c = (p.pkg.manifest as { contributes?: { analyses?: unknown[]; sections?: unknown[] } } | undefined)?.contributes
    return (c?.sections ?? []).length > 0 && (c?.analyses ?? []).length === 0
  })
  expect(sectionOnly.length, 'ITEM-65 ships a package contributing sections and no analysis').toBeGreaterThanOrEqual(1)
  for (const p of sectionOnly) {
    expect(PACKAGES_WITH_UI.map(x => x.dir)).not.toContain(p.dir)
    expect(p.uiPaths.length, 'and it DOES ship view files — the exclusion is about the kind, not about emptiness').toBeGreaterThan(0)
  }
  expect(PACKAGES_WITH_UI.length, 'the analysis packages are still covered').toBeGreaterThanOrEqual(3)
})

/** The datatype lattice, from the packages that CONTRIBUTE it (plus the app's bootstrap
 *  roots the contributions `extends` into). Without it every catalog source resolves to
 *  zero — `DatatypeRegistry.isA(x, x)` is `types.has(x)`, so an unpopulated registry makes
 *  a picker that offers nothing look exactly like a picker that is working. */
function contributedDatatypes(): Datatype[] {
  const out: Datatype[] = []
  for (const p of PACKAGES) {
    const contributes = (p.pkg.manifest as { contributes?: { datatypes?: Datatype[] } }).contributes
    for (const dt of contributes?.datatypes ?? []) out.push(dt)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// 2. The CATALOG — synthesized from what the views DECLARE, shaped as the WIRE carries it
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// `WireProjectCatalog` is the generated response type of the endpoint `useArtifactCatalog`
// reads. Typing the fixture as that type is the point of this whole file: TypeScript then
// REFUSES to let this fixture carry a field the endpoint cannot deliver, so the tier can
// never accidentally prove the app works by handing it data the app can never receive.

const DATASET_A = 'ds-conformance-a'
let artifactSeq = 0
/** ids of the synthetic AXIS-INDEX columns — the one candidate a "which column holds the
 *  labels" control must never be reduced to. Repopulated per `wireCatalog`. */
const axisIndexIds = new Set<string>()

function wireArtifact(over: Partial<WireArtifact> & { datatype: string }): WireArtifact {
  const id = `art-${++artifactSeq}`
  return {
    id,
    content_hash: `sha256:${id}`,
    created_at: '2026-01-01T00:00:00Z',
    dataset_id: DATASET_A,
    hidden: false,
    is_multifile: true,
    meta: {},
    object_key: `sha256:${id}`,
    output_id: id,
    role: 'artifact',
    logical_bytes: 1,
    status: 'ready',
    structure: {},
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  } as WireArtifact
}

/** A matrix-shaped producer declaration spanning `axes` (what an anchor artifact looks
 *  like on the wire). */
const matrixStructure = (axes: string[]): unknown => ({
  encoding: 'zarr_v3',
  kind: 'sparse_csc',
  axes,
  shape: axes.map((_, i) => 10 * (i + 1)),
})

/** A one-column table declaration on `axis`, whose single member declares `kind`. */
const columnStructure = (axis: string, kind: string, name = 'values'): unknown => ({
  encoding: 'zarr_v3',
  kind: 'table',
  axis,
  n: 10,
  arrays: [],
  columns: [{ axis, name, kind, path: name, dtype: kind === 'numeric' ? 'float32' : 'utf8', shape: [10] }],
})

interface SourceDemand {
  /** the datatype id an `artifact_ref` catalog source asks for. */
  catalogTypes: Set<string>
  /** `axis → set of declared member kinds` an axis-scoped source asks for. */
  axisKinds: Map<string, Set<string>>
  /** axes an `axis_columns` data slice reads. */
  axisSlices: Set<string>
  /**
   * The axis PAIRS an `integration_grid` slice reads.
   *
   * A form declaring one needs a catalog no other demand produces: SEVERAL datasets, each
   * carrying its own declared row index and its own columns on both axes. Without that the
   * plan resolves to the empty one, and a tier that certified the form would be certifying
   * a run with no mounts.
   */
  gridAxes: Array<{ entity: string; level: string }>
}

/** Walk a spec (widgets, nested `group` children, `data` slices) and collect what its
 *  controls would need in order to have anything to offer. Purely structural — it reads
 *  the source's own declared strings, so it names no domain vocabulary itself. */
function demandsOf(spec: ViewSpec, into: SourceDemand): SourceDemand {
  const visit = (widgets: WidgetSpec[] | undefined): void => {
    for (const w of widgets ?? []) {
      if (w.kind === 'group') visit((w as { children?: WidgetSpec[] }).children)
      if (w.kind !== 'artifact_ref') continue
      const src = (w as ArtifactRefWidget).source
      if (!src) continue
      if (isAxisScopedSource(src)) {
        const kinds = into.axisKinds.get(src.axis) ?? new Set<string>()
        kinds.add(typeof src.values === 'string' && src.values ? src.values : 'text')
        into.axisKinds.set(src.axis, kinds)
      } else {
        const t = src.subtypes_of ?? src.datatype
        if (t) into.catalogTypes.add(t)
      }
    }
  }
  visit(spec.widgets)
  for (const decl of Object.values(spec.data ?? {})) {
    const d = decl as {
      source?: string
      args?: { axis?: string; datatype?: string; entity_axis?: string; level_axis?: string }
    }
    if (d?.source === 'axis_columns' && typeof d.args?.axis === 'string') into.axisSlices.add(d.args.axis)
    if (d?.source === INTEGRATION_GRID_SOURCE) {
      const entity = d.args?.entity_axis
      const level = d.args?.level_axis
      // A slice that declares neither is the failure this fixture must be able to SHOW, not
      // paper over: the resolver refuses rather than guessing, so the plan is empty and Run
      // is unreachable. Seeding a catalog from guessed axes would hide exactly that.
      if (typeof entity === 'string' && entity !== '' && typeof level === 'string' && level !== '') {
        into.gridAxes.push({ entity, level })
      }
    }
  }
  return into
}

/**
 * Build ONE project's wire catalog that satisfies every declared source of `specs`, at the
 * requested candidate cardinality for the CATALOG (project-wide) sources.
 *
 * `anchorCount` is the parameter the existing layers never varied: 1 is the auto-select arm
 * (what a single-dataset project hits, and the arm that broke), 2 is the picker arm (what
 * the e2e fixture happened to seed), 0 is the empty arm.
 */
function wireCatalog(specs: ViewSpec[], anchorCount: number): WireProjectCatalog {
  const demand: SourceDemand = {
    catalogTypes: new Set(),
    axisKinds: new Map(),
    axisSlices: new Set(),
    gridAxes: [],
  }
  axisIndexIds.clear()
  for (const s of specs) demandsOf(s, demand)

  // Every axis any source or slice mentions — the anchor must declare them all, or an
  // axis-scoped source has nothing to be scoped BY. A binding plan's two axes count: its
  // anchors are scoped by them.
  const axes = [
    ...new Set([
      ...demand.axisKinds.keys(),
      ...demand.axisSlices,
      ...demand.gridAxes.flatMap(g => [g.level, g.entity]),
    ]),
  ]
  const artifacts: WireArtifact[] = []

  // ── THE DATASET DIMENSION ────────────────────────────────────────────────────────────
  //
  // Every artifact this fixture used to synthesize sat on ONE dataset. That is right for a
  // form whose inputs all come from one, and WRONG for one whose input IS several: the
  // binding plan dedupes by dataset, so two anchors of one dataset resolve to one usable
  // source and "integrate a dataset with itself" — the plan's own refusal — is what the
  // tier would have measured instead of the form.
  //
  // So when a view declares a binding plan, each anchor gets its OWN dataset, and that
  // dataset is given the artifacts a plan needs from it. Otherwise the single-dataset
  // shape is unchanged, and every package that does not declare one is byte-identical.
  const perDataset = demand.gridAxes.length > 0
  const datasetOf = (i: number): string | undefined => (perDataset ? `${DATASET_A}-${i}` : undefined)

  for (const datatype of demand.catalogTypes) {
    for (let i = 0; i < anchorCount; i++) {
      artifacts.push({
        ...wireArtifact({
          datatype,
          structure: matrixStructure(axes.length ? axes : ['a', 'b']),
          ...(perDataset ? { dataset_id: datasetOf(i) } : {}),
        }),
      })
    }
  }

  // What a binding plan needs from each dataset it is asked to include: exactly ONE declared
  // row index on the level axis (with a content hash — that hash is the compute's whole
  // cross-check, so an index without one is not a usable binding), at least one identifier
  // column on the entity axis, and one categorical on the level axis to fuse.
  //
  // The two datasets share the COLUMN NAMES and nothing else — that is what makes them
  // joinable at all, and every id stays distinct so a resolver that reads position for
  // identity cannot pass here.
  const gridColumnType = columnDatatypeId()
  for (const { entity, level } of demand.gridAxes) {
    for (let i = 0; i < anchorCount; i++) {
      const dataset_id = datasetOf(i)
      const index = wireArtifact({
        datatype: gridColumnType,
        dataset_id,
        meta: { name: `index_${i}`, is_axis_index: true },
        structure: columnStructure(level, 'string', 'values'),
      })
      axisIndexIds.add(index.id)
      artifacts.push(index)
      artifacts.push(
        wireArtifact({
          datatype: gridColumnType,
          dataset_id,
          meta: { name: 'shared_identifier' },
          structure: columnStructure(entity, 'string', 'values'),
        }),
      )
      artifacts.push(
        wireArtifact({
          datatype: gridColumnType,
          dataset_id,
          meta: { name: 'shared_label' },
          structure: columnStructure(level, 'categorical', 'values'),
        }),
      )
    }
  }

  // Sibling columns on each demanded axis — a REALISTIC axis, not the minimum that makes
  // the source non-empty:
  //
  //   · the axis's own INDEX, inline utf8 (`string`), which is the encoding an index uses;
  //   · one column per ENCODING the source's term admits (`valueKindsFor`), which is how a
  //     real producer stores repeated labels — dictionary-encoded, not inline;
  //   · a `numeric` column, so "the source narrowed correctly" stays distinguishable from
  //     "the source offered everything".
  //
  // Synthesizing the source's TERM as if it were a stamp would have hidden the whole
  // defect: a fixture stamping `kind: text` makes a `values: string` filter fail and a
  // `values: text` filter pass for the wrong reason. Producers stamp ENCODINGS, so the
  // fixture stamps encodings and the term is resolved against them — which is exactly the
  // relationship the resolver is being tested on.
  const columnType = columnDatatypeId()
  for (const axis of demand.axisKinds.keys()) {
    // A FIXED realistic axis, independent of what any source asks for: the axis's own
    // index (inline utf8), a dictionary-encoded column beside it, and a numeric one.
    //
    // Seeding only the encodings a source's term admits is what made an earlier version of
    // this fixture useless: the axis then contained exactly what the filter wanted and
    // nothing else, so a filter that was too NARROW looked identical to one that was right.
    // A fixture must be able to represent the candidate the code wrongly drops.
    const index = wireArtifact({ datatype: columnType, structure: columnStructure(axis, 'string') })
    axisIndexIds.add(index.id)
    artifacts.push(index)
    artifacts.push(wireArtifact({ datatype: columnType, structure: columnStructure(axis, 'categorical', 'label') }))
    artifacts.push(wireArtifact({ datatype: columnType, structure: columnStructure(axis, 'numeric', 'other') }))
  }
  for (const axis of demand.axisSlices) {
    if (demand.axisKinds.has(axis)) continue
    artifacts.push(wireArtifact({ datatype: columnType, structure: columnStructure(axis, 'numeric') }))
  }

  return {
    project_id: 'p-conformance',
    axes: axes.map((name, i) => ({ content_hash: `sha256:axis-${name}`, name, length: 10 * (i + 1) })),
    artifacts,
  }
}

/** The datatype id a single-column artifact carries, taken from what the shipped views'
 *  axis-scoped sources declare (they name it in `datatype:`). Falls back to the first
 *  contributed non-abstract type so the tier still runs if no view declares one. */
function columnDatatypeId(): string {
  for (const p of PACKAGES_WITH_UI) {
    for (const raw of Object.values(p.pkg.views)) {
      const spec = raw as ViewSpec
      for (const w of spec.widgets ?? []) {
        if (w.kind !== 'artifact_ref') continue
        const src = (w as ArtifactRefWidget).source
        if (src && isAxisScopedSource(src) && typeof src.datatype === 'string') return src.datatype
      }
    }
  }
  return contributedDatatypes().find(d => !d.is_abstract)?.id ?? 'unknown'
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// 3. The HARNESS — the real pane, over the real wire→row mapper
// ═══════════════════════════════════════════════════════════════════════════════════════

interface LaunchRecord {
  params: Record<string, unknown>
  inputs: Array<{ slot: string; artifactId: string }>
}

interface Mounted {
  render: DeclarativeRenderSpec
  /** the rows the app derived from the wire — what every picker resolves against. */
  rows: ArtifactRow[]
  launches: LaunchRecord[]
  state(viewId: string): Record<string, unknown>
  /** timing control over the plane's value-preview read — see {@link gatePreview}. */
  preview: PreviewGate
}

/**
 * A HOLD/RELEASE gate over the fake plane's value-preview read.
 *
 * It exists because a fake that answers instantly cannot express the failure it is
 * supposed to catch. "Switching the selection replaces the excerpt rather than leaving the
 * prior column's on screen" has two halves: the settled one (the excerpt follows the
 * choice), which any fake can show, and the IN-FLIGHT one — the window between choosing
 * column B and B's values arriving, which is precisely where A's values would still be
 * sitting under B's name. A microtask-fast fake skips that window entirely, so an
 * assertion written against it passes for a control that keeps stale values indefinitely.
 * Measured: a mutation that renders the previous column's excerpt survived this tier until
 * the gate existed.
 */
interface PreviewGate {
  /** Hold every subsequent read open until {@link release}. */
  hold(): void
  /** Let the held reads answer, and stop holding. */
  release(): Promise<void>
}

function gatePreview(plane: DataHost): { plane: DataHost; gate: PreviewGate } {
  let holding = false
  let waiters: Array<() => void> = []
  return {
    plane: {
      ...plane,
      previewValues: async request => {
        const answer = plane.previewValues(request)
        if (holding) await new Promise<void>(resolve => waiters.push(resolve))
        return answer
      },
    },
    gate: {
      hold() {
        holding = true
      },
      async release() {
        const pending = waiters
        waiters = []
        holding = false
        await act(async () => {
          for (const resolve of pending) resolve()
          await Promise.resolve()
          await Promise.resolve()
        })
      },
    },
  }
}

/**
 * A `WorkbenchHost` whose data plane serves EXACTLY what each wire read can carry, mapped
 * by the SAME functions the production host uses. Nothing here hand-builds an `ArtifactRow`.
 *
 * The two reads are modelled SEPARATELY and that is the point of the whole harness:
 *
 *   `catalog()`        → the project OVERVIEW. Its rows are `Artifact`, which has no
 *                        `source_dataset_id` — TypeScript will not let this fixture add one.
 *   `artifacts.query()` → the LIST. Its rows are `ListedArtifact`, which carries the
 *                        provenance an axis-scoped source is scoped by.
 *
 * A picker wired to the first offers nothing, in every project, forever; wired to the
 * second it works. Collapsing the two into one seeded row set — which every other fixture
 * in the tree does — makes both wirings look identical and the defect unobservable.
 */
function hostFor(
  wire: WireProjectCatalog,
  launches: LaunchRecord[],
): { host: WorkbenchHost; rows: ArtifactRow[]; preview: PreviewGate } {
  const mapped = toProjectCatalog(wire)
  const listed: ListedArtifact[] = wire.artifacts.map(a => ({
    ...a,
    source_dataset_ids: [a.dataset_id ?? DATASET_A],
    source_dataset_names: [a.dataset_id ?? DATASET_A],
    source_dataset_id: a.dataset_id ?? DATASET_A,
    source_dataset_name: a.dataset_id ?? DATASET_A,
  }))
  const rows = listed.map(toArtifactRow)
  const fake = makeFakeDataHost({
    projectId: mapped.project_id,
    artifacts: rows,
    axes: mapped.axes,
    isA: (sub, sup) => workbenchLattice.isA(sub, sup),
  })
  const compute: ComputeHost = {
    // The capture point is the `POST /api/jobs` REQUEST — past `resolveInputs` and past
    // the jobs capability's own serialization, so what is recorded is literally what the
    // backend would be asked to run. Capturing earlier (at `runProcessor`) would re-read
    // the view's own declaration and prove nothing about the launch.
    createJob: async (req: unknown) => {
      const analysisSpec = ((req as { params?: Record<string, unknown> }).params ?? {}) as {
        params?: Record<string, unknown>
        inputs?: Array<{ slot?: string; artifact_ref?: string }>
      }
      launches.push({
        params: analysisSpec.params ?? {},
        inputs: (analysisSpec.inputs ?? []).map(i => ({
          slot: String(i.slot ?? ''),
          artifactId: String(i.artifact_ref ?? ''),
        })),
      })
      return { jobId: `job-${launches.length}` }
    },
    streamJob: (_id: string, onFrame: (f: { phase: string; pct?: number }) => void) => {
      onFrame({ phase: 'completed', pct: 100 })
      return { dispose: () => {} }
    },
  } as ComputeHost
  const gated = gatePreview({ ...fake, catalog: async () => mapped })
  const host: WorkbenchHost = {
    projectId: mapped.project_id,
    events: { on: () => ({ dispose: () => {} }), emit: () => {} },
    storage: { get: () => null, set: () => {}, remove: () => {} },
    ui: { notify: () => {}, confirm: async () => true },
    datatypes: workbenchLattice,
    planes: { [DATA_CAPABILITY_ID]: gated.plane, [JOBS_CAPABILITY_ID]: compute },
  } as unknown as WorkbenchHost
  return { host, rows, preview: gated.gate }
}

async function mountPane(pkg: ShippedPackage, anchorCount: number, strict = false): Promise<Mounted> {
  const specs = Object.values(pkg.pkg.views) as ViewSpec[]
  const wire = wireCatalog(specs, anchorCount)
  const launches: LaunchRecord[] = []
  const { host, rows, preview } = hostFor(wire, launches)
  const api = createWorkbenchApi(host, 'conformance')

  const result = registerProcessorPackage(pkg.pkg, workbenchRegistry)
  expect(result.errors, `${pkg.dir}: the shipped package must register cleanly`).toEqual([])
  const contribution = workbenchRegistry.views.all().find(v => result.viewContributionIds.includes(v.id))
  expect(contribution, `${pkg.dir}: registered a pane`).toBeTruthy()
  const spec = (contribution as { render?: { spec?: unknown } }).render?.spec
  if (!isDeclarativeRenderSpec(spec)) throw new Error(`${pkg.dir}: not a declarative pane`)

  const tree = (
    <WorkbenchProvider api={api} projectId={wire.project_id} viewId="wb" canEdit>
      <DeclarativeStack render={spec} />
    </WorkbenchProvider>
  )
  await act(async () => {
    // StrictMode is what the DEV app runs, and it is not cosmetic here: it double-invokes
    // mount effects as retain → release → retain, and `release` DISPOSES the view store.
    // A control that lands its value in the store on the first retain, into a store that is
    // then thrown away, keeps DISPLAYING that value while state holds nothing — the exact
    // show-without-state divergence P1 forbids, reachable only under StrictMode.
    render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
  })
  // The catalog fetch is async; a picker paints its empty arm until the rows land.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  return {
    render: spec,
    rows,
    launches,
    preview,
    state: viewId => (peekStore(viewId)?.state ?? {}) as Record<string, unknown>,
  }
}

beforeEach(() => {
  datatypeRegistry.replaceAll([...BOOTSTRAP_LATTICE, ...contributedDatatypes()])
})
afterEach(() => {
  cleanup()
  __resetDeclarativeMountsForTests()
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// helpers that read the MOUNTED surface (never the YAML text)
// ═══════════════════════════════════════════════════════════════════════════════════════

const testidOf = (w: { id?: string }): string => `widget-${w.id ?? 'artifact_ref'}`

/** Every `artifact_ref` widget a spec declares, including inside a `group`. */
function artifactRefs(spec: ViewSpec): ArtifactRefWidget[] {
  const out: ArtifactRefWidget[] = []
  const visit = (ws: WidgetSpec[] | undefined): void => {
    for (const w of ws ?? []) {
      if (w.kind === 'group') visit((w as { children?: WidgetSpec[] }).children)
      else if (w.kind === 'artifact_ref') out.push(w as ArtifactRefWidget)
    }
  }
  visit(spec.widgets)
  return out
}

/** What the RENDERED control claims is chosen — read off the DOM, in the same three arms
 *  the widget itself branches on. `undefined` = the control is not on screen at all. */
function shownIds(w: ArtifactRefWidget): string[] | undefined {
  const base = testidOf(w)
  const summaries = document.querySelectorAll<HTMLElement>(`[data-testid^="${base}"][data-testid$="-summary"]`)
  if (summaries.length > 0) {
    return [...summaries].map(el => el.getAttribute('data-artifact-id') ?? '')
  }
  const empties = document.querySelectorAll(`[data-testid^="${base}"][data-testid$="-empty"]`)
  if (empties.length > 0) return []
  const selects = document.querySelectorAll<HTMLElement>(`[data-testid^="${base}"][data-testid$="-select"]`)
  if (selects.length === 0) return undefined
  const out: string[] = []
  for (const sel of selects) {
    if (sel instanceof HTMLSelectElement) {
      if (sel.value) out.push(sel.value)
    } else {
      // A popover picker DISPLAYS its selection inside its own trigger — one rendering for the
      // single arm, one per tag for the `multiple` arm — and each of those carries the id of
      // the artifact it NAMES. Reading that is the same question `sel.value` answered for a
      // native control ("what is on screen"), and it now covers the `multiple` arm too: the
      // previous `[data-value]` read matched nothing a tag renders, so a bound multi picker
      // reported an empty display and P1 held vacuously over it.
      for (const shown of sel.querySelectorAll('[data-artifact-id]')) {
        const v = shown.getAttribute('data-artifact-id')
        if (v) out.push(v)
      }
    }
  }
  return out
}

/** The VALUE-EXCERPT node belonging to one rendered control — found through the shared
 *  `WidgetField` wrapper the control sits in, so a `for_each`-repeated picker (whose
 *  instances all carry the SAME widget testid) is matched to ITS OWN excerpt rather than to
 *  the first one on the page. */
function previewIn(control: HTMLElement): HTMLElement | null {
  const field = control.closest('[data-testid$="-field"]')
  return field?.querySelector<HTMLElement>('[data-testid$="-preview"]') ?? null
}

/** Would an excerpt of this artifact's values be shown at all?
 *
 *  Computed from the producer's DECLARED encodings — the same fact the control dispatches
 *  on, reached through this file's existing declaration reader rather than through the
 *  widget's own predicate, so the two are not the same function agreeing with itself. A
 *  single column whose encoding carries text (`string` = inline utf8, `categorical` =
 *  dictionary-encoded) is previewable; a numeric one is not (DEC-3). */
function previewableRow(row: ArtifactRow): boolean {
  const kinds = declaredValueKinds(row.structure)
  return kinds.length === 1 && valueKindsFor('text').includes(kinds[0])
}

/** Every `table` widget a spec declares, including inside a `group`. */
function tables(spec: ViewSpec): TableWidget[] {
  const out: TableWidget[] = []
  const visit = (ws: WidgetSpec[] | undefined): void => {
    for (const w of ws ?? []) {
      if (w.kind === 'group') visit((w as { children?: WidgetSpec[] }).children)
      else if (w.kind === 'table') out.push(w as TableWidget)
    }
  }
  visit(spec.widgets)
  return out
}

/**
 * Every VALUE-BEARING per-row control the mounted tables rendered, paired with the expression
 * it declares and the row it belongs to.
 *
 * The primitives are read off the spec rather than listed here: any `cell:` entry carrying a
 * `value` is a control that DISPLAYS something, whatever it lowers onto. So a fourth one
 * added tomorrow is covered by this assertion the day it ships, rather than on the day
 * someone remembers to extend a list — the same reason the package set, the datatype lattice
 * and the catalog in this file are all derived.
 *
 * The DOM node is found by its testid rather than by walking the table: the renderer stamps
 * `widget-<table>-<primitive>-<columnKey>-<rowIndex>`, and the ROW INDEX in that id is what
 * makes "row N shows row N's value" checkable at all.
 */
function rowFieldControls(
  spec: ViewSpec,
  state: Record<string, unknown>,
): Array<{ table: string; column: string; index: number; expr: string; el: HTMLElement }> {
  const out: Array<{
    table: string
    column: string
    index: number
    expr: string
    el: HTMLElement
  }> = []
  const base = { state, derived: {}, const: spec.const ?? {}, params: {}, data: {} }
  for (const t of tables(spec)) {
    const rows = evalExpr(t.rows, base)
    if (!Array.isArray(rows)) continue
    const tableId = `widget-${t.id ?? 'table'}`
    // Row-scoped parts through the ONE shared enumeration — a value-bearing control placed in
    // the row's detail band is a per-row field on exactly the terms one in a column is, and a
    // collector spelling `.columns` would report it as un-rendered rather than as absent.
    for (const { decl: rowPart } of tableRowParts(t)) {
      const col = rowPart as TableColumnSpec
      const cell = col.cell as Record<string, { value?: string }> | undefined
      for (const inner of Object.values(cell ?? {})) {
        const expr = inner?.value
        if (typeof expr !== 'string' || !expr.startsWith('$')) continue
        rows.forEach((row, index) => {
          const el = document.querySelector<HTMLElement>(
            `[data-testid$="-${col.key}-${index}"][data-testid^="${tableId}-"]`,
          )
          // A per-row control lowers onto a text `<input>` OR a popover picker (the closed-set
          // column). Both are value-BEARING, so both are in scope here — restricting this to
          // the native element types would have silently dropped every closed-set column from
          // the assertion below the day it stopped being a `<select>`, which is exactly the
          // "the check looked at nothing" failure the non-vacuity guard exists for.
          if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || (el && isPicker(el))) {
            out.push({ table: String(t.id), column: String(col.key), index, expr, el })
          }
        })
      }
    }
  }
  return out
}

/**
 * What ONE value-bearing control DISPLAYS, whichever primitive it lowers onto.
 *
 * `''` is "nothing shown", which is a real display state (an empty text field, a picker
 * showing its placeholder) and not a read failure — the whole point of the assertion below is
 * that it must equal what state holds.
 */
function displayedValue(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return el.value
  return pickerShownValues(el)[0] ?? ''
}

/** What STATE holds for that control's binding. */
function boundIds(w: ArtifactRefWidget, state: Record<string, unknown>): string[] {
  // A per-row picker binds `…[$i]`; read the whole list it indexes into so the comparison
  // is against every row's value at once (which is what `shownIds` returns).
  const expr = (w.value ?? '').replace(/\[\$[A-Za-z_][A-Za-z0-9_]*\]$/, '')
  const v = evalExpr(expr, { state, derived: {}, const: {}, params: {}, data: {} })
  const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v]
  return list.filter((x): x is string => typeof x === 'string' && x !== '')
}

/** Interactive elements the mounted form actually exposes TO A USER.
 *
 *  `aria-hidden` / `tabindex="-1"` elements are excluded, and that is not a convenience:
 *  a kit control (base-ui's Checkbox) renders a visually-hidden native `<input>` behind its
 *  real, named, focusable widget. That input is not an affordance — it is the widget's own
 *  plumbing, unreachable by pointer, keyboard or screen reader. Counting it would make the
 *  a11y assertion below fail on correct code, which is how a guard gets weakened. */
function affordances(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      // `[role="combobox"]` covers the `multiple` picker, whose trigger is a focusable DIV
      // rather than a button (so its removable tag buttons can nest) — without it that
      // control would silently fall out of the operability + accessible-name assertions
      // below purely because of the element it lowers onto.
      'button, [role="checkbox"], [role="switch"], [role="combobox"], input:not([type="hidden"]), select, textarea',
    ),
  ].filter(el => el.getAttribute('aria-hidden') !== 'true' && el.getAttribute('tabindex') !== '-1')
}

function accessibleName(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label')
  if (aria && aria.trim()) return aria.trim()
  const labelledby = el.getAttribute('aria-labelledby')
  if (labelledby) {
    const t = labelledby
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim()
    if (t) return t
  }
  const id = el.getAttribute('id')
  if (id) {
    const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`)
    if (lab?.textContent?.trim()) return lab.textContent.trim()
  }
  return (el.textContent ?? '').trim()
}

/** Words that tell a user "this destroys something". The set is deliberately generous —
 *  the assertion is not "use this exact word", it is "SAY SO SOMEHOW". */
const DESTRUCTIVE_WORDS = /\b(remove|delete|clear|discard|drop|detach|unlink|reset)\b/i

/** Did this state transition DESTROY user-visible content? True when any array-valued field
 *  got shorter, or a non-empty scalar became empty. */
function isDestructive(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  for (const [k, b] of Object.entries(before)) {
    const a = after[k]
    if (Array.isArray(b) && Array.isArray(a) && a.length < b.length) return true
    if (typeof b === 'string' && b !== '' && a === '') return true
  }
  return false
}

const stateChanged = (before: Record<string, unknown>, after: Record<string, unknown>): boolean =>
  JSON.stringify(before) !== JSON.stringify(after)

/** Activate one affordance the way a user would, by what it IS. */
/**
 * Answer every REQUIRED picker the fixture left ambiguous, by choosing real options through
 * the control — a single picker at its first, a `multiple` one up to its declared `min_items`.
 *
 * It used to answer only the SINGLE arm, and the omission was not a coverage gap but an
 * exclusion: a form whose first required control is a `multiple` picker could never be
 * completed here, so the tier could not certify it, so the analysis carried
 * `launchable: false` — and `launchable: false` in turn removed its whole package from this
 * tier. One harness limitation had made a real form both uncertifiable and unreachable.
 *
 * Only unbound (`value === ''`) selects are touched, and only with an option the control is
 * actually offering — so this simulates a user completing the form, never a test writing a
 * binding the UI would not have produced. A picker the resolver pre-selected is left alone;
 * overwriting it would destroy the sole-candidate arm this tier also covers.
 *
 * Loops until quiet (bounded): answering one picker can REVEAL another — a package's paired row
 * is `for_each` over the chosen anchors, so it does not exist until an anchor is chosen. One
 * pass would leave the dependent row unanswered and the form still incomplete.
 */
async function completeRequiredPickers(needs?: ReadonlyMap<string, number>): Promise<void> {
  // How many values THIS control must show before it counts as answered. A single picker is
  // done at one. A `multiple` picker is done at its own declared `min_items` — read from the
  // SHIPPED declaration, keyed by the widget id its testid is built from.
  //
  // Without this the loop asked `shownValues.length === 0` of every control, which is the
  // wrong question twice over for a multi picker: it skipped it entirely (the trigger of the
  // `multiple` arm is a DIV, and the filter demanded a `<button>`), and even reached, a
  // control showing ONE auto-bound tag under `min_items: 2` reads as already answered.
  const wanted = (el: HTMLElement): number => {
    const testid = el.getAttribute('data-testid') ?? ''
    const m = /^widget-(.+)-select$/.exec(testid)
    const id = m?.[1]
    return (id !== undefined ? needs?.get(id) : undefined) ?? 1
  }
  for (let pass = 0; pass < 6; pass++) {
    const nativePending = [...document.querySelectorAll<HTMLSelectElement>('select')].filter(
      s => s.value === '' && [...s.options].some(o => o.value !== '' && !o.disabled),
    )
    // An UNANSWERED single picker shows nothing — its trigger renders the placeholder, so no
    // node inside it names a value. That is the same question `value === ''` asked of a native
    // select, asked of what the control DISPLAYS; and it is asked of EVERY closed set, not
    // just the artifact ones, because a `disabled`-looking predicate written against one
    // control's marker reports every other picker as permanently unanswered (which would make
    // this loop re-answer an already-answered control on every pass).
    const pickerPending = [...document.querySelectorAll<HTMLElement>('[role="combobox"]')].filter(
      el =>
        isSinglePicker(el) &&
        !el.hasAttribute('disabled') &&
        el.getAttribute('aria-disabled') !== 'true' &&
        pickerShownValues(el).length === 0,
    )
    // ── THE `multiple` ARM ──────────────────────────────────────────────────────────────
    //
    // Under-answered, not merely unanswered: a multi picker with `min_items: 2` and one
    // auto-bound sole candidate is INCOMPLETE while showing a value, so the predicate is a
    // count against the declaration and never `=== 0`.
    const multiPending = [...document.querySelectorAll<HTMLElement>('[role="combobox"]')].filter(
      el =>
        isPicker(el) &&
        !isSinglePicker(el) &&
        !el.hasAttribute('disabled') &&
        el.getAttribute('aria-disabled') !== 'true' &&
        pickerShownValues(el).length < wanted(el),
    )
    if (nativePending.length === 0 && pickerPending.length === 0 && multiPending.length === 0) return
    for (const sel of nativePending) {
      const first = [...sel.options].find(o => o.value !== '' && !o.disabled)
      if (!first) continue
      await act(async () => {
        fireEvent.change(sel, { target: { value: first.value } })
        await Promise.resolve()
      })
    }
    for (const picker of pickerPending) {
      const first = (await pickerOptions(picker))[0]
      if (first === undefined) continue
      await choosePicker(picker, first)
    }
    for (const picker of multiPending) {
      // Chosen one at a time through the control, never written as a list: the multi arm
      // emits the whole cumulative array on each pick, so this exercises the same path a
      // user's clicks take. Options already shown are skipped — re-picking one toggles it
      // OFF, which would make the loop oscillate instead of converge.
      for (const option of await pickerOptions(picker)) {
        if (pickerShownValues(picker).length >= wanted(picker)) break
        if (pickerShownValues(picker).includes(option)) continue
        await choosePicker(picker, option)
      }
    }
  }
}

async function activate(el: HTMLElement): Promise<void> {
  // A POPOVER picker is operated in two gestures, and BOTH are the affordance: clicking the
  // trigger alone only opens a list, so stopping there would report "activating this changed
  // nothing" for a control that works perfectly. This mirrors exactly what the native-select
  // branch below does in one gesture — move to an option OTHER than the one on screen.
  if (isPicker(el)) {
    // "OTHER than what is on screen" has to be read from what the control DISPLAYS, across
    // every closed set — an artifact-only read reports a bound column picker as showing
    // nothing, so this would re-choose the value it already holds and then report a working
    // control as one that "changed NOTHING".
    const shown = new Set(pickerShownValues(el))
    const other = (await pickerOptions(el)).find(v => !shown.has(v))
    if (other !== undefined) await choosePicker(el, other)
    return
  }
  await act(async () => {
    if (el instanceof HTMLInputElement && (el.type === 'text' || el.type === '' || el.type === 'search')) {
      fireEvent.change(el, { target: { value: `${el.value}x` } })
    } else if (el instanceof HTMLSelectElement) {
      const other = [...el.options].find(o => o.value !== el.value && !o.disabled)
      if (other) fireEvent.change(el, { target: { value: other.value } })
    } else {
      fireEvent.click(el)
    }
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// The tier must not pass by enumerating nothing.
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('shipped-form conformance — enumeration', () => {
  it('discovers every shipped processor view from disk, and finds more than one', () => {
    expect(PACKAGES.length).toBeGreaterThan(0)
    // A positive control on the enumeration itself: if the glob breaks, every property
    // below would pass vacuously. Three packages ship a `ui/` today.
    expect(PACKAGES_WITH_UI.length).toBeGreaterThanOrEqual(3)
    for (const p of PACKAGES_WITH_UI) expect(Object.keys(p.pkg.views).length).toBeGreaterThan(0)
  })

  it('every shipped view declares at least one input control (else P1 is vacuous)', () => {
    for (const p of PACKAGES_WITH_UI) {
      const refs = (Object.values(p.pkg.views) as ViewSpec[]).flatMap(artifactRefs)
      expect(refs.length, `${p.dir} declares an artifact_ref`).toBeGreaterThan(0)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// P0 — an INCOMPLETE form is NOT launchable, and says which control is unanswered
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// The missing negative control. Everything below asserts what a COMPLETED form does; a
// validator that always answers "valid" passes every one of those and this tier would have
// certified it — which is not hypothetical, because this file's own history is that it once
// asserted Run be ENABLED with a required input missing, and a package shipped with its Run
// affordance live over an empty slot.
//
// "Required" and "unanswered" are read from the SHIPPED DECLARATION and the LIVE STORE
// respectively — never from the verdict map, which would be the engine agreeing with itself.

/** How many required-and-unanswered controls the P0 sweep actually judged. */
let exercisedIncompleteCases = 0
/** How many declared environment-empty sentences the three-cardinality sweep judged. */
let environmentEmptyChecked = 0
/** Packages whose COMPLETED form actually launched a run in the P1 launch test. */
const launchedForReal = new Set<string>()
/** Packages whose completed form was still gated — legitimately — on a declared `checks:`
 *  relation this harness cannot satisfy (an identifier that comes from a MEASUREMENT run).
 *  Counted so the branch cannot silently become the path every package takes. */
const gatedOnADeclaredCheck = new Set<string>()

/** The binding a widget's own value lives on — read off the SHIPPED declaration, by the
 *  same three keys a view may bind a list or a value through. */
function bindingOf(w: WidgetSpec & Record<string, unknown>): unknown {
  if (w.kind === 'table') return w.rows
  if (w.kind === 'list-editor') return w.items
  return w.value
}

/** Widgets declaring a PRESENCE requirement, paired with the label they are named by. */
function requiredControls(spec: ViewSpec): Array<{ widget: WidgetSpec & { id?: string; label?: string }; needs: number }> {
  const out: Array<{ widget: WidgetSpec & { id?: string; label?: string }; needs: number }> = []
  const visit = (ws: WidgetSpec[] | undefined): void => {
    for (const w of ws ?? []) {
      if (w.kind === 'group') visit((w as { children?: WidgetSpec[] }).children)
      const req = (w as { require?: { required?: boolean; min_items?: number } }).require
      if (!req) continue
      // BOTH keys, maxed — not `required` first. A control may declare both, and the shipped
      // integration form does exactly that (`required: true` beside `min_items: 2`, because
      // `required` alone is satisfied by any non-empty list). Taking `required` as an early
      // branch reported that control as needing ONE, so a harness driven by this number
      // under-answered it and then judged the half-filled form.
      const needs = Math.max(
        req.required === true ? 1 : 0,
        typeof req.min_items === 'number' && req.min_items > 0 ? req.min_items : 0,
      )
      if (needs > 0) out.push({ widget: w as never, needs })
    }
  }
  visit(spec.widgets)
  return out
}

/** The Run affordance the pane rendered, if it has one. */
function runAffordance(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('button')].find(b =>
    /^(run|compute|commit|start)\b/i.test(accessibleName(b)),
  )
}

/** The unmet-requirement lines the pane states beside that affordance. */
function statedRequirements(run: HTMLElement): string[] {
  const testid = run.getAttribute('data-testid')
  if (!testid) return []
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testid}-requirement"]`)].map(
    el => el.textContent ?? '',
  )
}

describe('P0 — an incomplete form is not launchable', () => {
  it('every shipped `disabledWhen` gates a DERIVED condition — never a restatement of form-fill validity', () => {
    // A hand-written whole-form predicate that RESTATES what the controls' `require` already
    // declare is a second encoding of one rule, and two encodings can disagree — one shipped one
    // DID: it compared list LENGTHS for a pairing written by INDEX, so a partially-answered form
    // read as complete. That failure mode is a predicate over the form's OWN values (`$state` /
    // `$scope`), which the closed `require` vocabulary already owns per control. Those are
    // forbidden here, and every historical one was deleted (its clause moved onto its control).
    //
    // `disabledWhen` still survives in the contract for "a condition about something OTHER than
    // the form's own values" — a DERIVED / RESOLVED fact the per-control `require` vocabulary
    // (required / min_items / max_items / number / unique_by / not_in) provably CANNOT express.
    // One shipped advanced-contrast overlap gate is exactly that: Run is disabled while the two
    // criteria masks intersect (`$derived.overlapBy`), a cross-mask fact no single control's
    // `require` can state — and it is required by that package's own acceptance test + its
    // binding mockup. Such a gate is ALLOWED; a `$state`/`$scope`-only fill-check is not. The
    // discriminator is whether the predicate reaches a `$derived.` / `$data.` slice.
    for (const p of PACKAGES_WITH_UI) {
      for (const [file, raw] of Object.entries(p.pkg.views)) {
        const offenders: { id: string; expr: string }[] = []
        const visit = (ws: WidgetSpec[] | undefined): void => {
          for (const w of ws ?? []) {
            if (w.kind === 'group') visit((w as { children?: WidgetSpec[] }).children)
            const dw = (w as { disabledWhen?: unknown }).disabledWhen
            if (dw !== undefined && !/\$(derived|data)\./.test(String(dw))) {
              offenders.push({ id: String((w as { id?: string }).id ?? w.kind), expr: String(dw) })
            }
          }
        }
        visit((raw as ViewSpec).widgets)
        expect(
          offenders,
          `${p.dir}/${file}: declares a form-fill \`disabledWhen\` ${JSON.stringify(offenders)}. A ` +
            `predicate over only the form's own values (\`$state\`/\`$scope\`) restates what the ` +
            `control's \`require\` already owns — declare it there, where the field, the summary ` +
            `and the gate read ONE declaration. \`disabledWhen\` is for a DERIVED condition ` +
            `(\`$derived\`/\`$data\`) the closed \`require\` vocabulary cannot express.`,
        ).toEqual([])
      }
    }
  })

  it.each(PACKAGES_WITH_UI.map(p => [p.dir, p] as const))(
    '%s: with a required control unanswered, Run is DISABLED and the summary names it',
    async (dir, pkg) => {
      const m = await mountPane(pkg, 1)
      let exercised = 0
      for (const view of m.render.views) {
        const spec = view.view_spec
        const state = m.state(view.view_id)
        const base = { state, derived: {}, const: spec.const ?? {}, params: {}, data: {} }
        for (const { widget, needs } of requiredControls(spec)) {
          for (const entry of expandForEach(widget as { for_each?: string }, base)) {
            // Is it ANSWERABLE? A control whose candidate set is empty is the project's
            // state, not an unanswered question — it is deliberately silent (DEC-6) and
            // asserting on it would assert the opposite of the rule.
            if (widget.kind === 'artifact_ref') {
              const cands = resolveArtifactRefSource(m.rows, (widget as ArtifactRefWidget).source, entry.scope, {
                lattice: workbenchLattice,
              })
              if (cands.length === 0) continue
            }
            const binding = bindingOf(widget as never)
            if (typeof binding !== 'string' || binding === '') continue
            const held = evalExpr(binding, entry.scope)
            const count = Array.isArray(held)
              ? held.filter(x => x != null && x !== '').length
              : held == null || held === ''
                ? 0
                : 1
            if (count >= needs) continue
            exercised += 1
            exercisedIncompleteCases += 1
            const run = runAffordance()
            expect(run, `${dir}: the pane renders no Run affordance to gate`).toBeTruthy()
            expect(
              run!.hasAttribute('disabled'),
              `${dir}/${view.view_id}: "${widget.id}" is a REQUIRED control holding ` +
                `${JSON.stringify(held)}, and Run is enabled anyway. A form that launches a run ` +
                `the compute will refuse has moved the failure from a sentence on screen to a ` +
                `sandbox exit code minutes later.`,
            ).toBe(true)
            const stated = statedRequirements(run!)
            expect(
              stated.some(line => line.includes(String(widget.label ?? widget.id))),
              `${dir}/${view.view_id}: Run is disabled but nothing names "${widget.label ?? widget.id}" — ` +
                `stated requirements were ${JSON.stringify(stated)}. A disabled primary action ` +
                `with no stated cause reads as broken.`,
            ).toBe(true)
          }
        }
      }
      // NON-VACUITY is asserted GLOBALLY rather than per package: a package whose every
      // required control auto-resolves at one candidate legitimately exercises nothing here.
      void exercised
    },
  )

  // ── "the project has none" vs "you have not chosen yet" ────────────────────────────
  //
  // A REPORTED defect, and the one the whole fixture set was blind to. Every view used to
  // carry an alert whose CONDITION tested selection state (`matrices.length == 0`) and whose
  // TEXT asserted the environment ("No raw-count expression matrix in this project yet.
  // Import one…"). Those are different propositions, and the alert asserted the second while
  // testing the first.
  //
  // It could only be seen at TWO candidates. The picker pre-selects at exactly one, so a
  // one-candidate fixture auto-binds and the condition is false; a zero-candidate fixture
  // makes the condition true for the right reason. Only the middle cardinality — several
  // present, none chosen — separates them, and it is also the ordinary state of any project
  // with more than one dataset in it. The message therefore appeared PRECISELY when the user
  // had more than one of the thing it said they had none of.
  //
  // So the property is asserted across all THREE cardinalities, per package, off the shipped
  // declaration: whatever sentence a view supplies for "the project has none" must appear
  // only when the project has none.
  it.each(PACKAGES_WITH_UI.map(p => [p.dir, p] as const))(
    '%s: the environment-empty sentence appears at ZERO candidates and NOWHERE else',
    async (dir, pkg) => {
      let declaredCount = 0
      for (const anchorCount of [0, 1, 2]) {
        const m = await mountPane(pkg, anchorCount)
        // Read the declarations off the MOUNTED contribution's views, not off every view the
        // package ships. `mountPane` mounts ONE pane; a package with a second analysis pane
        // (a second pane beside the first) does not render it here, and the two panes may
        // reuse a mockup-bound picker id (`expressionPicker`) with DIFFERENT `empty_text`. The
        // `offersNothing` query keys on that shared id (`widget-<id>…-empty`), so a declaration
        // read from the NON-mounted pane would cross-match the mounted pane's empty element and
        // read "off screen" for a sentence that was never meant to be on this pane at all. Every
        // other per-package assertion in this file already iterates `m.render.views`; this one
        // is aligned with them.
        const declared = (m.render.views as { view_spec: ViewSpec }[]).flatMap(v =>
          artifactRefs(v.view_spec)
            .filter(w => typeof (w as { empty_text?: string }).empty_text === 'string')
            .map(w => ({ widget: w, text: String((w as { empty_text?: string }).empty_text).trim() })),
        )
        declaredCount = declared.length
        const body = document.body.textContent ?? ''
        for (const { widget, text } of declared) {
          // The sentence is compared on its first clause: a YAML folded scalar re-wraps, so
          // whitespace in the file and whitespace on screen are not the same string.
          const claim = text.split(/[.!?]/)[0].replace(/\s+/g, ' ').trim()
          const onScreen = body.replace(/\s+/g, ' ').includes(claim)
          const offersNothing =
            document.querySelectorAll(`[data-testid^="${testidOf(widget)}"][data-testid$="-empty"]`).length > 0
          expect(
            onScreen,
            `${dir}: with ${anchorCount} candidate(s), "${widget.id}" ${offersNothing ? 'offers nothing' : 'OFFERS candidates'} ` +
              `and the environment-empty sentence is ${onScreen ? 'ON' : 'off'} screen. It must appear ` +
              `only when the source resolves NOTHING — a project holding several and a project ` +
              `holding none must not read the same.`,
          ).toBe(offersNothing)
        }
        cleanup()
        __resetDeclarativeMountsForTests()
      }
      environmentEmptyChecked += declaredCount
    },
  )

  it('…and at TWO candidates the unanswered requirement is what speaks instead', async () => {
    // The other half of the same distinction: the environment sentence going quiet is only
    // correct if SOMETHING still explains the disabled action. Asserted globally because a
    // package whose every control auto-resolves has nothing to say here.
    let spoke = 0
    for (const pkg of PACKAGES_WITH_UI) {
      const m = await mountPane(pkg, 2)
      for (const view of m.render.views) {
        const state = m.state(view.view_id)
        const base = { state, derived: {}, const: view.view_spec.const ?? {}, params: {}, data: {} }
        for (const { widget, needs } of requiredControls(view.view_spec)) {
          if (widget.kind !== 'artifact_ref') continue
          for (const entry of expandForEach(widget as { for_each?: string }, base)) {
            const cands = resolveArtifactRefSource(m.rows, (widget as ArtifactRefWidget).source, entry.scope, {
              lattice: workbenchLattice,
            })
            if (cands.length < 2) continue
            const held = evalExpr(bindingOf(widget as never) as string, entry.scope)
            const count = Array.isArray(held) ? held.filter(x => x != null && x !== '').length : held ? 1 : 0
            if (count >= needs) continue
            const run = runAffordance()
            if (!run) continue
            spoke += 1
            expect(
              statedRequirements(run).some(l => l.includes(String(widget.label ?? widget.id))),
              `${pkg.dir}: "${widget.id}" offers ${cands.length} candidates and holds none, and ` +
                `nothing on screen says so. The environment sentence is correctly silent here, ` +
                `so this is the only thing left to explain the disabled action.`,
            ).toBe(true)
          }
        }
      }
      cleanup()
      __resetDeclarativeMountsForTests()
    }
    expect(spoke, 'no control offered 2+ candidates while unanswered, so this asserted nothing').toBeGreaterThan(0)
  })

  it('at least one shipped view declares an environment-empty sentence to check', () => {
    expect(
      environmentEmptyChecked,
      'no shipped view declares `empty_text`, so the three-cardinality property above ' +
        'asserted nothing anywhere — which is exactly the blindness that let the reported ' +
        'defect ship.',
    ).toBeGreaterThan(0)
  })

  it('at least one shipped pane actually had an unanswered required control to check', () => {
    // Without this the whole property above passes the day `require` stops being read.
    expect(
      exercisedIncompleteCases,
      'no shipped pane rendered a required-and-answerable control that was unanswered, so the ' +
        'incomplete-form property asserted nothing anywhere.',
    ).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// P1 — show == state == launch
// ═══════════════════════════════════════════════════════════════════════════════════════

describe.each(PACKAGES_WITH_UI.map(p => [p.dir, p] as const))(
  'P1 %s — what the form SHOWS is what STATE holds is what the RUN receives',
  (dir, pkg) => {
    // 1 is the arm every single-dataset project hits and the arm the existing layers never
    // covered; 2 is the arm the e2e fixture happens to seed.
    for (const anchorCount of [1, 2]) {
      it(`with ${anchorCount} candidate(s): every rendered control's DISPLAYED value is in state`, async () => {
        const m = await mountPane(pkg, anchorCount)
        for (const view of m.render.views) {
          const state = m.state(view.view_id)
          for (const w of artifactRefs(view.view_spec)) {
            const shown = shownIds(w)
            if (shown === undefined) continue // control not on screen (a `when` gate / no rows)
            expect(
              boundIds(w, state).slice().sort(),
              `${dir}/${view.view_id}: control "${w.id}" DISPLAYS ${JSON.stringify(shown)} — ` +
                `state holds ${JSON.stringify(boundIds(w, state))}. A control that shows a value ` +
                `the run will not receive is the invisible resolution INV-4 removes.`,
            ).toEqual(shown.filter(x => x !== '').slice().sort())
          }
        }
      })
    }

    it('every value-bearing PER-ROW CONTROL displays exactly what state holds for THAT row', async () => {
      // P1 for the other half of the form. The `artifact_ref` assertions above cover the
      // controls that pick an ARTIFACT; a table column is where a row's own fields are
      // edited, and it has two divergence modes that look identical to a working control:
      //
      //   · a control evaluated in the TABLE's scope rather than the ROW's shows row 0's
      //     value on every row;
      //   · a closed-set control whose bound value matches no option silently displays the
      //     FIRST option while the store still holds the other value — no change event, so
      //     nothing downstream ever learns the two disagree.
      //
      // Both put a value on screen that the run will not receive, which is the same
      // invisible resolution INV-4 removes for inputs.
      const m = await mountPane(pkg, 1)
      // `${table}::${column}` for every per-row control the spec DECLARES over a non-empty row
      // set, and for every one the DOM actually yielded. Compared at the end (see the
      // non-vacuity note there) — a per-PACKAGE "at least one was checked" cannot see one
      // PRIMITIVE dropping out of the query while its siblings keep it green.
      const declared = new Set<string>()
      const found = new Set<string>()
      for (const view of m.render.views) {
        const state = m.state(view.view_id)
        const tableScope = {
          state,
          derived: {},
          const: view.view_spec.const ?? {},
          params: {},
          data: {},
        }
        for (const t of tables(view.view_spec)) {
          const declaredRows = evalExpr(t.rows, tableScope)
          if (!Array.isArray(declaredRows) || declaredRows.length === 0) continue
          for (const { decl: rowPart } of tableRowParts(t)) {
            const col = rowPart as TableColumnSpec
            const primitives = Object.values((col.cell ?? {}) as Record<string, { value?: string }>)
            if (primitives.some(inner => typeof inner?.value === 'string')) {
              declared.add(`${String(t.id)}::${String(col.key)}`)
            }
          }
        }
        for (const c of rowFieldControls(view.view_spec, state)) {
          found.add(`${c.table}::${c.column}`)
          const rows = evalExpr(
            (tables(view.view_spec).find(t => String(t.id) === c.table) as TableWidget).rows,
            { state, derived: {}, const: view.view_spec.const ?? {}, params: {}, data: {} },
          ) as unknown[]
          const held = evalExpr(c.expr, {
            state,
            derived: {},
            const: view.view_spec.const ?? {},
            params: {},
            data: {},
            row: rows[c.index],
          } as never)
          const shown = displayedValue(c.el)
          expect(
            shown,
            `${dir}/${view.view_id}: table "${c.table}" column "${c.column}" row ${c.index} ` +
              `DISPLAYS ${JSON.stringify(shown)} while state holds ${JSON.stringify(held)} ` +
              `(binding ${c.expr}). A control that shows a value the run will not receive is ` +
              `the same defect whether it picks an artifact or edits a row.`,
          ).toBe(held == null ? '' : String(held))
        }
      }
      // NON-VACUITY, per COLUMN — not per package.
      //
      // It used to be "at least one control was checked somewhere in this package", which a
      // table with several primitives satisfies from its OTHER columns: a closed-set column
      // that stopped being reachable by the query (it lowered onto a different element, its
      // testid convention changed) left the assertion green while silently checking nothing
      // about it. Every declared value-bearing column over a non-empty row set must be found.
      expect(
        [...declared].filter(k => !found.has(k)).sort(),
        `${dir}: these value-bearing per-row controls are DECLARED over non-empty rows but no ` +
          `rendered control was found for them, so the assertion above looked at nothing for ` +
          `them. Either the column stopped rendering, or it lowered onto something the query ` +
          `does not recognise as a value-bearing control.`,
      ).toEqual([])
    })

    it('offers no two candidates a user cannot tell apart', async () => {
      // A picker with N options that all READ THE SAME is not a working picker with a
      // cosmetic flaw — it is a choice the user cannot make, and the wrong pick silently
      // anchors every dependent control (and the run) to the wrong dataset. This is the
      // real shape of "the same file imported twice", which is an ordinary thing to have.
      const m = await mountPane(pkg, 2)
      let checkedAMultiCandidateControl = false
      for (const view of m.render.views) {
        const state = m.state(view.view_id)
        for (const w of artifactRefs(view.view_spec)) {
          // The candidate SET, resolved through the same function the widget calls, over
          // the same rows the pane fetched.
          //
          // Deliberately NOT read off the DOM `<option>`s. The `multiple` arm renders a
          // MultiSelect whose options live in a popover that is CLOSED at rest — so an
          // option-node query returns nothing and the assertion passes having looked at
          // nothing. That silently skipped the one control this defect was reported on;
          // the DOM read covered only the single-select arm. A property about the offered
          // SET is asserted on the set.
          const base = { state, derived: {}, const: view.view_spec.const ?? {}, params: {}, data: {} }
          for (const entry of expandForEach(w as { for_each?: string }, base)) {
            const cands = resolveArtifactRefSource(m.rows, w.source, entry.scope, { lattice: workbenchLattice })
            if (cands.length < 2) continue
            checkedAMultiCandidateControl = true
            // ── "TELL APART" IS A QUESTION ABOUT ONE GROUP, NOT THE WHOLE LIST ──────────
            //
            // The picker GROUPS its options by source dataset and renders that dataset as a
            // heading, precisely so the distinguishing substring is not a suffix that tail
            // truncation eats first. `disambiguate` therefore guarantees — and deliberately
            // only guarantees — uniqueness WITHIN a group: "two artifacts that read alike in
            // DIFFERENT datasets are already told apart by the group they sit under".
            //
            // Asserting global uniqueness demands something the control does not claim and
            // should not: two datasets' matrices of the same type and shape read identically
            // by design, under two different headings. That is the ordinary two-dataset
            // project, and this assertion only ever saw one dataset before, so the
            // disagreement was latent rather than absent. The group key is the candidate's
            // own dataset SET — the same key `disambiguate` uses, so the check cannot come to
            // mean something else than what the control promises.
            // JSON, not a delimiter join: the group key must be injective over an ID LIST
            // (an artifact that integrated two datasets carries two), and a separator that
            // can occur in an id would silently merge two groups. The NUL that is safe in
            // memory is not safe in SOURCE - a NUL byte makes `git diff` report the file as
            // binary, and every review gate downstream then reads an empty change.
            const groupKey = (c: (typeof cands)[number]): string => JSON.stringify(c.datasetIds ?? [])
            const groups = new Map<string, string[]>()
            for (const c of cands) groups.set(groupKey(c), [...(groups.get(groupKey(c)) ?? []), c.label])
            for (const [key, labels] of groups) {
              expect(
                new Set(labels).size,
                `${dir}/${view.view_id}: "${w.id}" offers ${labels.length} candidates from ONE ` +
                  `source (${key || 'no dataset'}) but only ${new Set(labels).size} distinct ` +
                  `labels — ${JSON.stringify(labels)}. A choice between options that read ` +
                  `identically is not a choice, and the wrong pick silently anchors every ` +
                  `dependent control (and the run) to the wrong dataset.`,
              ).toBe(labels.length)
            }
          }
        }
      }
      // POSITIVE CONTROL: with two candidates seeded per catalog source, at least one
      // control must have had a multi-candidate set to check. Without this the whole
      // assertion is vacuous the moment the resolver stops returning anything.
      expect(
        checkedAMultiCandidateControl,
        `${dir}: no control resolved 2+ candidates, so the distinctness check asserted nothing.`,
      ).toBe(true)
    })

    it('under StrictMode (what the dev app runs) the sole candidate still lands in state', async () => {
      // The remount cycle StrictMode forces is the one condition under which the
      // pre-selection can be performed, displayed, and lost — the store it landed in is
      // disposed and a fresh empty one takes its place.
      const m = await mountPane(pkg, 1, true)
      for (const view of m.render.views) {
        const state = m.state(view.view_id)
        for (const w of artifactRefs(view.view_spec)) {
          const shown = shownIds(w)
          if (shown === undefined) continue
          expect(
            boundIds(w, state).slice().sort(),
            `${dir}/${view.view_id}: under StrictMode "${w.id}" DISPLAYS ${JSON.stringify(shown)} ` +
              `while state holds ${JSON.stringify(boundIds(w, state))}.`,
          ).toEqual(shown.filter(x => x !== '').slice().sort())
        }
      }
    })

    it('the LAUNCH binds exactly the artifacts the form was showing', async () => {
      // How many CANDIDATES this package's form needs before it can be completed at all.
      //
      // It was the literal `1`, which is the sole-candidate arm — and a form whose required
      // control declares `min_items: 2` can never be completed against one candidate, no
      // matter how the harness answers it. Reading the number off the SHIPPED declaration
      // keeps every existing package at exactly 1 (none of them asks for more) while making
      // the tier able to reach a form that asks for several.
      const needsById = new Map<string, number>()
      for (const raw of Object.values(pkg.pkg.views)) {
        for (const { widget, needs } of requiredControls(raw as ViewSpec)) {
          if (typeof widget.id === 'string') needsById.set(widget.id, Math.max(needsById.get(widget.id) ?? 0, needs))
        }
      }
      const anchors = Math.max(1, ...needsById.values())
      const m = await mountPane(pkg, anchors)

      // FILL what the fixture left ambiguous, through the control itself.
      //
      // `anchorCount: 1` seeds one artifact per catalog TYPE, but an axis gets a realistic
      // three columns (index / categorical / numeric) so a too-narrow source stays
      // distinguishable from a correct one. A picker that narrows to two of those three has
      // no sole candidate to pre-select, and is therefore legitimately unbound — a REQUIRED
      // input the user has not answered yet.
      //
      // This step used to be absent, and the assertion below simply demanded Run be enabled.
      // That made the tier certify the defect it was written to prevent: a shipped package went
      // out with its Run affordance live while its paired slot was empty, so pressing it launched
      // a job the kernel refused, naming the slot that had zero bindings.
      // A green test said the form and the gate agreed; they agreed on the wrong answer.
      //
      // Answering through the rendered `<select>` (not by writing state) keeps the property
      // this tier exists for — show == state == launch — and moves the assertion from "a
      // form with a missing required input is launchable" to "a form the user has COMPLETED
      // is launchable", which is the claim worth defending.
      await completeRequiredPickers(needsById)

      // P1, AGAIN, now that a user has actually answered the form.
      //
      // The P1 assertions above run on a freshly-mounted pane, where every binding was made by
      // the resolver's own pre-selection. That leaves the interesting half untested: a control
      // that displays what it holds until a CHOICE is made, and then shows one thing while
      // holding another. It is exactly the shape a picker regresses to when its trigger renders
      // from anything other than the binding — and it is invisible from a mount-time check,
      // because at mount there is nothing chosen to disagree about.
      for (const view of m.render.views) {
        const state = m.state(view.view_id)
        for (const w of artifactRefs(view.view_spec)) {
          const shown = shownIds(w)
          if (shown === undefined) continue
          expect(
            boundIds(w, state).slice().sort(),
            `${dir}/${view.view_id}: after the form was COMPLETED through its own controls, ` +
              `"${w.id}" DISPLAYS ${JSON.stringify(shown)} while state holds ` +
              `${JSON.stringify(boundIds(w, state))}.`,
          ).toEqual(shown.filter(x => x !== '').slice().sort())
        }
      }

      const runBtn = [...document.querySelectorAll<HTMLElement>('button')].find(b =>
        /^(run|compute|commit|start)\b/i.test(accessibleName(b)),
      )
      if (!runBtn) return // a view with no run affordance has nothing to launch

      // ── A FORM WHOSE LAST GATE IS A MEASUREMENT, NOT A CONTROL ─────────────────────────
      //
      // Answering every control is what COMPLETES most forms, and for those the claim below
      // is unchanged and strict: Run must be live. But a form may declare a `checks:` relation
      // over something no control holds — the shipped integration form asks the user to pick
      // an identifier FROM A MEASUREMENT it launches, so its last gate is satisfied by a run,
      // not by a picker, and this harness serves no job results.
      //
      // The weaker claim would be "skip that form", which is how it came to be excluded from
      // this tier in the first place, with real defects hiding behind the exclusion. So it is
      // not skipped: what is asserted instead is the invariant that actually applies to a form
      // in that state, and it is the one whose violation reads as broken software — a disabled
      // primary action must NAME its cause, and that cause must be a declared cross-field
      // CHECK. An unanswered input CONTROL is still a failure here, exactly as before: those
      // are answerable, and a gate blaming one after the harness answered them all is the
      // form and the launch gate disagreeing.
      const declaredCheckMessages = new Set(
        m.render.views.flatMap(v =>
          ((v.view_spec as { checks?: Array<{ message?: unknown }> }).checks ?? [])
            .map(c => (typeof c.message === 'string' ? c.message.trim() : ''))
            .filter(msg => msg !== ''),
        ),
      )
      if (runBtn.hasAttribute('disabled')) {
        const stated = statedRequirements(runBtn).map(s => s.trim())
        expect(
          stated.length,
          `${dir}: the Run affordance is DISABLED and the pane states NO reason. A disabled ` +
            `primary action with no stated cause reads as broken software.`,
        ).toBeGreaterThan(0)
        // Every stated line must be a DECLARED check. A line quoting a control's own
        // `require.message` means an input is still unanswered — which the harness just
        // answered, so the form and the gate disagree.
        const unexplained = stated.filter(
          line => ![...declaredCheckMessages].some(msg => line.includes(msg)),
        )
        expect(
          unexplained,
          `${dir}: Run is disabled and the reasons it states are not declared \`checks:\` ` +
            `relations — every input control was answered through the UI, so these name ` +
            `something the harness already supplied:\n  ${unexplained.join('\n  ')}`,
        ).toEqual([])
        gatedOnADeclaredCheck.add(dir)
        return
      }
      launchedForReal.add(dir)
      await activate(runBtn)
      await waitFor(() => expect(m.launches.length).toBeGreaterThan(0), { timeout: 2000 })

      const launched = m.launches[0]
      // NON-VACUITY. `show == state == launch` is satisfied by a form that shows nothing,
      // holds nothing and launches nothing — which is exactly the shape the sole-candidate
      // arm regresses to if its pre-selection stops landing. With ONE candidate per catalog
      // source, a run must carry at least one artifact.
      expect(
        launched.inputs.length,
        `${dir}: the run was launched with NO artifact inputs at all, from a form whose ` +
          `every catalog source had exactly one candidate. Agreement between an empty ` +
          `display and an empty launch is not the invariant.`,
      ).toBeGreaterThan(0)
      for (const view of m.render.views) {
        const state = m.state(view.view_id)
        const run = (view.view_spec.actions ?? [])
          .flatMap(a => a.body ?? [])
          .map(op => (op as { run_processor?: { inputs?: Record<string, string> } }).run_processor)
          .find(Boolean)
        for (const [slot, expr] of Object.entries(run?.inputs ?? {})) {
          const boundToSlot = artifactRefs(view.view_spec).filter(w => (w.value ?? '').startsWith(expr))
          if (boundToSlot.length === 0) continue
          const shown = boundToSlot.flatMap(w => shownIds(w) ?? []).filter(Boolean)
          if (shown.length === 0) continue
          const got = launched.inputs.filter(i => i.slot === slot).map(i => i.artifactId)
          expect(
            got.slice().sort(),
            `${dir}: slot "${slot}" was SHOWN as ${JSON.stringify(shown)} but the run received ` +
              `${JSON.stringify(got)} (state: ${JSON.stringify(evalExpr(expr, { state, derived: {}, const: {}, params: {}, data: {} }))}).`,
          ).toEqual(shown.slice().sort())
        }
      }
    })
  },
)

// ═══════════════════════════════════════════════════════════════════════════════════════
// P2 — every rendered affordance is reachable, operable and HONEST
// ═══════════════════════════════════════════════════════════════════════════════════════

describe.each(PACKAGES_WITH_UI.map(p => [p.dir, p] as const))('P2 %s — affordances', (dir, pkg) => {
  it('every rendered affordance has an accessible name', async () => {
    await mountPane(pkg, 1)
    for (const el of affordances()) {
      expect(
        accessibleName(el),
        `${dir}: a ${el.tagName.toLowerCase()} renders with no accessible name — ${el.outerHTML.slice(0, 220)}`,
      ).not.toBe('')
    }
  })

  it('every rendered affordance is OPERABLE — activating it does something', async () => {
    // "Rendered" is not "reachable". A control the form paints, that a user can click, and
    // that changes nothing, is a promise the app does not keep — and it is invisible to
    // every test that drives the ACTION instead of the CONTROL, because the action works
    // fine when called with arguments the control never actually sends.
    const total = await affordanceCount(pkg)
    for (let i = 0; i < total; i++) {
      const m = await mountPane(pkg, 1)
      const el = affordances()[i]
      if (!el || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
        cleanup()
        __resetDeclarativeMountsForTests()
        continue
      }
      const name = accessibleName(el)
      const viewId = m.render.views[0].view_id
      const before = structuredClone(m.state(viewId))
      const launchesBefore = m.launches.length
      await activate(el)
      const after = structuredClone(m.state(viewId))
      const did = stateChanged(before, after) || m.launches.length > launchesBefore
      cleanup()
      __resetDeclarativeMountsForTests()
      expect(
        did,
        `${dir}: activating "${name}" changed NOTHING — not the view state, not the launch. ` +
          `An enabled control that does nothing is a defect, and one bound to a destructive ` +
          `action is a delete the user cannot perform.`,
      ).toBe(true)
    }
  })

  it('a DESTRUCTIVE affordance says so in its own name', async () => {
    // The failure this catches is not "unlabelled" — it is MIS-labelled: a control whose
    // name promises one thing and whose effect is another. A user cannot discover that
    // without losing the thing.
    const count = affordanceCount(pkg)
    for (let i = 0; i < (await count); i++) {
      const m = await mountPane(pkg, 1)
      const els = affordances()
      const el = els[i]
      if (!el) {
        cleanup()
        __resetDeclarativeMountsForTests()
        continue
      }
      const name = accessibleName(el)
      const viewId = m.render.views[0].view_id
      const before = structuredClone(m.state(viewId))
      await activate(el)
      const after = structuredClone(m.state(viewId))
      if (isDestructive(before, after)) {
        expect(
          DESTRUCTIVE_WORDS.test(name),
          `${dir}: activating "${name}" DESTROYED state (${JSON.stringify(before)} → ` +
            `${JSON.stringify(after)}) but its name promises nothing of the kind. A delete ` +
            `control must be discoverable as a delete control.`,
        ).toBe(true)
      }
      cleanup()
      __resetDeclarativeMountsForTests()
    }
  })

  it('a bound input control SHOWS an excerpt of that column’s values, and REPLACES it on a new choice', async () => {
    // P2 is "every affordance the form RENDERS is honest about what it does". A picker
    // that offers two columns by NAME is not honest about the choice it is asking for:
    // on a real dataset an identifier column and a label column render as two strings a
    // user cannot tell apart, and picking wrong is SILENT — the run matches its patterns
    // against identifiers, finds nothing, and reports zero rather than failing. The
    // control's own values are what make the choice legible, and this tier is where the
    // property is held shut for EVERY shipped view rather than for a hand-written spec.
    //
    // Two failure modes, both of which look completely normal on screen:
    //   · an excerpt drawn from a DIFFERENT column than the one bound;
    //   · the previous column's excerpt surviving a change of selection — a confident
    //     statement about column B made out of column A's values.
    // Both are assertions about PROVENANCE, so they are made against the provenance the
    // node carries, never against the text (which is exactly what a wrong excerpt looks
    // like too).
    const m = await mountPane(pkg, 1)
    let checked = 0

    for (const view of m.render.views) {
      for (const w of artifactRefs(view.view_spec)) {
        const base = testidOf(w)

        // The SOLE-candidate arm: an auto-selected column is still a column the user is
        // about to run against, and it is the arm where the choice was never visible at
        // all — so it needs the excerpt most.
        for (const summary of document.querySelectorAll<HTMLElement>(`[data-testid="${base}-summary"]`)) {
          const bound = summary.getAttribute('data-artifact-id')
          const row = bound ? m.rows.find(r => r.id === bound) : undefined
          if (!row || !previewableRow(row)) continue
          checked += 1
          expect(
            previewIn(summary)?.getAttribute('data-artifact-id'),
            `${dir}/${view.view_id}: "${w.id}" auto-selected ${bound} and shows no excerpt of ` +
              `its values — the arm where the user never saw the choice being made.`,
          ).toBe(bound)
        }

        // The PICKER arm: choose, then choose again.
        for (const select of document.querySelectorAll<HTMLElement>(`[data-testid="${base}-select"]`)) {
          if (!isSinglePicker(select)) continue
          const offered = (await pickerOptions(select))
            .map(v => m.rows.find(r => r.id === v))
            .filter((r): r is ArtifactRow => r !== undefined && previewableRow(r))
          if (offered.length < 2) continue
          checked += 1

          let previousId: string | undefined
          for (const row of offered.slice(0, 2)) {
            // HOLD the read before choosing, so the assertion below lands inside the
            // window where the previous column's values would still be on screen. Without
            // this the fake answers in a microtask and the window does not exist.
            m.preview.hold()
            await choosePicker(select, row.id)
            const inFlight = previewIn(select)
            if (previousId !== undefined) {
              // BOTH the stated provenance and the VALUES, because they can disagree and
              // the disagreement is the interesting case: a node whose `data-artifact-id`
              // is taken from the binding rather than from the excerpt says "column B" over
              // column A's values and reads as correct. The fake plane's values name their
              // own artifact precisely so the text can be checked too.
              const provenance = inFlight?.getAttribute('data-artifact-id')
              const shown = inFlight?.textContent ?? ''
              expect(
                provenance === previousId || shown.includes(previousId),
                `${dir}/${view.view_id}: "${w.id}" moved to ${row.id} while its excerpt was ` +
                  `still being read, and is still showing ${previousId}'s values ` +
                  `(${JSON.stringify(shown)}) — a confident statement about one column made ` +
                  `out of another's, which reads as completely normal.`,
              ).toBe(false)
            }

            await m.preview.release()
            const settled = previewIn(select)
            expect(
              settled?.getAttribute('data-artifact-id'),
              `${dir}/${view.view_id}: "${w.id}" is bound to ${row.id} but its excerpt is ` +
                `drawn from ${settled?.getAttribute('data-artifact-id') ?? 'nothing'}.`,
            ).toBe(row.id)
            previousId = row.id
          }
        }
      }
    }

    // NON-VACUITY. A package whose views declare a column-choosing control must have had
    // at least one checked; without this the whole assertion passes the moment the testid
    // convention changes and every query returns nothing.
    const declaresColumnChoice = (Object.values(pkg.pkg.views) as ViewSpec[]).some(v =>
      artifactRefs(v).some(w => isAxisScopedSource(w.source) && typeof w.source.values === 'string'),
    )
    if (declaresColumnChoice) {
      expect(
        checked,
        `${dir}: declares a control that chooses a COLUMN by name, but no rendered control ` +
          `was found to check — the assertion looked at nothing.`,
      ).toBeGreaterThan(0)
    }
  })

  it('the affordance that LAUNCHES the run sits in the form footer — and only it does', async () => {
    // The STRUCTURAL half of the footer, on every SHIPPED view (the browser tier measures the
    // LOOK — a muted bar, the action at its end — on one fixture, because jsdom performs no
    // layout and compiles no CSS, so a class-string assertion here would pass whatever the class
    // means).
    //
    // It belongs in this tier because the property is not "a footer exists" but "the RIGHT
    // control is in it", and that is derived by the engine from what the bound ACTION does
    // (`core/form/validity.ts::submitActionIds`). A view therefore cannot opt in, cannot forget,
    // and cannot claim it for a control that starts nothing — and a regression to a per-view
    // declared footer surfaces as a control on the WRONG side of this assertion rather than as a
    // missing one.
    await mountPane(pkg, 1)
    // The run-dispatching action ids, read off the shipped declaration — the same fact the
    // engine reads, never the rendered result agreeing with itself.
    const submitIds = new Set(
      (Object.values(pkg.pkg.views) as ViewSpec[]).flatMap(v =>
        (v.actions ?? [])
          .filter(a => (a.body ?? []).some(op => op && typeof op === 'object' && 'run_processor' in op))
          .map(a => a.id),
      ),
    )
    const buttons: Array<{ id?: string; onClick?: string }> = []
    const visit = (ws: WidgetSpec[] | undefined): void => {
      for (const w of ws ?? []) {
        if (w.kind === 'group') visit((w as { children?: WidgetSpec[] }).children)
        else if (w.kind === 'button') buttons.push(w as { id?: string; onClick?: string })
      }
    }
    for (const v of Object.values(pkg.pkg.views) as ViewSpec[]) visit(v.widgets)

    let submitters = 0
    for (const w of buttons) {
      const el = document.querySelector<HTMLElement>(`[data-testid="widget-${w.id}"]`)
      if (!el) continue // gated off by a `when` — not rendered, so there is nothing to place
      const inFooter = el.closest('[data-slot="run-footer"]') !== null
      const submits = typeof w.onClick === 'string' && submitIds.has(w.onClick)
      if (submits) submitters += 1
      expect(
        inFooter,
        `${dir}: "${w.id}" ${
          submits
            ? 'DISPATCHES a run but is NOT in the form footer'
            : 'is IN the form footer but dispatches no run'
        } — the footer belongs to the control that starts the work, and to no other.`,
      ).toBe(submits)
    }
    // NON-VACUITY: a package whose Run affordance stopped rendering would otherwise pass this
    // having placed nothing at all.
    expect(
      submitters,
      `${dir}: no rendered control dispatches a run, so this asserted nothing.`,
    ).toBeGreaterThan(0)
  })

  it('every declared MUTATING action has a way in', async () => {
    // An action that exists only via the interpreter, with no rendered affordance naming
    // it, is a capability the user cannot reach — the mirror image of a control that does
    // something its label does not say.
    const m = await mountPane(pkg, 2)
    for (const view of m.render.views) {
      const spec = view.view_spec
      const reachable = new Set<string>()
      const collect = (ws: WidgetSpec[] | undefined): void => {
        for (const w of ws ?? []) {
          if (w.kind === 'group') collect((w as { children?: WidgetSpec[] }).children)
          const anyW = w as unknown as Record<string, unknown>
          for (const key of ['onChange', 'onClick', 'onCommit']) {
            if (typeof anyW[key] === 'string') reachable.add(anyW[key] as string)
          }
          const sel = (w as TableWidget).selection
          if (sel?.onChange) reachable.add(sel.onChange)
          // Per-row primitives, enumerated through the TWO shared readers (`tableRowParts`
          // then `tableRowPrimitives`) rather than by hand, over the SAME
          // dispatch keys a widget carries. This used to hand-list `onChange`/`onClick`, which
          // is the enumeration the validator retired for exactly this reason: the next
          // primitive to ship — one that commits on `onCommit` — was invisible to it, so its
          // action read as unreachable while being perfectly reachable.
          //
          // The outer enumeration is shared for the identical reason, one level up: the same
          // control was later moved out of a column and UNDER the row, and a collector still
          // spelling `.columns` reported its perfectly-reachable action unreachable again.
          for (const { decl: rowPart } of tableRowParts(w)) {
            for (const { decl } of tableRowPrimitives(rowPart)) {
              for (const key of ['onChange', 'onClick', 'onCommit', 'onSelect']) {
                const target = (decl as Record<string, unknown>)[key]
                if (typeof target === 'string') reachable.add(target)
              }
            }
          }
        }
      }
      collect(spec.widgets)
      // A canvas series' `close:` is a real, rendered affordance too.
      const canvasSeries = (spec.canvas as { series?: unknown[] } | undefined)?.series ?? []
      for (const s of canvasSeries) {
        const close = (s as { close?: { action?: string } }).close
        if (close?.action) reachable.add(close.action)
      }
      // …as is any action a declared body calls.
      for (const a of spec.actions ?? []) {
        for (const op of a.body ?? []) {
          const call = (op as { call_action?: { id?: string } }).call_action
          if (call?.id) reachable.add(call.id)
        }
      }
      for (const a of spec.actions ?? []) {
        if (!a.stateful && !a.mutating) continue
        expect(
          reachable.has(a.id),
          `${dir}/${view.view_id}: action "${a.id}" mutates state but NO rendered affordance ` +
            `dispatches it. It is reachable only from the interpreter.`,
        ).toBe(true)
      }
    }
  })
})

/** How many affordances this pane renders (one mount, discarded). */
async function affordanceCount(pkg: ShippedPackage): Promise<number> {
  await mountPane(pkg, 1)
  const n = affordances().length
  cleanup()
  __resetDeclarativeMountsForTests()
  return n
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// P3 — a DEPENDENT control resolves against the catalog the run is launched from
// ═══════════════════════════════════════════════════════════════════════════════════════

describe.each(PACKAGES_WITH_UI.map(p => [p.dir, p] as const))('P3 %s — dependent controls', (dir, pkg) => {
  it('an axis-scoped control OFFERS something once its anchor is chosen', async () => {
    const m = await mountPane(pkg, 1)
    for (const view of m.render.views) {
      const spec = view.view_spec
      const deps = artifactRefs(spec).filter(w => isAxisScopedSource(w.source))
      if (deps.length === 0) continue
      const state = m.state(view.view_id)
      for (const w of deps) {
        const src = w.source
        if (!isAxisScopedSource(src)) continue
        // Only meaningful once the anchor is bound — an unanchored dependent control is
        // CORRECTLY empty, and asserting on it would be asserting the wrong thing. A
        // REPEATED picker anchors on its loop variable, so the `for_each` has to be
        // expanded exactly as `WidgetHost` expands it or the anchor never resolves and the
        // assertion silently skips (the shape of vacuous pass this tier exists to avoid).
        const baseScope = { state, derived: {}, const: spec.const ?? {}, params: {}, data: {} }
        const anchor = expandForEach(w as { for_each?: string }, baseScope)
          .map(e => anchorId(src.of, e.scope))
          .find(Boolean)
        if (!anchor) continue
        const empty = document.querySelectorAll(`[data-testid^="${testidOf(w)}"][data-testid$="-empty"]`)
        expect(
          empty.length,
          `${dir}/${view.view_id}: "${w.id}" is anchored on ${anchor} but offers NOTHING. ` +
            `Its candidates come from the project catalog the app fetches — if that read cannot ` +
            `carry the provenance the resolver scopes by, this control is dead in every project.`,
        ).toBe(0)
      }
    }
  })

  it('offers EVERY sibling its declared `values:` term admits — no silently narrower set', async () => {
    // The defect this catches is a picker that technically resolves — one candidate, no
    // error, "Only one match — selected automatically" — while the column the user would
    // actually have picked was filtered out by the source's own `values:` term.
    //
    // It is the worst shape available to this capability: the auto-selection is silent, the
    // chosen column is the axis's IDENTIFIER rather than its labels, and every downstream
    // pattern then matches nothing and reports zero rather than failing. A control built to
    // remove a silent wrong answer produced one.
    const m = await mountPane(pkg, 1)
    for (const view of m.render.views) {
      const spec = view.view_spec
      const state = m.state(view.view_id)
      for (const w of artifactRefs(spec).filter(x => isAxisScopedSource(x.source))) {
        const base = { state, derived: {}, const: spec.const ?? {}, params: {}, data: {} }
        for (const entry of expandForEach(w as { for_each?: string }, base)) {
          if (!anchorId((w.source as { of?: string }).of, entry.scope)) continue
          const src = w.source as { axis: string; values?: string; of?: string }
          const cands = resolveArtifactRefSource(m.rows, w.source, entry.scope, { lattice: workbenchLattice })
          const anchor = anchorId(src.of, entry.scope)
          // What the term ADMITS, computed from the rows the pane fetched — the honest
          // oracle. A control may legitimately be narrow (asking for one encoding), so the
          // assertion is not "offers many"; it is "offers exactly what it asked for".
          const admitted = valueKindsFor(src.values ?? 'text')
          const shouldOffer = m.rows.filter(
            r =>
              r.id !== anchor &&
              r.source_dataset_id != null &&
              declaredAxes(r.structure).includes(src.axis) &&
              declaredValueKinds(r.structure).some(k => admitted.includes(k)),
          )
          expect(
            cands.map(c => c.id).sort(),
            `${dir}/${view.view_id}: "${w.id}" declares values:"${src.values}" (admitting ` +
              `${JSON.stringify(admitted)}) and the axis carries ${shouldOffer.length} matching ` +
              `column(s), but the control resolved ${cands.length}. A control that drops a ` +
              `candidate it asked for gives the user no way to reach it — and when the survivor ` +
              `is the axis INDEX, the auto-selection silently binds the identifier column.`,
          ).toEqual(shouldOffer.map(r => r.id).sort())
          // A term that admits more than the index encoding must actually reach past it —
          // the shape the reported defect took (one candidate, auto-selected, wrong column).
          if (admitted.length > 1) {
            expect(
              cands.some(c => !axisIndexIds.has(c.id)),
              `${dir}/${view.view_id}: "${w.id}" asks for text-valued columns however encoded, ` +
                `yet resolves only the axis index.`,
            ).toBe(true)
          }
        }
      }
    }
  })

  it('an axis_columns data slice resolves rows off the SAME catalog the app fetched', async () => {
    const m = await mountPane(pkg, 1)
    for (const view of m.render.views) {
      const spec = view.view_spec
      const state = m.state(view.view_id)
      for (const [key, decl] of Object.entries(spec.data ?? {})) {
        const d = decl as { source?: string; args?: { of?: string; axis?: string } }
        if (d?.source !== 'axis_columns') continue
        const anchor = anchorId(d.args?.of, { state, derived: {}, const: {}, params: {}, data: {} })
        if (!anchor) continue
        expect(
          axisColumnRows(m.rows, anchor, d.args?.axis, { lattice: workbenchLattice }).length,
          `${dir}/${view.view_id}: slice "${key}" resolves ZERO column artifacts off the ` +
            `catalog the app fetched, so every control it feeds renders with no options.`,
        ).toBeGreaterThan(0)
      }
    }
  })
})

// ── WHO PRODUCED A COLUMN survives the wire → row mapping ──────────────────────────────
//
// The same seam, and the same failure mode, as `source_dataset_id`: a field the endpoint
// carries and the mapper drops is invisible to every layer above, because every fixture in
// the tree hand-writes its `ArtifactRow`s and can therefore write a field the wire never
// delivered. `siblingsOnAxis` returned NOTHING in every real project for exactly that
// reason, and nothing went red.
//
// So this asserts the mapping through the SAME function production uses, from fixtures
// TYPED AS THE WIRE TYPES — which is what makes it un-fakeable in both directions: a
// consumer field the endpoint does not declare will not compile here, and a mapper that
// stops copying one fails here rather than in whatever surface silently loses its answer.
describe('the wire→row seam carries WHO PRODUCED an artifact', () => {
  const wire = wireArtifact({ datatype: 'demo/column', structure: columnStructure('rows', 'numeric') })

  it('the LIST row carries the producing analysis; the OVERVIEW row cannot and reads as null', () => {
    // `generator_id` is a DERIVED field of the list endpoint (`ListedArtifact`), exactly like
    // the source dataset beside it. TypeScript is the assertion for the second half: the
    // overview returns a bare `Artifact`, so a fixture cannot even claim a producer there.
    const listed: ListedArtifact = {
      ...wire,
      source_dataset_ids: [],
      source_dataset_names: [],
      generator_id: 'pkg.thing',
    }
    expect(
      toArtifactRow(listed).generator_id,
      'the producing analysis is dropped at the wire→row boundary, so no consumer can tell ' +
        'its own previous output from another producer\'s',
    ).toBe('pkg.thing')
    expect(
      toArtifactRow(wire).generator_id,
      'the project OVERVIEW carries no provenance — a consumer that needs a producer must ' +
        'resolve against the LIST, and reading the overview must say "unknown", not guess',
    ).toBeNull()
  })

  it('an unattributed list row maps to null, never to a producer-shaped empty string', () => {
    // `''` would be a producer id that matches an exclusion set spelled the same way. The
    // server already refuses to emit one (a blank `generator_id` is read as absent there);
    // this pins the client half of the same rule.
    const listed: ListedArtifact = { ...wire, source_dataset_ids: [], source_dataset_names: [] }
    expect(toArtifactRow(listed).generator_id).toBeNull()
  })
})


// ── EVERY SOURCE DATASET survives the wire → row mapping ───────────────────────────────
//
// Same seam, same failure mode, one field over. An artifact that INTEGRATED two datasets
// carries both on the wire and NEITHER in the singular pair (the endpoint's exactly-one
// rule). So a mapper that copies only the singular fields turns a two-source row into a
// row with no lineage at all — and `siblingsOnAxis`, which scopes by exactly this, would
// resolve to NOTHING for every integrated anchor in every real project, silently, with
// every hand-written `ArtifactRow` fixture in the tree still passing.
describe('the wire→row seam carries EVERY source dataset', () => {
  const wire = wireArtifact({ datatype: 'demo/column', structure: columnStructure('rows', 'numeric') })

  it('a two-source list row keeps both sources, and reports no single one', () => {
    const listed: ListedArtifact = {
      ...wire,
      source_dataset_ids: [DATASET_A, 'ds-second'],
      source_dataset_names: ['Dataset 1', 'Dataset 2'],
    }
    const row = toArtifactRow(listed)
    expect(
      row.source_dataset_ids,
      'the SET is the only field that can express two sources; dropping it at this boundary ' +
        'leaves an integrated artifact scoped to nothing (or, worse, to one of its sources)',
    ).toEqual([DATASET_A, 'ds-second'])
    expect(row.source_dataset_names).toEqual(['Dataset 1', 'Dataset 2'])
    expect(row.source_dataset_id, 'the endpoint names no single source for an integration').toBeNull()
  })

  it('a single-source list row still maps through unchanged', () => {
    // The negative control: the fix must not have been "always report the set and nothing else".
    const listed: ListedArtifact = {
      ...wire,
      source_dataset_ids: [DATASET_A],
      source_dataset_names: ['Dataset 1'],
      source_dataset_id: DATASET_A,
      source_dataset_name: 'Dataset 1',
    }
    const row = toArtifactRow(listed)
    expect(row.source_dataset_id).toBe(DATASET_A)
    expect(row.source_dataset_ids).toEqual([DATASET_A])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// The LAUNCH test's two branches, kept honest against each other
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// The launch test can end two ways: the completed form LAUNCHED, or it was still gated on a
// declared `checks:` relation and said so. The second is a real state and must be assertable,
// but it is also the shape a weakening takes — every package sliding into "disabled, with a
// sentence" would leave the tier certifying nothing about a launch while every case passed.
//
// These run last, so both sets are populated. Declared here rather than inside the per-package
// blocks because the claim is about the CORPUS, which no single package can see.
describe('the launch test still actually launches something', () => {
  it('at least one shipped package launched a run from a completed form', () => {
    expect(
      [...launchedForReal],
      'every shipped form ended the launch test disabled-but-explained. The branch that ' +
        'tolerates a measurement-gated form has become the path every package takes, so the ' +
        'tier no longer asserts that ANY form can be launched.',
    ).not.toEqual([])
  })

  it('the measurement-gated branch is the minority, and its members are named', () => {
    expect(
      gatedOnADeclaredCheck.size,
      `packages gated on a declared check: [${[...gatedOnADeclaredCheck].join(', ')}]; ` +
        `packages that launched: [${[...launchedForReal].join(', ')}]. A tree where most ` +
        'forms cannot be driven to a launch is a tree where this tier has stopped covering ' +
        'the thing it is named for.',
    ).toBeLessThanOrEqual(launchedForReal.size)
  })
})

// Keep React imported for the JSX factory under the classic runtime, if configured so.
void React
