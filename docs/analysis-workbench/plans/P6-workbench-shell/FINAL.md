# P6 — Workbench Shell + IA (FINAL, converged union of r1 + r2)

## Reconciliation applied
Cross-part audit resolution baked into this plan: **A3** — the `SchemaForm` / form-from-JSON-schema
renderer is **owned by P6** (it is a shell/host panel; ITEM-7/8). P5 does NOT build the renderer — it
only DEFINES the JSON-schema *type* a contribution declares (params/settings schema, artifact-ref
field type, host-widget slot type); P6's host panel renders from that type. This resolves the earlier
double-build of the renderer across P5 and P6.

The study-detail `workspace` surface rebuilt as an IDE-style dock frame per `WORKBENCH_IA.md`: a
center canvas hero (hosts P7) + collapsible LEFT metadata/genes dock + RIGHT selection-inspector dock
+ BOTTOM results dock, collapse-to-labeled-stripe, a thin top toolbar, quiet dark data-forward chrome,
and FIXED (not free/float/detach) docking. P6 RENDERS FROM the P5 contribution registries +
`WorkbenchAPI` and HOSTS the P7 viz engine — it does NOT define the registries or build view-kinds.
It provides the two HOST renderers (form-from-JSON-schema, result-from-kind) so ~90% of docks need no
per-plugin UI code; a `component` injection is the escape hatch only for interactive tools. It
supersedes the interface-round V2 (`components/WorkspacePanel.tsx` + `ContextPanel`/`AnalysesDock`/
`ExplorerCanvas`), a single constrained `max-w-5xl` study-section panel.

**Scope:** desktop + single-box server; on-system `@txresbench/kit`; render from P5 registries with a
fallback adapter over the existing `analysisRegistry`/`AnalysisWorkspace` mock so the shell lands +
demos before P5/P7/P8 merge. No multi-topology / free-docking concerns.

## Items

- **ITEM-1 — Kit `Resizable` export.** The frame needs resizable docks; the SDK ships
  `sdk/packages/kit/src/shadcn/resizable.tsx` (react-resizable-panels) + `shadcn/collapsible.tsx` but
  neither is re-exported from `kit/index.ts`. Add a thin `kit/resizable.tsx` wrapper
  (`ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle`, kit-tokened + `data-slot`) and export it
  (+ `Collapsible` if the stripe uses it) from `index.ts`. No new npm dep (react-resizable-panels
  already present under shadcn). Mirror in the desktop kit copy if separate.

