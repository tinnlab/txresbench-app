# PLAN — Study Analysis Workflow interface (Candidate D · V2 Explorer-centric · interface-only)

**Scope:** the **frontend interface** for the study analysis workflow — an extensible analysis-plugin
framework rendered in an explorer-centric shell, on **mock/client-side data**. **No backend, no data model,
no jobs, no migrations, no new permissions this round** (all deferred — see DECISIONS). The design contract
is `INTERFACE_DESIGN.md` (framework) + §6 (V2 shell).

## JTBD / UX design (mandatory)

Who uses this and what they want to DO, per surface:

- **Wet-lab biologist** — *"upload my cells, see my clusters and their markers, without code."* On the
  **Workspace** they land on an empty explorer with a single **"Run standard analysis"** CTA → one click →
  a colored UMAP; they color by a gene, read the marker table, accept a cell-type label. Never opens a
  parameter.
- **Bioinformatician** — *"control every parameter, compare, export."* Opens **Add analysis** → picks
  Harmony/Leiden → expands **Advanced** → runs → reads guardrail notes → exports script/object. Reaches
  every knob via disclosure, never a "pro wall."
- **Reviewer/PI** — *"look at the result, no install."* Opens a shared study's read-only Workspace.

Per-surface JTBD:
- **Workspace (explorer)**: primary destination — see the embedding, recolor it (cluster/sample/gene),
  read where the pipeline is (dock), open an analysis, read a result. Empty state must teach the first
  action; populated state must not bury the canvas.
- **Analyses dock**: at-a-glance pipeline status (done/active/stale) + the entry to add analyses; scales to
  ~12 chips then scrolls, never wraps into the canvas.
- **Context panel**: the progressive-disclosure home — Simple by default, Advanced on demand, result after
  a run; collapsible so the canvas can go full-bleed.
- **Analysis catalog**: the "tens of analyses" surface — searchable, category-grouped, prerequisite-gated;
  the biologist rarely opens it (they use the recipe), the power user lives in it.
- **Samples/QC**: upload entry + per-sample QC review with before/after + advisories; the honesty surface.
- **Empty/loading/error/running/narrow-viewport** states for every surface.

## Items

