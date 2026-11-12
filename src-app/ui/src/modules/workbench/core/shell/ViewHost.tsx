// ViewHost (ITEM-7 / ITEM-60) — render ONE contributed `ViewContribution` into a dock,
// dispatching the `render` union through the pure `selectRenderStrategy` classifier
// (`renderStrategies.ts`) over a FIXED set of render kinds:
//   component → a built-in React panel (render directly)
//   named     → a named ref → resolve via the built-in component map; else a note
//   iframe    → DEFERRED (sandboxed code-view, §6) → placeholder
//   spec      → a declarative view spec → minimal spec note
// The render KINDS are closed (a new low-level mechanism edits this switch); the OPEN seam
// is NAMED views — an extension ships `render: { component: '<id>' }` and registers the
// component via `registerViewComponent`, so new panels plug in without a shell edit.
// A params FORM / artifact TABLE is NOT a ViewContribution.render variant — those are
// composed by the bottom dock from `AnalysisContribution.params` + the host `ArtifactPanel`
// (ITEM-35 deleted the `resultRenderers` registry that used to sit in that sentence).
//
// `chrome` (default true) renders the quiet header; `PlacedArea` passes `chrome={false}`
// so a tabbed / hero region doesn't double the title the pane-frame / tab already shows.

import type { ComponentType } from 'react'
import type { ViewContribution } from '@/modules/workbench/core'
import { Empty } from '@txresbench/kit'
import { selectRenderStrategy } from './renderStrategies'
import { isDeclarativeRenderSpec } from '@/modules/workbench/core/runtime/seam'
import { DeclarativeStack } from '@/modules/workbench/core/render/DeclarativeRegion'
import { PaneScroll } from '@/modules/workbench/core/shell/dock/paneModel'

/** Built-in named-component resolver. Built-ins that ship a React panel register it here
 *  (keyed by the string used in `render: { component: '<id>' }`). The lazy-activation path
 *  for external extensions is deferred (P5 ITEM-33). */
const BUILTIN_COMPONENTS: Record<string, ComponentType<Record<string, never>>> = {}

export function registerViewComponent(id: string, component: ComponentType<Record<string, never>>): void {
  BUILTIN_COMPONENTS[id] = component
}

function ViewBody({ view }: { view: ViewContribution }) {
  const render = view.render
  switch (selectRenderStrategy(render)) {
    case 'component': {
      // Direct built-in component (the escape hatch for interactive tools, §4.4).
      const Comp = (render as { component: ComponentType<Record<string, never>> }).component
      return <Comp />
    }
    case 'named': {
      const name = (render as { component: string }).component
      const Comp = BUILTIN_COMPONENTS[name]
      if (Comp) return <Comp />
      return (
        <Empty
          data-testid={`workbench-view-unresolved-${view.id}`}
          title="Panel unavailable"
          description={`"${name}" is not registered in this build.`}
        />
      )
    }
    case 'iframe':
      return (
        <Empty
          data-testid={`workbench-view-iframe-${view.id}`}
          title="Interactive panel"
          description="Sandboxed code panels are not enabled in this build."
        />
      )
    default: {
      // An analysis' declarative PANE (ITEM-9 / INV-3): render one interpreter per declared
      // `ui:` file, stacked top to bottom in declaration order, each bound to its own
      // per-instance store. A non-declarative `{ spec }` (a future baked spec form) keeps
      // the honest note.
      const spec = (render as { spec?: unknown }).spec
      if (isDeclarativeRenderSpec(spec)) return <DeclarativeStack render={spec} />
      return (
        <Empty
          data-testid={`workbench-view-spec-${view.id}`}
          title={view.title}
          description="Declarative view rendering lands with the visualization engine."
        />
      )
    }
  }
}

/** Render one contributed view. `chrome` (default true) adds the quiet header; a hero /
 *  tabbed region passes `chrome={false}` so the body fills without a redundant title. */
export function ViewHost({ view, chrome = true }: { view: ViewContribution; chrome?: boolean }) {
  if (!chrome) {
    return (
      <section
        className="flex min-h-0 flex-1 flex-col"
        data-testid={`workbench-view-${view.id}`}
        aria-label={view.title}
      >
        {/* NOT a scroll container. Every `chrome={false}` body either owns its own scroll
            track (a declarative pane's form track — `DeclarativeStack`) or is a full-bleed
            viewport (the canvas), so this box scrolled nothing while nesting a second native
            scroller around one that already existed. A flex COLUMN is load-bearing and stays:
            `CanvasView`'s `flex-1` is inert in a block parent (61c90f88 bug 1, pinned by
            `tests/e2e/14-workbench/canvas-host-height.spec.ts`). */}
        <div className="flex min-h-0 flex-1 flex-col">
          <ViewBody view={view} />
        </div>
      </section>
    )
  }
  return (
    <section className="flex min-h-0 flex-col" data-testid={`workbench-view-${view.id}`} aria-label={view.title}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        {view.icon ? <span className="[&_svg]:size-4 text-muted-foreground">{view.icon}</span> : null}
        <span className="text-sm font-medium">{view.title}</span>
      </header>
      {/* The CHROMED body (the mobile bottom dock's view tabs — `BottomAnalysesDock`). Unlike
          the pane path there is no `PaneBody` above it to supply an inset, so this one keeps its
          own; it scrolls through the kit `ScrollArea` like every other content track. */}
      <PaneScroll axis="y" className="min-h-0 flex-1">
        <div className="p-3">
          <ViewBody view={view} />
        </div>
      </PaneScroll>
    </section>
  )
}
