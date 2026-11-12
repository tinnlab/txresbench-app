// Gallery STORIES for the declarative-engine fixtures (declarative-rendering-hardening
// Slice 3, F4 — ITEM-12).
//
// Each story mounts the **real** `DeclarativeRegion` inside the **real**
// `WorkbenchProvider`, bound to a seeded `makeFakeHost` — the same idiom the rest of
// `modules/workbench/gallery.tsx` uses. Nothing is stubbed above the host: the resolver, the
// per-instance store, the widget host, the error boundary, `RegionBody`/`WidgetField` and
// every renderer are the production code path. That is what makes these surfaces a real
// gate rather than a picture of one.
//
// The ONLY thing that varies between the loaded / empty / error surfaces is what the HOST
// does — which is exactly the distinction F3 says a user must be able to see:
//   • `data`   → the region is handed resolved slices (the documented gallery/test override)
//   • `empty`  → `listArtifacts` returns [] → the resolver classifies `empty`
//   • `reject` → `listArtifacts` throws     → the resolver classifies `error`
//
// Widths: a fixture ships one frame per VARIANT it declares, because a declarative surface that
// only works at one width is a defect and, before Slice 1, the wide case is exactly where the
// form stretched edge-to-edge. Most fixtures take the default pair (a NARROW ~390px frame and a
// WIDE one); the criteria-table fixture takes the SIDE PANE's own band instead, so its frames are
// literally the widths a user can drag a dock pane to. The frames carry stable test ids so the
// Layer-A spec can MEASURE the invariants on them (padding, button ratio, overflow).