- **ITEM-1**: `AnalysisPlugin` UI descriptor type + `analysisRegistry` — register(), auto-discovery glob of `analyses/*/plugin.tsx`, and pure selectors: `byCategory()`, `availability(plugin, runState)` (prerequisite gating from `requires`/produced kinds), `standardRecipe()` (ordered `inStandardRecipe` plugins). The framework seam; unit-testable pure logic.
- **ITEM-2**: Eight seed analysis plugins under `analyses/*/plugin.tsx` — `qc.filter`, `normalize.lognorm`, `dimensionality.pca`, `integration.harmony`, `clustering.leiden`, `embedding.umap`, `markers.wilcoxon`, `annotation.reference` — each declaring category, `requires`/`produces`, `SimpleForm`, `AdvancedForm` (where the analysis has advanced knobs), `ResultView`, `defaults`, `methodsText`, `inStandardRecipe`/`recipeOrder`. Proves the framework spans categories + prereqs + the recipe.
- **ITEM-3**: Mock analysis engine + `AnalysisWorkspace` store (`defineStore`) — run-state (per-analysis status/params/result), active-analysis + context-panel open state, selection + color-by mode/gene, a mock `run(pluginId, params)` with simulated progress → canned result, and a deterministic mock-UMAP data generator (clusters, per-cell sample/gene values). No ApiClient (no backend).
- **ITEM-4**: `ExplorerCanvas` — the persistent Canvas scatter (the mock UMAP), color-by cluster/sample/gene expression, DPR-aware, redraws on theme + color-by + result changes; floating **color-by** control + gene search + a cluster **legend**. Reduced-motion + resize safe.
- **ITEM-5**: `AnalysesDock` — the bottom rail of analysis status chips (done ✓ / active ● / stale) in pipeline order, `+ Add analysis`, and the empty-state **"Run standard analysis"** CTA (chains the recipe via the mock engine). Horizontal-scroll past ~8 chips; never wraps into the canvas.
- **ITEM-6**: `ContextPanel` + `AnalysisForm` — the collapsible right panel rendering the active plugin's `SimpleForm` with an **"Advanced parameters"** disclosure revealing `AdvancedForm` (per-analysis progressive disclosure), a Run row, and — post-run — a `ResultCard` (summary KPIs → expand → params/provenance/methods text). Close → canvas full-bleed.
- **ITEM-7**: `AnalysisCatalog` overlay — a command-palette sheet: search + category sections + analysis cards; runnable cards bright, prerequisite-gated cards dimmed with a `needs: <kind>` chip (from `availability()`). Picking a runnable card opens its form in the ContextPanel.
- **ITEM-8**: Result overlays — the canvas reflects the active result (clustering → point colors + legend; gene → expression gradient; QC → removed-cells dim) + a **marker side table** (with the count-splitting guardrail note) and inline guardrail advisories (over-cluster / integration) rendered in the result card.
- **ITEM-9**: `SamplesPanel` — an upload entry (a stubbed drop-zone: "upload wiring lands with the data round"; no real upload) + per-sample **QC review** cards (adaptive-threshold read-outs, before/after cell-count delta, per-sample advisory chips) + an "Apply & continue → Workspace" action.
- **ITEM-10**: Study-extension registration (FE) — `modules/analysis/study-extension/extension.tsx` registering `study_nav` (`Samples`, `Workspace`) + `detail_panels` (mirrors `dataset`), and `modules/analysis/module.tsx` (`createModule` registering the store, `dependencies: ['study']`, importing the extension). Zero study-core edits.
- **ITEM-11**: `ExportMenu` — a dropdown offering Figure / Table / AnnData object / Script + methods-text (actions are **stubbed** with a "prepared for the data round" toast; the affordance + generated methods-text preview are real) + a read-only-share note reusing the study share.
- **ITEM-12**: `gallery.tsx` — seed every surface × state for `gate:ui`: Workspace (empty / running / clustered-result / gene-colored), Dock (empty / mid-run / complete), ContextPanel (simple-form / advanced-open / result), Catalog (open, with gated+ready cards), SamplesPanel (populated QC + warn advisory). **Narrow-viewport (390px) coverage note (amended, drift DRIFT-1.1 · impl-wins):** `@ziee/gallery`'s `SeededSurfaceEntry` has **no per-surface `viewport` field**, so 390px is not expressible as a gallery cell; narrow-viewport fidelity is covered by the responsive **e2e (TEST-13)** + the visual-regression layer instead.

## Files to touch

New module `src-app/ui/src/modules/analysis/`:
- `module.tsx` — `createModule` (registers store; `dependencies:['study']`; imports the study-extension).
- `study-extension/extension.tsx` — registers `study_nav` + `detail_panels` (ITEM-10).
- `registry.ts` — `AnalysisPlugin` type + `analysisRegistry` + selectors (ITEM-1).
- `types.ts` — `AnalysisCategory`, `InputKind`, `ResultKind`, form/result prop types.
- `analyses/index.ts` — the `import.meta.glob('./*/plugin.tsx')` auto-discovery.
- `analyses/{qc-filter,normalize-lognorm,pca,harmony,leiden,umap,markers-wilcoxon,annotation-reference}/plugin.tsx` (ITEM-2).
- `stores/AnalysisWorkspace.store.ts` — mock engine + state (ITEM-3).
- `mock/umap.ts` — deterministic mock-UMAP + marker data (ITEM-3).
- `components/WorkspacePanel.tsx` (shell host), `ExplorerCanvas.tsx` (ITEM-4), `ColorByControl.tsx`, `ClusterLegend.tsx`, `AnalysesDock.tsx` (ITEM-5), `ContextPanel.tsx` + `AnalysisForm.tsx` + `ResultCard.tsx` (ITEM-6), `AnalysisCatalog.tsx` (ITEM-7), `MarkerTable.tsx` + `GuardrailNote.tsx` (ITEM-8), `SamplesPanel.tsx` (ITEM-9), `ExportMenu.tsx` (ITEM-11).
- `gallery.tsx` (ITEM-12).
- `analysis.testids.ts` (or inline `data-testid`s per the registry convention).

