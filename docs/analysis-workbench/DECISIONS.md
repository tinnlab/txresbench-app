# DECISIONS — analysis-workflow interface

All inputs resolved up front. Genuine product choices (archetype, shell direction, scope) were already
picked by the user via `AskUserQuestion` (recorded in `LIVE5_QUESTIONS.md`); the rest resolve by
convention/design. Zero open markers.

### DEC-1: Interface-only vs backend this round?
**Resolution:** Interface/UX only — client-side **mock** data; no backend, data model, jobs, migrations, or new permissions.
**Basis:** user — *"we are not designing anything related to data or jobs this round, only interface."*

### DEC-2: Which archetype?
**Resolution:** Candidate **D** — "Guided Pipeline + Explorer" (progressive-disclosure hybrid).
**Basis:** user pick (`LIVE5_QUESTIONS.md` Q1).

### DEC-3: Which shell direction?
**Resolution:** **V2 Explorer-centric** — persistent canvas + analyses dock + collapsible context panel + results overlay + empty-state "Run standard analysis" on-ramp.
**Basis:** user pick (`LIVE5_QUESTIONS.md` round-2).

### DEC-4: Section layout on the study detail page?
**Resolution:** two `study_nav` sections — **`Samples`** (upload + QC) and **`Workspace`** (V2 merges the old Analysis + Explore into one explorer surface).
**Basis:** design — `INTERFACE_DESIGN.md §6`; mirrors the `dataset` extension's single `Datasets` section, extended to two.

### DEC-5: Scatter rendering tech?
**Resolution:** a self-contained **Canvas 2D** mock scatter (deterministic, seeded) this round; **deck.gl deferred** to the data round behind the same `ExplorerCanvas` boundary.
**Basis:** convention/scope — no deck.gl dep in txr yet; a real WebGL/streaming plane is the data round (DATA_STORAGE_REDESIGN). Determinism required for Layer-B snapshot stability.

### DEC-6: Gating — does the analysis surface add a new permission?
**Resolution:** **No new permission.** The surfaces inherit the study's existing gating: run/add/edit affordances are shown only when `study.effective_permission ∈ {owner, editor}` (the `canEdit` pattern in `DatasetsPanel`); a viewer (read-only shared study) sees the explorer + results **read-only** (no Run/Add/Export-write). 
**Basis:** convention — mirrors `DatasetsPanel.tsx` `canEdit`; the hand-off JTBD wants viewers to SEE results. A9/A10 n/a (no new perm).

### DEC-7: Raw-matrix upload?
**Resolution:** a **stubbed drop-zone** — renders the upload affordance (kit `Upload` visual) as **disabled** with honest copy ("Upload wiring lands with the data round"); no file is accepted/parsed.
**Basis:** DEC-1 (interface only); mirrors the dataset backend's `UploadStubResponse` honesty.

### DEC-8: Export actions?
**Resolution:** the Export menu (Figure / Table / AnnData object / Script+methods) renders; **Script** shows a real generated **methods-text preview**; other actions show a "prepared for the data round" toast. Affordance real, execution stubbed.
**Basis:** DEC-1; the affordance + methods-text (from each plugin's `methodsText`) are the interface deliverable.

### DEC-9: Which seed analyses, and the plugin descriptor shape?
**Resolution:** eight — `qc.filter`, `normalize.lognorm`, `dimensionality.pca`, `integration.harmony`, `clustering.leiden`, `embedding.umap`, `markers.wilcoxon`, `annotation.reference`. Descriptor = `INTERFACE_DESIGN.md §2` (`AnalysisPlugin` with category / requires / produces / SimpleForm / AdvancedForm? / ResultView / defaults / methodsText / inStandardRecipe+recipeOrder).
**Basis:** design — spans every category + prerequisites + the recipe; the canonical scRNA-seq spine (research A2).

### DEC-10: Standard-recipe membership + order?
**Resolution:** `inStandardRecipe` = qc.filter(1) → normalize.lognorm(2) → dimensionality.pca(3) → integration.harmony(4) → clustering.leiden(5) → embedding.umap(6). markers/annotation are catalog-only (not auto-run — they need human choices).
**Basis:** research A2 canonical spine; markers/annotation are decision points, not auto-steps.

### DEC-11: Mock run/progress model?
**Resolution:** `run(pluginId, params)` sets the analysis `running`, advances a simulated progress over a short timeout (default ~600ms; **0ms under a `MOCK_INSTANT` test flag** so e2e is fast + deterministic), then sets `done` with a canned, deterministic result. Recipe runs the members sequentially.
**Basis:** convention — the jobs module's SSE progress is the future real path; the mock mimics its shape (queued→running→done) so the data round swaps internals only. Instant-mode mirrors the debug test-seam pattern.

### DEC-12: New module vs extend `dataset`?
**Resolution:** a **new `modules/analysis/`** module (study-extension + stores + gallery); `dataset` stays the raw-file record.
**Basis:** design (`INTERFACE_DESIGN.md §7`); clean `on_study_*` boundary + independent testability; mirrors how `dataset` is its own module.

### DEC-13: Store shape?
**Resolution:** one `defineStore('AnalysisWorkspace', {state, actions})` keyed by the open study; holds run-state map, active-analysis + panel-open, color-by mode/gene, selection. Actions mutate mock state (no `ApiClient`).
**Basis:** convention — mirrors `StudyDetail.store.ts` shape; the ApiClient divergence is DEC-1-justified and keeps the future swap local.

### DEC-14: Responsive breakpoint behavior?
**Resolution:** below ~820px the ContextPanel becomes a bottom `Sheet`; the dock horizontal-scrolls; the QC grid goes 1-col; the canvas fills remaining height. Gallery seeds a 390px state per surface.
**Basis:** convention — the kit `Sheet` + the study shell's `overflow-x-auto` nav idiom; the UI-surface responsive rule.

### DEC-15: Color-by default + gene search?
**Resolution:** default color-by = **Cluster** once a clustering exists, else **Sample**; gene search is a text input against the mock gene set (unknown gene → "no expression" empty overlay, not an error).
**Basis:** convention — cellxgene/Loupe default to cluster; graceful-empty over error (input-economy rule).

### DEC-16: Any operational tunables → settings row?
**Resolution:** **None this round.** Every tunable here is a UI default (QC thresholds, resolution, HVG count) rendered as an editable form field with a sane default — not a server setting. The real admin-configurable settings (resource caps, retention) belong to the deferred data/jobs round and are already patterned by `sandbox_settings`/`jobs_settings`.
**Basis:** configurable-settings rule — no server tunable is introduced by an interface-only round; deferring is explicit, not by omission.

### DEC-17: testid convention?
**Resolution:** stable `data-testid`s per surface (`analysis-workspace`, `analysis-dock`, `analysis-dock-chip-<id>`, `analysis-catalog`, `analysis-catalog-card-<id>`, `analysis-context-panel`, `analysis-advanced-toggle`, `analysis-run`, `analysis-result-card`, `analysis-explorer-canvas`, `analysis-colorby-<mode>`, `analysis-gene-input`, `analysis-marker-table`, `analysis-guardrail-note`, `samples-panel`, `samples-qc-card-<id>`, `samples-upload-stub`, `analysis-export-menu`) driving the e2e specs.
**Basis:** convention — `DatasetsPanel` uses `data-testid`; txr e2e selects by role/testid.
