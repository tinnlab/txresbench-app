# P6 — Workbench Shell + IA · convergence diff (r1 vs r2)

## Substantively new in r2 (not in r1)
- **Toolbar `commands`-registry injection region (ITEM-4).** r2's top toolbar renders a contribution's
  toolbar-targeted `CommandContribution` as a button (a command-injection slot), with an overflow menu on narrow
  width. r1's `TopToolbar` is built-in controls only (no contribution-driven command injection).

## Substantively new in r1 (not in r2)
- **`fullBleed?` panel-flag study-core edit (ITEM-14 + DEC-P6-1 + a dedicated risk).** r1 identifies that
  `StudyDetailPage` wraps panels in `max-w-5xl p-4`, blocking a full-width/full-height workbench, and adds
  `fullBleed?: boolean` to `StudyDetailPanelContribution` (edit to `study/core/extensions/types.ts` +
  `StudyDetailPanelSlot`/`StudyDetailPage`) so the shell drops max-width + owns its height, plus the
  "full-height inside a scrolling page" (`h-[calc(100dvh-…)]`/`min-h-0` chain, e2e-only-caught) risk. r2 mounts
  the shell as the `workspace` detail-panel but never addresses the max-w-5xl width blocker or a full-bleed flag.
- **Explicit V2-e2e-regression risk (14/14 `analysis-workspace*` testIds).** r1 calls out migrating or keeping
  compatibility testIds when superseding V2. r2 only flags the gallery/source-walking completeness gate, not the
  existing e2e specs.
- **Desktop (Tauri) full-height verification risk.** r1 flags verifying the desktop-embedded path
  (`CORE_MODULE_BLOCKLIST`/config parity) for full-height resizable panels. r2 has no desktop-specific risk.

## Shared substance
Both rebuild the study `workspace` surface as an IDE-style dock frame from `WORKBENCH_IA.md`: a horizontal
`ResizablePanelGroup` (left · center · right) with the bottom dock as a vertical split INSIDE the center column
(so wide tables go full-width below the canvas, never beside it), a non-collapsing center canvas hero, and
collapse-to-labeled-24px-stripe edge docks (JetBrains/VS model, one-click reopen). Both add a `WorkbenchLayout`
store (`defineStore`, per-dock `{collapsed,size}` + active-tab + plot-type/layout-mode/color-by, persisted per
study to localStorage, server persistence deferred, `resetLayout`). Both build a thin top toolbar
(dataset/embedding · plot-type · single/split layout · color-by · Run · Export · Reset), a pure semantic
slot-placement engine that routes a `ViewContribution` by type/`area` (field→left, result→bottom, inspector→
right, view→center), rejects invalid placements, composes multiple contributions as ordered tabs, and gates by
`when`/`requires` against catalog data-kinds. Both provide the two HOST renderers — a 4-tier JSON-schema→`@txresbench/kit`
`SchemaForm` (Tier-1 scalar controls, Tier-2 auto-populated type-filtered artifact-ref pickers, Tier-3 named host
widgets incl. a P8-stubbed `cell-set-selector`, Tier-4 code-form) and a `ResultPanelHost` dispatching `ResultKind`
through the P5 `resultRenderers` registry to standard panels (DE table / stat card / provenance view) so DE
variants share one panel — plus left field-provider click-to-color, a persistent right selection inspector
(N-selected/composition/assign-annotation/top-DE over `api.selection`), bottom analysis+data tabs, center P7
canvas-host mount, quiet-dark data-forward chrome (design tokens only), mobile `Sheet` fallback, and a gallery
story set + stable `data-testid`s for the `gate:ui` pass. Both ship fallback adapters over `analysisRegistry` /
`ExplorerCanvas` / static-inspector so the shell lands before P5/P7/P8 merge, and both name P5 the hard blocker
with P7/P8 as center/inspector seams.

## Verdict
VERDICT: CONVERGED