Tests:
- `src-app/ui/src/modules/analysis/registry.test.ts` (unit — availability/recipe/byCategory).
- `src-app/ui/src/modules/analysis/stores/AnalysisWorkspace.store.test.ts` (unit — mock run state machine).
- `src-app/ui/tests/e2e/analysis/*.spec.ts` (e2e — the flows).

No backend / migration / permission / openapi files. (Study backend untouched.)

## Patterns to follow

- **Study extension (FE)** — mirror `src-app/ui/src/modules/dataset/study-extension/extension.tsx` (nav + panels registration) and `components/DatasetsPanel.tsx` (zero-prop panel reading a store). ([[feedback_match_existing_patterns]])
- **Module registration** — mirror `src-app/ui/src/modules/study/module.tsx` (`createModule` with `stores`, `dependencies`, glob import of the extension).
- **Store** — mirror `src-app/ui/src/modules/study/stores/StudyDetail.store.ts` (`defineStore('Name', {state, actions})`, read via `Stores.Name`); here actions mutate mock state instead of calling `ApiClient`.
- **Gallery** — mirror `src-app/ui/src/modules/study/gallery.tsx` (`export const gallery: ModuleGallery`, seed store state per surface × state, lazy components).
- **Kit components** — use `@ziee/kit` only (`Card`, `Button`, `Select`, `Segmented`, `Tabs`, `Sheet`/`Dialog`, `Popover`, `Badge`, `Tag`, `Empty`, `ScrollArea`, `Tooltip`, `Statistic`, `Progress`, `Table`, `SectionHeader`) + shadcn tokens (`bg-card`/`text-muted-foreground`/`border-border`/`border-primary`). No raw hex, no antd. The mockup is the visual reference; translate it to kit primitives.
- **Registry seam** — mirror the study-extension registry shape (register + auto-discovery glob + pure selectors) for `analysisRegistry`, and `docs`/`INTERFACE_DESIGN.md §2` for the descriptor.
- **Canvas** — a self-contained DPR-aware Canvas component (like the mockup's scatter); no new dependency (deck.gl deferred to the data round).

## UI-surface checklist (answers)

- **Precedent:** Workspace/Samples panels ⇄ `DatasetsPanel` (zero-prop, store-reading, `Card`-framed, testid'd); the study section-nav already renders `study_nav` entries. The catalog ⇄ a command-palette `Dialog`/`Sheet`. QC cards ⇄ `Card` grid.
- **Scale/cardinality:** analyses dock ≤ ~12 chips (bounded — the pipeline) → horizontal scroll, no paging needed. Catalog ≤ ~30 analyses (bounded by the registry) → grouped + searched, single render fine. QC cards = #samples (mock: 4; real cap future). Marker table shows top-N (25) not all genes. No unbounded "fetch-all render-all" — data is mock + bounded.
- **Responsive:** Workspace = canvas fills; ContextPanel becomes a bottom `Sheet` under ~820px; dock scrolls; catalog full-width. Samples QC grid 2-col → 1-col. Gallery includes 390px states (ITEM-12). Desktop-only = defect.
- **Populated-render:** every surface has a loaded-with-data gallery state (clustered explorer, mid-run dock, result card, populated QC) — reviewed at both viewports.
- **Progress:** the mock `run()` drives real progress (dock chip → running spinner + the ContextPanel Run→progress) so "what's happening" is visible; not a silent boolean.
- **Input economy:** params are typed kit fields (slider/select/number), never a raw-JSON textarea; defaults pre-filled; the resolution slider has a friendly scale. QC thresholds pre-filled from (mock) adaptive suggestion, editable.
- **Multi-instance:** single instance per study section (not a split-pane feature); state lives in the per-study workspace store keyed by studyId. No pop-out/split this round.
- **URL-as-view:** the section (`Samples`/`Workspace`) is the existing `/studies/:id/:section` URL (study shell owns it); no new URL-focus invariant.
- **Platform affordances:** none platform-specific; no redundant chrome.

## Deferred (explicitly, this round) — see DECISIONS for dispositions
Real upload/`ziee-file`, HDF5 working store + catalog, jobs↔sandbox execution, scientific rootfs, deck.gl +
typed-binary streaming, real statistical methods, real export, new permissions/migrations. The descriptor
`run()`/`ResultView` contract is the seam these land behind.