import { lazy, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react'
import type { Job } from '@/api-client/types'
import { createWorkbenchApi, type SectionContribution, type WorkbenchAPI } from '@/modules/workbench/core'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { makeFakeHost } from '../host/createHost'
import { DATA_CAPABILITY_ID, type DataHost } from '@/modules/workbench/extensions/data'
import { WorkbenchProvider } from '../../core/shell/WorkbenchContext'
import { DeclarativeStack } from '@/modules/workbench/core/render/DeclarativeRegion'
import { SectionStack } from '@/modules/workbench/core/shell/SectionStack'
import { peekStore } from '@/modules/workbench/core/render/declarativeMount'
import { paneInsetStyle } from '@/modules/workbench/core/shell/dock/paneModel'
import { type DeclarativeRenderSpec } from '@/modules/workbench/core/runtime/seam'
import { installBuiltinWidgets } from '@/modules/workbench/extensions'
import {
  DECLARATIVE_FIXTURES,
  FIXTURE_FRAME,
  FRAME_HEIGHT_PX,
  VARIANT_HEIGHT_PX,
  VARIANT_WIDTH_PX,
  fixtureSlug,
  variantsOf,
  type DeclarativeFixture,
  type FixtureVariant,
} from './fixtureSpecs'

const GALLERY_EXTENSION_ID = 'txr.workbench.declarative-gallery'

/** Frame sizing per variant. The wide frame is deliberately far wider than `RegionBody`'s
 *  `max-w-lg` (512px) cap, so the Layer-A spec can prove the cap actually holds — that is
 *  the Slice-1 promise ("a wide dock no longer stretches the form"). `max-w-full` keeps the
 *  gallery page itself from scrolling horizontally.
 *
 *  A fixed-width variant carries its width as an inline STYLE rather than a `w-[…]` class: the
 *  dock frames read their width from the store that clamps a real pane (`VARIANT_WIDTH_PX`), and
 *  a Tailwind arbitrary value has to be a literal in the source for the JIT to emit it — so a
 *  class would silently produce no rule at all and the frame would size to its content, which is
 *  the exact defect these surfaces exist to catch. */
const VARIANT_CLASS: Record<FixtureVariant, string> = {
  narrow: 'max-w-full',
  wide: 'w-full max-w-[900px]',
  'dock-min': 'max-w-full',
  'dock-default': 'max-w-full',
  short: 'max-w-full',
}

/** Build the `DeclarativeRenderSpec` payload `ViewHost` hands the pane in production.
 *
 *  A fixture is ONE view file, so its stack has one entry; the pane's `analysis_id` is the
 *  fixture's own id so the frame testid stays `declarative-region-body-gallery-<slug>` (what
 *  the visual + gallery-e2e specs measure padding / width-cap / overflow on). */
function renderSpecFor(spec: ViewSpec, viewId: string): DeclarativeRenderSpec {
  return { declarative: true, analysis_id: viewId, views: [{ view_spec: spec, view_id: viewId }] }
}

/** The fake host each fixture drives, differing ONLY in its artifact-list behavior. */
function hostFor(fixture: DeclarativeFixture, projectId: string) {
  const base = makeFakeHost({ projectId })
  if (fixture.host === 'reject') {
    // Override ONLY the `data` capability's injected plane (the broker resolves the
    // capability over whatever plane the host carries under that id).
    const dataPlane = base.planes?.[DATA_CAPABILITY_ID] as DataHost
    return {
      ...base,
      planes: {
        ...base.planes,
        [DATA_CAPABILITY_ID]: {
          ...dataPlane,
          listArtifacts: async () => {
            throw new Error('artifact service unavailable (503)')
          },
        } satisfies DataHost,
      },
    }
  }
  // `empty` and `data` both use the stock fake host (no artifacts). `data` never reaches the
  // resolver at all — it is handed its slices directly, below.
  return base
}

/**
 * Seed a pane's run band with `n` finished-then-running runs, and REGISTER the analysis they
 * belong to.
 *
 * Both halves are needed and neither is decoration. `runsOfAnalysis` attributes a job to an
 * analysis through the registry (`resolveJobAnalysisId`) — a job stamped with an id nothing has
 * registered belongs to no analysis and is correctly dropped — so a story that only handed over
 * rows would render an EMPTY band and quietly measure nothing. In the app the analysis is always
 * registered; here it has to be said out loud.
 *
 * The newest run is left `running`, because that is the state a user is in one second after
 * pressing Run — which is the moment this surface exists to make legible.
 */
function seedRuns(api: WorkbenchAPI, analysisId: string, n: number): Job[] {
  if (n <= 0) return []
  api.registry.analyses.register({
    id: analysisId,
    extensionId: GALLERY_EXTENSION_ID,
    apiVersion: '1.0.0',
    title: 'Fixture analysis',
    category: 'fixture',
    appliesTo: [],
    produces: [],
    run: { kind: 'builtin', fn: 'noop' },
    // Not offered in the launcher: this exists so the run band can attribute its rows, not as a
    // thing a gallery reader could start.
    launchable: false,
  })
  // A FIXED epoch, not `Date.now()`: the row renders the timestamp, and a clock-derived one would
  // make the surface differ between two renders of the same fixture.
  const base = Date.parse('2026-01-02T03:04:05Z')
  return Array.from({ length: n }, (_, i) => ({
    id: `fixture-run-${i + 1}`,
    name: 'Fixture analysis',
    job_type: 'processor',
    owner_id: 'fixture-owner',
    // The WIRE key (`analysis_id`) — the one `resolveJobAnalysisId` reads and the launcher
    // writes. Stamping the camelCase spelling here made the band render off the NAME fallback,
    // so the gallery agreed with a fixture rather than with a real launch.
    params: { analysis_id: analysisId },
    priority_class: 'normal',
    resource_class: 'cpu-sandbox',
    status: i === n - 1 ? 'running' : 'completed',
    created_at: new Date(base + i * 60_000).toISOString(),
  }))
}

function fixtureFrame(
  fixture: DeclarativeFixture,
  variant: FixtureVariant,
): LazyExoticComponent<ComponentType> {
  const slug = fixtureSlug(fixture.key, variant)
  return lazy(async () => {
    // Idempotent; the production mount path calls it too. Doing it here means a story
    // rendered in isolation (a direct `?surface=` load) never races the module bootstrap.
    installBuiltinWidgets()
    const projectId = `decl-gallery-${slug}`
    const api = createWorkbenchApi(hostFor(fixture, projectId), GALLERY_EXTENSION_ID)
    const spec = fixture.spec()
    const viewId = `gallery-${slug}`
    const render = renderSpecFor(spec, viewId)
    // The `data` fixtures are handed resolved slices via `DeclarativeRegion`'s documented
    // gallery/test override, so they exercise the READY path without a network read; the
    // `empty`/`reject` fixtures deliberately go through the REAL resolver.
    const data = fixture.host === 'data' ? { obs: FIXTURE_FRAME } : undefined
    // The pane's `analysis_id` IS `viewId` here (see `renderSpecFor`), so that is what the
    // seeded runs are stamped with and what gets registered.
    const runs = seedRuns(api, viewId, fixture.runs ?? 0)

    const Frame: ComponentType = () => (
      <div
        // The height is a STYLE for the same reason the width is: a Tailwind arbitrary value has
        // to be a literal in the source for the JIT to emit it, so `h-[${n}px]` would produce no
        // rule at all and the frame would size to its content — which is precisely the defect
        // these surfaces exist to catch.
        // `paneInsetStyle('view')` — the frame IS the pane's CONTENT REGION here. A declarative
        // surface renders inside a `view` pane, and since the pane's content inset moved to the
        // shell (`RegionShell::PaneBody`) a fixture frame WITHOUT it would measure a form with no
        // inset at all, i.e. this harness would stop modelling the surface it exists to model.
        // Taken from the production helper rather than restated as `p-2`, so the two cannot
        // diverge — and the helper also publishes `--pane-inset`, which is what the form's own
        // scroll track bleeds by (`PaneScroll`) to put its bar at the pane's edge. Restating the
        // padding as a class here would model the inset but not the bleed, and the fixture would
        // measure a scrollbar in a place production never draws one.
        className={`flex flex-col overflow-hidden rounded-md border border-border ${VARIANT_CLASS[variant]}`}
        style={{ ...paneInsetStyle('view'), width: VARIANT_WIDTH_PX[variant], height: VARIANT_HEIGHT_PX[variant] }}
        data-testid={`declarative-fixture-frame-${slug}`}
        data-declarative-fixture={fixture.key}
        data-declarative-variant={variant}
      >
        <WorkbenchProvider api={api} projectId={projectId} viewId={viewId} canEdit>
          <DeclarativeStack render={render} data={data} runs={runs.length ? runs : undefined} />
        </WorkbenchProvider>
      </div>
    )
    return { default: Frame }
  })
}

export interface DeclarativeFixtureSurface {
  slug: string
  title: string
  note: string
  path: string
  initialPath: string
  component: LazyExoticComponent<ComponentType>
}

/**
 * The seeded gallery surfaces (each fixture × the variants it declares) `modules/workbench/gallery.tsx`
 * spreads into its `seeded:` array. Generated from `DECLARATIVE_FIXTURES` so a fixture can
 * never be present in the registry and silently missing from the gallery.
 */
export const declarativeFixtureSurfaces: DeclarativeFixtureSurface[] = DECLARATIVE_FIXTURES.flatMap(
  fixture =>
    variantsOf(fixture).map(variant => {
      const slug = fixtureSlug(fixture.key, variant)
      const px = VARIANT_WIDTH_PX[variant]
      const hpx = VARIANT_HEIGHT_PX[variant]
      // The height is named only when it is the thing that differs — otherwise two variants of
      // one fixture would read as the same frame in the gallery index.
      const size =
        hpx === FRAME_HEIGHT_PX ? (px == null ? 'wide' : `${px}px`) : `${px ?? 'wide'}×${hpx}px`
      return {
        slug,
        title: `${fixture.title} (${size})`,
        note: fixture.note,
        path: `/dev/${slug}`,
        initialPath: `/dev/${slug}`,
        component: fixtureFrame(fixture, variant),
      }
    }),
)

// ── § Items collapse→reopen (entry_list) — the BUG 1 repro/guard surface ──────────────────
//
// Unlike the fixtures above (which render one view through `DeclarativeStack`), this mounts the
// REAL `SectionStack` — the exact production path a shipped collapsed viz § Items
// renders through: `SectionStack` → `PaneScroll` → `SectionFrame` (whose `keepMounted` accordion
// keeps a collapsed panel mounted under `display:none`) → `DeclarativeRegion` → the `entry_list`
// widget. The section is registered `collapsed: true`, exactly like that shipped § Items, and the offer
// resolves ASYNCHRONOUSLY after mount (as the real host does), so the virtualiser's `count` goes
// 0 → N while the panel is still hidden. Expanding must render the list rather than crash the
// widget — the invariant `tests/gallery-e2e/entry-list-collapse.spec.ts` guards.

const ENTRY_LIST_COLLAPSE_SLUG = 'entry-list-collapse-repro'
const ENTRY_LIST_COLLAPSE_EXT = 'txr.workbench.entry-list-collapse-gallery'
const ENTRY_LIST_COLLAPSE_PANE = 'visualize'
const ENTRY_LIST_COLLAPSE_VIEW = 'gallery-entry-list-collapse'

/** A non-trivial offer — enough entries that the virtualiser windows and its measured height is
 *  well past a screenful, so the collapsed-panel re-measure has real geometry to get wrong. */
const ENTRY_LIST_COLLAPSE_ENTRIES = Array.from({ length: 60 }, (_, i) => ({
  key: `e-${i}`,
  label: `Item ${i}`,
  title: `Item ${i}`,
  // Two annotations per entry, so the row's SECONDARY-annotation slot (`secondAnnotation`) is
  // exercised — the shape a real offer has (`values[0]` is the displayed name, `values[1]` the
  // "other name" shown inline). `e-2` carries a LONG free-text annotation value (a displayable
  // `metadata-column` is not always a short id), which is the regression case for
  // `tests/gallery-e2e/entry-list-second-annotation-overflow.spec.ts`: a `shrink-0` secondary
  // used to collapse the entry NAME to zero width and shove the row's "Plot ▶" off-screen.
  values: [
    { title: 'Name', value: `Item ${i}` },
    i === 2
      ? {
          title: 'Note',
          value:
            'A deliberately long free-text annotation value, wide enough to prove the secondary column truncates within its share instead of overflowing the row',
        }
      : { title: 'Ref', value: `REF00000${100000 + i}` },
  ],
}))

function entryListCollapseSpec(): ViewSpec {
  return {
    id: 'fixture/entry-list-collapse',
    title: 'Items',
    permission: 'projects::use',
    widgets: [
      {
        // The widget id IS `entries`, so a throw logs `[declarative] widget render failed`,
        // `entries`, <err>` and the fallback reads `"entries" (entry_list) failed to render`.
        id: 'entries',
        kind: 'entry_list',
        label: 'Items',
        // The offer arrives via `$data` — the way a shipped § Items gets its entries
        // (resolved by the host AFTER mount), so `count` transitions 0 → 60 while collapsed.
        entries: '$data.entries',
        browsable: true,
        action: { label: 'Plot', onClick: 'fx.plot' },
      },
    ],
    actions: [{ id: 'fx.plot', params: {}, body: [] }],
  } as unknown as ViewSpec
}

function EntryListCollapseFrameInner(): ComponentType {
  return function EntryListCollapseFrame() {
    // Idempotent; the production mount path calls it too. Guarantees `entry_list` is registered
    // even on a direct `?surface=` load that never races the module bootstrap.
    installBuiltinWidgets()

    const [state] = useState(() => {
      const projectId = 'entry-list-collapse-repro'
      const api = createWorkbenchApi(makeFakeHost({ projectId }), ENTRY_LIST_COLLAPSE_EXT)
      const section: SectionContribution = {
        id: 'demo.viz.entries.section',
        extensionId: ENTRY_LIST_COLLAPSE_EXT,
        apiVersion: '1.0.0',
        title: 'Items',
        pane: ENTRY_LIST_COLLAPSE_PANE,
        collapsed: true,
        appliesTo: [],
        views: [{ view_spec: entryListCollapseSpec(), view_id: ENTRY_LIST_COLLAPSE_VIEW }],
      }
      api.registry.sections.register(section)
      return { projectId, api }
    })

    // Land the offer AFTER mount, while the section is still collapsed — the async arrival the
    // real host performs. `setData` bumps the store revision, so `count` goes 0 → 60 under
    // `display:none`. A short poll because the store is created by the retain effect a tick
    // after this component's first commit.
    useEffect(() => {
      let tries = 0
      const iv = setInterval(() => {
        const s = peekStore(ENTRY_LIST_COLLAPSE_VIEW)
        if (s) {
          s.setData({ entries: ENTRY_LIST_COLLAPSE_ENTRIES }, 'ready')
          clearInterval(iv)
        } else if (++tries > 40) {
          clearInterval(iv)
        }
      }, 20)
      return () => clearInterval(iv)
    }, [])

    return (
      <div
        className="flex flex-col overflow-hidden rounded-md border border-border"
        style={{ ...paneInsetStyle('view'), width: 420, height: 640 }}
        data-testid="entry-list-collapse-frame"
      >
        <WorkbenchProvider
          api={state.api}
          projectId={state.projectId}
          viewId={ENTRY_LIST_COLLAPSE_VIEW}
          canEdit
        >
          <SectionStack pane={ENTRY_LIST_COLLAPSE_PANE} />
        </WorkbenchProvider>
      </div>
    )
  }
}

/** The seeded surface `modules/workbench/gallery.tsx` spreads alongside the fixtures. */
export const entryListCollapseSurface: DeclarativeFixtureSurface = {
  slug: ENTRY_LIST_COLLAPSE_SLUG,
  title: 'Workbench — § Items collapse→reopen (entry_list)',
  note: 'A real SectionStack (keepMounted accordion) wrapping the entry_list widget, starting collapsed like a shipped § Items, with the offer resolving async after mount. Expanding must not crash the widget (BUG 1 guard).',
  path: `/dev/${ENTRY_LIST_COLLAPSE_SLUG}`,
  initialPath: `/dev/${ENTRY_LIST_COLLAPSE_SLUG}`,
  component: lazy(async () => ({ default: EntryListCollapseFrameInner() })),
}
