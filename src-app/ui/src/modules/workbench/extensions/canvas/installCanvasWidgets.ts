// `installCanvasWidgets()` (ITEM-36 / DEC-A) — the CANVAS extension's own widget
// registration, through the ORDINARY `registerWidget` path.
//
// The five plot kinds used to be listed in core's closed `WIDGET_KINDS` and registered
// by core's `installWidgets()`. That put the plot vocabulary in the transport layer: to
// evolve a plot kind you edited `core`. Ownership now sits where the plots do — canvas
// declares its kinds here and registers them exactly as a third-party extension would,
// so core keeps only the FORM-CONTROL kinds and the kind set is OPEN (DEC-A).
//
// ── KNOWN TENSION (relocated as-is, NOT introduced here) ──────────────────────────
// `canvasBinding.ts` states the canvas-hero discipline: the declarative `canvas:` block
// drives the SINGLE `GridWorkspace` through `VizController.setOption` and "never spawns a
// second `<Viz>`". The renderers below (moved verbatim from the old
// `declarative/widgets/viz.tsx`) each mount their OWN inline `<Viz>`, i.e. a second GPU
// context per widget. They are DEAD today — no shipping `view_spec` instantiates
// `kind: scatter|violin|bar|histogram|image`; every shipping plot goes through the
// `canvas:` block. This slice is a MOVE, so the renderers are relocated unchanged rather
// than rewritten to drive the shared controller. Converting them to declared canvas CELLS
// (or deleting them) is a behaviour change and belongs to a later slice.

import { lazy, createElement, Suspense, type ComponentType } from 'react'
import { registerWidget, type WidgetRenderer } from '@/modules/workbench/core/render/registry'

/** The plot widget `kind`s the canvas extension OWNS. Deliberately NOT part of core's
 *  `WIDGET_KINDS` (ITEM-36): core is the transport, canvas is the capability. */
export const CANVAS_WIDGET_KINDS = ['scatter', 'violin', 'bar', 'histogram', 'image'] as const
export type CanvasWidgetKind = (typeof CANVAS_WIDGET_KINDS)[number]

let installed = false

/**
 * The renderer module (`./viz`), loaded on DEMAND.
 *
 * ── WHY (measured) ────────────────────────────────────────────────────────────────────
 * `installCanvasWidgets()` runs on the module-REGISTRATION path (`workbench/module.tsx` →
 * `loadDiscoveredProcessors()` → `register.ts` → `extensions/index.ts`), i.e. at app boot on
 * every route including the login screen. It used to import `./viz` — and therefore
 * `<Viz>`, and therefore the whole deck.gl/luma/viv render stack — statically, purely to put
 * five renderer FUNCTIONS in a Map. What registration actually needs is the KIND NAMES
 * (`hasWidget(kind)` is what `parseViewSpec`'s open-kind check consults); the components are
 * needed only if something renders one.
 *
 * So the kinds register eagerly (validation behaviour unchanged) and the components arrive
 * with the first render of one. `React.lazy` memoizes the import, so the five kinds share a
 * single fetch of the module.
 *
 * Measured by ablation (restore the static import, rebuild, diff the modulepreload set in
 * `dist/index.html`): this deferral is worth **583.7 kB gzip** off the preloaded critical path.
 *
 * The `installBuiltins()` call that used to live here moved with them: it populates the
 * `@ziee/viz` CHART registry so a `<Viz option>` resolves `series.type`, which is a RENDER
 * requirement, not a registration one. `./viz`'s own module load performs it (and
 * `GridWorkspace` does the same at its module load), so it is satisfied strictly before any
 * chart can paint. Parse-time chart-type resolution is served by the render-free
 * `installBuiltinSchemas()` in `core/spec/schema.ts`.
 */
// Derived from `WidgetRenderer` rather than deep-imported from `core/manifest/viewSpec` +
// `core/render/registry`: INV-3/INV-8 allow ONE import statement per layer boundary, and the
// renderer signature already carries both halves.
type RendererProps = { spec: Parameters<WidgetRenderer>[0]; ctx: Parameters<WidgetRenderer>[1] }

const lazyRenderer = (pick: (m: typeof import('./viz')) => WidgetRenderer): WidgetRenderer => {
  // `lazy` memoizes its factory, so the five kinds share ONE fetch of `./viz`. The wrapper
  // adapts the module's `(spec, ctx) => ReactNode` renderer to the component `lazy` expects.
  const Lazy = lazy(async () => {
    const render = pick(await import('./viz'))
    const Component: ComponentType<RendererProps> = ({ spec, ctx }) => render(spec, ctx)
    return { default: Component }
  })
  return (spec, ctx) => createElement(Suspense, { fallback: null }, createElement(Lazy, { spec, ctx }))
}

/** Register the canvas plot renderers (idempotent). */
export function installCanvasWidgets(): void {
  if (installed) return
  registerWidget('scatter', lazyRenderer(m => m.ScatterRenderer))
  registerWidget('violin', lazyRenderer(m => m.ViolinRenderer))
  registerWidget('bar', lazyRenderer(m => m.BarRenderer))
  registerWidget('histogram', lazyRenderer(m => m.HistogramRenderer))
  registerWidget('image', lazyRenderer(m => m.ImageRenderer))
  installed = true
}

/** Test-only reset of the install latch (the shared widget registry is cleared by
 *  `__clearWidgetsForTests`, so the latch must drop with it or a re-install no-ops). */
export function __resetCanvasWidgetsForTests(): void {
  installed = false
}