- **ITEM-2 — `WorkbenchLayout` store + persistence + Reset layout.** New Zustand store
  (`stores/WorkbenchLayout.store.ts`, `defineStore` per store-kit) holding per-dock UI state:
  `{ left,right,bottom: { collapsed:boolean, size:number }, activeTab: Record<area,string>,
  plotLayout:'single'|'split', colorBy, resetToken }`. Actions: `toggleDock(area)`, `setSize(area,px)`,
  `setActiveTab(area,id)`, `setPlotLayout(m)`, `resetLayout()`. Persist per-user×study to
  `localStorage` (key `txr.wb.layout.<studyId>`, mirroring split-chat's `splitWorkspace.persist`);
  `ensureStudy(id)` resets on study switch; server-side persistence DEFERRED (open seam).
  `resetLayout()`/`workbench.resetLayout` command restores IA defaults (left+bottom open, right open,
  canvas maximal). Reads reactively in the shell; key persisted sizes by stable `area`, not per-tab id.

- **ITEM-3 — `WorkbenchShell` dock frame (4-region grid).** New `shell/WorkbenchShell.tsx` — the
  L/R/bottom/center IDE grid. Horizontal outer `ResizablePanelGroup` (left · center-column · right)
  with the BOTTOM dock as a vertical split INSIDE the center column (center-canvas + bottom-results
  stack, so the bottom dock spans center width only — "wide tables go full-width below the canvas,
  never beside"; L/R docks stay full height). Min/max splitter sizes; center is the flex hero that
  never collapses. Reads `WorkbenchLayout`; each dock renders `DockRegion` (open) or `DockStripe`
  (collapsed). Fixed regions, resizable/collapsible splitters — NOT free float/detach (IA §5). Full
  region height (`h-[calc(100dvh-<hdr>)]`, `min-h-0` chain) so the canvas fills the viewport, not a
  scrolling page. Renders `TopToolbar` above the grid.

- **ITEM-4 — `DockRegion` + `DockStripe` (collapse-to-labeled-stripe).** `shell/DockRegion.tsx`: a dock
  body = kit `Tabs` (multiple `ViewContribution`s composed into one dock) + a header with collapse
  control + resize handle; on collapse the store swaps in `shell/DockStripe.tsx` — a ~24px labeled edge
  button (icon + rotated/vertical L/R text, horizontal bottom) that one-click reopens to its last size
  (JetBrains/VS-2022 model, IA §6). Center never gets a stripe; panel discoverable, never a plain
  on/off toggle. a11y: `aria-expanded`, keyboard toggle, labeled stripe button. NOTE: react-
  resizable-panels min-size vs a 24px stripe can fight — the stripe may need rendering OUTSIDE the
  panel group (an overlay rail) rather than as a collapsed panel; prototype early.

- **ITEM-5 — `TopToolbar` (thin, universal + command injection).** `shell/TopToolbar.tsx`: built-in
  controls — dataset/embedding switch · plot-type (scatter/violin/…) · layout (single/split
  small-multiples) · color-by indicator · Run (standard recipe) · Export · Reset-layout — PLUS a
  `commands`-registry injection region so a contribution's toolbar-targeted `CommandContribution`
  renders as a button; overflow menu on narrow width. Built from kit `Segmented`/`Select`/`Button`/
  `Dropdown`. Plot-type + layout drive P7's canvas layout MODE (P6 owns the CONTROL, P7 renders);
  Run/Export reuse the existing recipe + `ExportMenu`; Reset-layout → `WorkbenchLayout.resetLayout()`.
  Quiet, dense, single row.

- **ITEM-6 — Semantic slot resolver / placement engine.** `shell/placement.ts` — a pure
  `placeViews(registry, area, ctx)` selector (unit-testable + gallery-observable) that maps each P5
  `ViewContribution`/typed contribution to a dock area with SEMANTIC placement (IA §4.5.3):
  `field-provider→left`, `result-kind→bottom`, `selection-inspector→right`, `view-kind/overlay→center`;
  honor an explicit `area` on `ViewContribution` but REJECT invalid placements (a result table can't
  land left; a field-provider can't land bottom). Groups contributions per area, orders by `order`,
  gates by `when`/`requires` (data-kind availability from the catalog) so a dock/tab appears only when
  applicable. The module owns a TAB, not a dock. Fallback adapter maps the existing `analysisRegistry`
  catalog + produced-kinds into this shape.

- **ITEM-7 — `ViewHost` (render one contribution).** `shell/ViewHost.tsx` — dispatches a
  `ViewContribution.render` (IA §1.1): `{schema}`→`SchemaForm` (ITEM-8), `{table}`/result-kind→
  `ResultPanelHost` (ITEM-9), `{plot}`→a P7 view-kind cell, `{component}`→a built-in code panel
  (interactive tools §4.4), `{iframe}` DEFERRED. Host-owned chrome (header/collapse/resize); the module
  fills only the content slot, built from `@txresbench/kit` so contributed panels look native (IA §4.5.2).

- **ITEM-8 — Host form-from-JSON-schema (`SchemaForm`) — P6 OWNS this renderer (A3).**
  **Reconciliation A3: P6 is the sole owner of the `SchemaForm` / form-from-JSON-schema renderer** (a host/shell
  panel). It consumes the JSON-schema *type* P5 defines (params/artifact-ref/host-widget-slot schema — P5
  ITEM-16) and renders it; P5 does not build a competing renderer. `form/SchemaForm.tsx` + `form/fields/*` +
  `form/widgets/registry.ts` — the ~90% declarative path with ZERO per-analysis UI code (IA §4.3),
  four tiers: **Tier 1** scalar schema → kit controls (number→InputNumber/slider min/max/step,
  enum→Select, string→Input, boolean→Switch, array→MultiSelect); **Tier 2** `artifact-ref` fields →
  auto-populated, type-filtered pickers (kit `Select` of the study's compatible artifacts via
  `api.data.catalog()` + `accepts`/subtype match — the "clustering needs an embedding" case; fallback:
  produced-kinds); **Tier 3** named host-widget slot (`widget: cell-set-selector | gene-selector |
  colormap-picker | threshold-on-histogram`) dispatching to a registry of shared rich widgets (this
  round: `gene-selector` + a `cell-set-selector` stub wired to P8 selection; others stubbed); **Tier
  4** a code-form escape hatch = a contribution-supplied `ParamsForm`/`component` React component
  (built-in only, the pressure valve). Progressive disclosure (Simple/Advanced) + conditional
  `when`/`if-then` field visibility. Supersedes `AnalysisForm`/`ContextPanel` and V2's per-plugin
  `SimpleForm`/`AdvancedForm`; reuses their disclosure + progress/run wiring. (Largest single chunk;
  the legacy param inventory — 71 Select / 23 InputNumber / … — bounds Tier 1.)

- **ITEM-9 — Host result-from-result-kind (`ResultPanelHost` + standard panels).**
  `result/ResultPanel.tsx` + `result/renderers/*` — dispatches a produced result's `ResultKind` through
  the P5 `resultRenderers` registry to STANDARD built-in panels so two DE variants render in the SAME
  panel (IA §4.5.1): a wide DE/marker `StandardResultTable` (kit `Table` — sortable/filterable/
  paginated/export, the full-width bottom-dock rule, IA decision 2), a stat/KPI card (reuse
  `ResultCard` KPIs), a provenance/methods view (reads §0.6 run node — fallback:
  `AnalysisResult.provenance`), and a generic fallback renderer for an unknown kind. Wire the run
  lifecycle (idle → running w/ progress → done/error) from `api.compute` job handles (P5), superseding
  the V2 mock `run()`. Reuse `MarkerTable`. Supersedes V2's per-plugin `ResultView`.

- **ITEM-10 — `CenterCanvasHost` (hosts P7).** `docks/CenterCanvasDock.tsx` — the seam that mounts P7's
  (`feat/visualization`) view-kind grid + Coordination store as the permanent center hero. Enforce
  canvas-hero discipline: never a tab, never split by default, never reflows on recolor — recolor
  updates in place (IA decision 1); layout-mode single/linked-small-multiples toggles the engine's grid
  (its Coordination store = linked brushing). Provide a floating-legend overlay slot + lasso/brush
  inline-affordance passthrough (the canvas owns pick/lasso; P6 only frames it). Fallback: renders the
  existing `ExplorerCanvas` + `ColorByControl`/`ClusterLegend` overlays behind a `hasVizFramework` flag
  until P7 lands. Empty state (kit `Empty`, "Your cells will appear here").

- **ITEM-11 — Left dock host — "Visualize."** `docks/LeftVisualizeDock.tsx` — composes the left dock
  from `field-provider` contributions: Metadata (obs columns) + Genes (filterable search list) tabs;
  a single click on a field/gene calls `api.selection`/color-by to recolor the canvas (click-to-color,
  NOT drag — cellxgene consensus), wired to P7 Coordination + P8 selection. This round: a built-in
  `MetadataFields` + `GeneSearch` field-provider pair reading the data API (fallback: mock `colorBy` in
  `AnalysisWorkspace`). P6 owns the frame + search chrome + the click→color-by dispatch seam; the
  provider rows come from P5/P11. Supersedes ad-hoc `ColorByControl`.

- **ITEM-12 — Right dock host — Selection inspector.** `docks/RightInspectorDock.tsx` +
  `panels/SelectionInspector.tsx` — persistent (not inline-expand) right dock: N selected ·
  composition/stats · Assign annotation (write-back) · top-DE genes (IA decision 4) · the
  `selectionActions` registry rendered as offered actions on the current selection. Thin code over P8
  `api.selection` (`useCurrent`/`onChange`); assign → `data.writeAnnotation` (P1) → new left-rail
  metadata (closes the lasso→annotate loop). Fallback: static inspector reading no selection until P8
  lands. First dock to hide (IA). Stats/DE content is P11; P6 owns the frame + selection-driven refresh
  seam.

- **ITEM-13 — Bottom dock host — Analysis + data.** `docks/BottomResultsDock.tsx` — tabbed, resizable,
  full-width results dock: bottom-targeted `views` become tabs (Differential Expression · Markers ·
  Clustering · Annotation · Log/provenance). Each analysis tab = the host-rendered config form (ITEM-8)
  + the host-rendered result panel (ITEM-9). This is where wide tables live (the full-width argument).
  Reuse `AnalysesDock`'s run-order status chips as a bottom-dock "Analyses" run rail; reuse
  `AnalysisCatalog` as "Add analysis".

- **ITEM-14 — Study-substrate mount + full-bleed integration.** Register the shell as the study
  `detail_panels` `workspace` section (zero-prop, reads `Stores.StudyDetail`) via
  `studyExtensionRegistry`, replacing V2 `WorkspacePanel`/`ContextPanel`/`AnalysesDock`. The workbench
  needs full width + viewport height, but `StudyDetailPage` wraps panels in `max-w-5xl p-4 sm:p-6`; add
  an optional `fullBleed?: boolean` to `StudyDetailPanelContribution` (`study/core/extensions/types.ts`);
  `StudyDetailPanelSlot`/`StudyDetailPage` drop the max-width + padding (and let the panel own its
  height) for a full-bleed section. Update `analysis/study-extension/extension.tsx`: `workspace` panel
  → `WorkbenchShell`, `fullBleed: true`. Minimal, principled study-core edit (one flag) — cleaner than
  a negative-margin `-mx` breakout inside `max-w-5xl`.

- **ITEM-15 — Quiet dark, data-forward chrome.** Apply IA decision 8: near-black canvas, muted borders,
  chrome nearly invisible so data is the only color. Force-dark the canvas region minimum (a
  `data-workbench-canvas` dark scope) regardless of app theme; docks theme-aware but low-chroma. Reuse
  existing tokens (`bg-card`, `border-border`, `muted`); add a small workbench dark surface token set if
  needed (coordinate with `@txresbench/kit` DESIGN_DIRECTION — "research workbench" is its stated subject);
  design-system tokens only, no raw colors. Resolves FB-1 (plain/templated) + FB-2 (restrained dark
  chrome); supersedes the earlier glowy-glass direction.

- **ITEM-16 — Mobile/desktop responsive.** Desktop = resizable docks + stripes. Mobile/narrow
  (`useIsMobile`) = the 3 edge docks degrade to kit `Sheet`s (reuse the V2 mobile-sheet pattern);
  center canvas stays the hero. Verify the lasso→inspect→results loop survives on narrow width (or
  accept desktop-first per scope).

- **ITEM-17 — Gallery + testIds + gate:ui.** Register the workbench shell in the analysis module
  gallery (`workbench/gallery.tsx` / `analysis/gallery.tsx`) across states (empty / running / results /
  collapsed docks) × themes × accents for the `gate:ui` runtime-health + visual pass + the source-walking
  completeness gate; stable `data-testid`s on shell/docks/stripes/toolbar (`workbench-shell`,
  `workbench-dock-<area>`, `workbench-stripe-<area>`, `workbench-toolbar`, `workbench-canvas-host`).
  Replace (not leave dangling) the V2 `analysis/components/*` gallery stories.

## Files/modules

New (under `src-app/ui/src/modules/analysis/workbench/` unless noted; supersedes the V2
`analysis/components/*` explorer set):
- `shell/WorkbenchShell.tsx` (ITEM-3) — top-level frame + 4-region grid, mounts toolbar + docks + center.
- `shell/DockRegion.tsx` + `shell/DockStripe.tsx` (ITEM-4) — dock body (tabs/header) + collapsed stripe.
- `shell/TopToolbar.tsx` (ITEM-5) — thin toolbar + command-injection region.
- `shell/placement.ts` (ITEM-6) — pure `placeViews()` semantic router + gating + analysisRegistry fallback adapter.
- `shell/ViewHost.tsx` (ITEM-7) — render one `ViewContribution`.
- `form/SchemaForm.tsx` + `form/fields/*` + `form/widgets/registry.ts` (ITEM-8).
- `result/ResultPanel.tsx` + `result/renderers/*` + `result/StandardResultTable.tsx` (ITEM-9).
- `docks/LeftVisualizeDock.tsx` (ITEM-11), `docks/RightInspectorDock.tsx` + `panels/SelectionInspector.tsx` (ITEM-12),
  `docks/BottomResultsDock.tsx` (ITEM-13), `docks/CenterCanvasDock.tsx` (ITEM-10).
- `fields/MetadataFields.tsx` + `fields/GeneSearch.tsx` (ITEM-11) — built-in left field-providers.
- `stores/WorkbenchLayout.store.ts` + `stores/WorkbenchLayout.persist.ts` (ITEM-2).
- `workbench/gallery.tsx` (ITEM-17).
- `sdk/packages/kit/src/kit/resizable.tsx` + `sdk/packages/kit/src/index.ts` export (ITEM-1; mirror desktop kit).

Modify:
- `study/core/extensions/types.ts` (+ `slots.tsx`/`StudyDetailPanelSlot`, `pages/StudyDetailPage.tsx`) — `fullBleed` flag (ITEM-14).
- `analysis/study-extension/extension.tsx` — `workspace` → `WorkbenchShell` + `fullBleed:true` (ITEM-14).
- `analysis/module.tsx` — register `WorkbenchLayout` store.
- `analysis/gallery.tsx` — workbench shell stories, remove V2 stories (ITEM-17).

Consumes (do not author here): P5 `@txresbench/workbench-api` (registries `{views,fieldProviders,
resultRenderers,selectionActions,commands}` + `WorkbenchAPI.{data,selection,commands,compute,ui}`);
P7 viz engine grid from `modules/visualization/viz-core`; P10 `studyExtensionRegistry` +
`Stores.StudyDetail`.

Supersede/fold in (keep as fallback until P5/P7/P8): `components/WorkspacePanel.tsx` (→ WorkbenchShell),
`ContextPanel.tsx`+`AnalysisForm.tsx` (→ SchemaForm), `AnalysesDock.tsx`+`AnalysisCatalog.tsx` (→
bottom-dock tabs), `ResultCard.tsx`+`MarkerTable.tsx` (→ ResultPanelHost), `ExplorerCanvas.tsx`+
`ColorByControl.tsx`+`ClusterLegend.tsx`+`ExportMenu.tsx` (→ CenterCanvasHost / left fields / toolbar).

## Reuse

- **Interface-round V2 build** (`modules/analysis/components/*`) — supersede-by-fold: ExplorerCanvas as
  center fallback, ContextPanel/AnalysisForm patterns → SchemaForm, AnalysesDock chips → bottom rail,
  MarkerTable/ResultCard → ResultPanelHost, ColorByControl/ClusterLegend/ExportMenu → left/toolbar.
  Salvage V2's layout math + click-to-color + mock lifecycle shape; the per-plugin form/result
  components are superseded by ITEM-8/9. Registry shape (`analysis/registry.ts`) generalizes into P5.
- **`AnalysisWorkspace.store` + `analysisRegistry`** — the mock engine + gating/recipe; keep as the
  P5-fallback data source (produced-kinds gating, `standardRecipe`, run SSE shape).
- **Split-chat multipane** (`modules/chat/core/split`, `SplitView.store`, `splitWorkspace.persist`,
  `SplitChatView`) — the pane-layout + per-study persistence + reconcile precedent for ITEM-2/3.
- **Study-extension slot seam** (`study/core/extensions/*`) — the workbench mounts through `study_nav`
  + `detail_panels` (already wired); add `fullBleed` only.
- **`@txresbench/kit`** — `Tabs`, `ScrollArea`, `Table`, `Segmented`, `Select`, `Slider`, `Button`, `Dropdown`,
  `Tooltip`, `Separator`, `Sheet`, `Empty`, `Spinner`/`Progress`, `InputNumber`, `Switch`, `MultiSelect`,
  `Statistic`, `useIsMobile`; plus the newly-exported `Resizable*` (ITEM-1) + `shadcn/collapsible`. All
  docks/tabs/forms built from kit per §4.5.2 (native, not foreign).
- **`SettingsPageContainer` / card patterns** (txresbench host) for panel chrome consistency.
- **P5 registries** (`views`/`analyses`/`resultRenderers`/`fieldProviders`/`selectionActions`/`commands`
  from `@txresbench/workbench-api`, PLATFORM_ARCH §1/§2) — the source the shell renders from.
- **P7 viz** (view-kind registry + grid + Coordination store) — hosted by CenterCanvasHost.
- **P8 selection** (`api.selection`/`brush`/`pick`) — drives the right inspector + left click-to-color.

## Dependencies

- **P5 contribution-api (HARD BLOCKER / PRIMARY dep)** — P6 renders entirely from the P5 registries +
  `WorkbenchAPI` (`views`, `fieldProviders`, `resultRenderers`, `selectionActions`, `commands`; `data`,
  `selection`, `compute`). Nothing renders real content without it. Build against a typed stub
  `WorkbenchAPI` + an adapter over `analysisRegistry` if P5 lags, so P6 is NOT hard-blocked from
  scaffolding — but the registry TYPES must land first.
- **P7 visualization** — CenterCanvasHost mounts P7's view-kind grid + Coordination store; center is a
  seam until P7 (ExplorerCanvas fallback, placeholder-first, swap late).
- **P8 interaction-dsl** (soft) — right selection inspector + left click-to-color/select consume shared
  selection/brush/pick; P6 frames, P8 wires; fallback static until P8.
- **P2 datatype-system** — result-kind → renderer dispatch + artifact-ref subtype filtering in
  SchemaForm pickers.
- **P1 data-foundation** — `data.*` API (catalog, obs/gene columns, DE tables, writeAnnotation) for live
  field-providers + result tables + write-back; mockable via the store this round.
- **P10 study-substrate** — `workspace` detail-panel mount + `Stores.StudyDetail` (already present);
  `canEdit`/study role gate toolbar Run/Export + write-back (`study.effective_permission`).
- **P11 three-modules** (soft, downstream) — consumes P6's slots/forms/renderers; not a build dep.

## Sequencing

1. **ITEM-1** kit `Resizable` export → the static 4-region frame (unblocks the frame).
2. **ITEM-2 → ITEM-3 → ITEM-4** layout store → shell grid → dock/stripe (static placeholder content) —
   the IA skeleton stands alone, testable. (Prototype ITEM-4 collapse-vs-min-size early.)
3. **ITEM-6 → ITEM-7** semantic placement engine (pure, testable — the spine every dock host consumes)
   + ViewHost (compose from P5 registry; analysisRegistry fallback adapter).
4. **ITEM-8 → ITEM-9** host-rendered SchemaForm + ResultPanelHost/StandardResultTable (the two
   host-standard panel families; parallelizable, both need P5 types).
5. **ITEM-5 → ITEM-10** TopToolbar + CenterCanvasHost (host P7; ExplorerCanvas fallback).
6. **ITEM-11 → ITEM-13 → ITEM-12** left fields → bottom analysis/data tabs → right selection inspector
   (P8-gated last).
7. **ITEM-14** study-substrate mount + full-bleed flag + wire workspace → WorkbenchShell.
8. **ITEM-15 → ITEM-16 → ITEM-17** dark chrome → responsive → gallery/testIds/gate:ui (last — needs all
   docks to render a real story).

## Decisions

- **DEC-P6-1 Full-bleed via a panel flag, not a breakout hack.** Add `fullBleed?: boolean` to
  `StudyDetailPanelContribution`; the shell drops `max-w-5xl`/padding + yields height for that section.
  Cleaner + reusable vs a negative-margin `-mx` breakout inside `max-w-5xl`. (r1-distinct; r2 mounts the
  panel but never addresses the width blocker — adopted.)
- **DEC-P6-2 Resizable = react-resizable-panels via a kit export** (already a shadcn dep) — no new npm
  dependency; docks are fixed regions + resizable/collapsible splitters (IA §5, "fixed not free").
- **DEC-P6-3 Collapse-to-labeled-stripe** (custom ~24px edge button), NOT shadcn `Collapsible`
  show/hide and NOT a plain ⌘B toggle — the store owns sizes; a collapsed dock is a discoverable labeled
  stripe (IA §6). Center never collapses/tabs/reflows on recolor — canvas-hero discipline.
- **DEC-P6-4 Bottom dock spans center-column width only** — vertical split INSIDE the center column, so
  L/R docks stay full height and wide DE tables get canvas width (matches the IA ASCII; full-width rule
  IA decision 2).
- **DEC-P6-5 Center = one hero, host-seamed to P7.** Never a tab, never split by default; plot-type +
  small-multiples are a P7 canvas LAYOUT MODE driven by the P6 toolbar control (IA decision 1/7).
- **DEC-P6-6 Panels host-rendered by default; injection only for interactive tools.** ~90% of docks are
  host-standard (SchemaForm + ResultPanelHost); a `component` ViewContribution is the only injection,
  built from `@txresbench/kit` into a semantic slot the host composes (IA §4.5). `iframe` code-views DEFERRED.
- **DEC-P6-7 Toolbar exposes a `commands`-registry injection region.** Built-in controls PLUS
  contribution toolbar-targeted `CommandContribution`s render as buttons, overflow menu on narrow width.
  (r2-distinct — compatible with and additive to the built-in controls; adopted alongside DEC-P6-5.)
- **DEC-P6-8 Semantic placement enforced.** Area derived from contribution type (field→left,
  result→bottom, inspector→right, view→center), honoring explicit `area` but rejecting invalid drops;
  the module owns a tab, not a dock — keeps the workbench from becoming a junk drawer (IA §4.5.3).
- **DEC-P6-9 Form tiers 1–4 exactly per §4.3.** Artifact-ref (Tier 2) pickers auto-populate from the
  catalog (the headline); do NOT let each analysis hand-code a picker. Tier 4 (code-form) is the
  pressure valve; don't gold-plate Tier 1 conditionals.
- **DEC-P6-10 Layout persistence = localStorage per study, this round.** Server-side per-user layout is
  an open seam (DEFERRED, 1-box scope). `Reset layout` always available.
- **DEC-P6-11 Quiet dark, data-forward chrome.** Force-dark canvas region minimum; low-chroma dock
  chrome; design-system tokens only, no raw colors. Resolves FB-1/FB-2; supersedes glowy-glass.
- **DEC-P6-12 P5/P7/P8-fallback adapters ship in P6** so the shell lands + is demoable before those
  parts merge (adapter over `analysisRegistry` + `AnalysisWorkspace` mock; ExplorerCanvas center; static
  inspector).

## Risks

- **P5 registry shape churn (HIGHEST).** P6 is a pure consumer; an unstable `WorkbenchAPI`/
  `ViewContribution` contract ripples through ViewHost/SchemaForm/placement/every dock host. Mitigate:
  lock the registry types with P5 first + code to §1/§2 verbatim behind a single adapter/typed-stub
  boundary.
- **SchemaForm scope creep (ITEM-8).** RJSF-style host rendering + artifact-ref pickers + host-widget
  registry + code escape is genuinely large; legacy param inventory bounds Tier 1, but Tier 2/3 are new.
  Keep Tier 4 as the pressure valve; don't gold-plate Tier 1 conditionals.
- **P7 center engine unmerged + integration seam undefined.** deck.gl-only; mount contract (data props,
  selection/color-by callbacks, resize) undefined until adopted. CenterCanvasHost seam + ExplorerCanvas
  fallback; placeholder-first, swap late. Small-multiples/linked-brushing (FB-2) depends on P7's grid +
  Coordination store.
- **Full-height inside a scrolling page.** `StudyDetailPage` is a scrolling `max-w-5xl` column; the
  `fullBleed` flag + `h-[calc(100dvh-…)]`/`min-h-0` chain must be exact or docks won't fill/scroll
  correctly (nested-scroller regressions are e2e-only-caught — see memory
  `project_chats_page_virtualization`).
- **Resizable + collapse-to-stripe interaction.** react-resizable-panels min-size vs a 24px stripe can
  fight; may need the stripe rendered OUTSIDE the panel group (overlay rail). Plus the handle-focus +
  stripe-button `aria-expanded`/roles must pass axe in the runtime-health gate. Prototype ITEM-4 early.
- **Dark-chrome vs app theme.** Forcing a dark canvas region while docks follow theme can create a
  seam/contrast mismatch; needs a token decision with `@txresbench/kit`.
- **Layout key stability.** Dock ids change as contributions register; persisted sizes must key by a
  stable `area`, not per-tab id, or a reset is forced on contribution churn.
- **Mobile fallback fidelity.** 3 edge docks → sheets can bury the selection loop; verify
  lasso→inspect→results survives on narrow width (or accept desktop-first per scope).
- **Desktop (Tauri) window.** Full-height + resizable panels under the desktop shell chrome; verify the
  desktop-embedded path (`CORE_MODULE_BLOCKLIST`/config parity, memory `project_desktop_embeds_server`).
- **Superseding V2 without regressing tests.** The interface-round e2e targets `analysis-workspace*`
  testIds (14/14) — migrate those specs or keep compatibility testIds during the swap; and replace (not
  dangle) the V2 `analysis/components/*` gallery stories (source-walking completeness gate).

## Effort

Large — the flagship frontend of the platform. Rough split: skeleton (ITEM-1..4: dock scaffold +
collapse + layout store) ≈ medium, ~2 days; placement engine + ViewHost + host-rendered panels
(ITEM-6..9, **SchemaForm + ResultPanelHost the largest single chunk**) ≈ medium-large, ~3 days;
toolbar/center-host + left/right/bottom composition (ITEM-5,10,11–13) ≈ medium, ~3 days; full-bleed +
dark chrome + responsive + gallery/gate (ITEM-14..17) ≈ medium, ~2–3 days. **≈10–11 dev-days**, gated
on the P5 contract stabilizing (adapter lets ~70% proceed in parallel; parallelize the two host
renderers against the dock hosts) with P7/P8 seams for the last ~30% of center/inspector polish.
Highest-leverage first slice: ITEM-1→4 (the standalone IA skeleton) + ITEM-8/9 (the two host-standard
panel families) — that alone supersedes V2 and demos the docked workbench.
