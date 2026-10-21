# Analysis Workflow — INTERFACE DESIGN (Candidate D, interface-only round)

**Scope (user):** *interface / UX only* — no data model, no jobs, no backend this round. Mock/stub data.
**Target:** Candidate **D** — "Guided Pipeline + Explorer" (progressive-disclosure hybrid).
**The crux (user):** *"tens of analyses will plug in — design it so it is UX-friendly for a biologist but
has all the advanced stuff if they need it."*

So the real deliverable is **an extensible analysis-interface FRAMEWORK**: a UI plugin registry where
每 analysis declares a *simple* surface + an *advanced* surface + a *result* view, and a
**progressive-disclosure shell** renders them so the biologist sees a clean guided path while the power
user can reach every parameter. This doc defines that framework; the companion visual mockup shows it.

---

## 1. Design principles (from the research → concrete UI rules)

1. **Progressive disclosure is the wedge, at THREE levels.** (a) *Navigation*: a guided "Standard analysis"
   path is front-and-center; the full analysis catalog is one click away, never in the biologist's face.
   (b) *Per-analysis*: every analysis opens in **Simple** mode (0–2 knobs + a big Run); an "Advanced
   parameters" disclosure reveals the full param set. (c) *Result*: a result is a plain-language **summary
   card** that expands to full params + provenance + method text.
2. **The catalog scales to tens of analyses without cluttering** — analyses are grouped by **category**
   (QC · Normalization · Dimensionality · Integration · Clustering · Markers/DE · Annotation · Trajectory ·
   Enrichment · Export · …), searchable, and **prerequisite-gated** (an analysis that needs an embedding is
   visibly locked with "needs: an embedding" until one exists). Adding the 30th analysis = one registry
   entry; it lands in its category, gated by its inputs — the biologist path is unchanged.
3. **One canonical spine, offered as a recipe.** The shell knows the standard order (QC → normalize → HVG →
   PCA → [integrate] → cluster → UMAP → markers). The biologist clicks **"Run standard analysis"** and
   watches it flow; they never assemble it by hand.
4. **The Explorer is the destination, always one glance away.** A persistent WebGL UMAP the user returns to
   after every analysis; analyses drop new **color-by** layers (cluster/gene/metadata) and result cards
   next to it.
5. **Keep users honest, visibly.** QC shows a **before/after diff** + "you may have removed cell type X";
   DE surfaces a **guardrail note** (count-split for markers, pseudobulk for cross-condition); over-cluster/
   over-integration flags appear as inline advisories — never as blocking modals.
6. **Nothing is a dead end.** Every result offers **Export** (figure / table / object / script + methods
   text). Every study is **shareable read-only** (reuses the existing study share).
7. **On-system only.** Built from `@ziee/kit` (shadcn/Tailwind-v4) + shadcn tokens
   (`bg-card`/`text-muted-foreground`/`border-border`/`border-primary`) — no invented tokens, no raw hex.
   Plugs into the study shell as `study_nav` sections + `detail_panels` (like `dataset`).

---

## 2. The extensible **Analysis-Plugin** contract (the framework)

The heart of the round. Each analysis is a **UI descriptor** registered into an app-side registry (the
frontend analog of the study-extension registry). *This round it is a pure-frontend registry over mock
data; a future round wires each descriptor's `run()` to a real job.*

```ts
type AnalysisCategory =
  | 'qc' | 'normalization' | 'dimensionality' | 'integration'
  | 'clustering' | 'markers' | 'annotation' | 'trajectory' | 'enrichment' | 'export'

// What an analysis needs to exist before it can run (drives catalog gating).
type InputKind = 'samples' | 'qc' | 'normalized' | 'embedding' | 'clustering' | 'markers'

// What it produces (drives how the result renders + what it unlocks downstream).
type ResultKind =
  | 'qc-report' | 'normalized' | 'embedding' | 'clustering'
  | 'de-table' | 'annotation' | 'trajectory' | 'enrichment' | 'plot'

interface AnalysisPlugin<P = Record<string, unknown>> {
  id: string                       // 'clustering.leiden'
  name: string                     // 'Leiden clustering'
  category: AnalysisCategory
  summary: string                  // one plain-language line for the catalog card
  requires: InputKind[]            // e.g. ['embedding'] → gated until an embedding exists
  produces: ResultKind             // e.g. 'clustering'
  inStandardRecipe?: boolean       // part of the biologist "Run standard analysis" spine?
  recipeOrder?: number             // position in the spine

  defaults: P                      // sane biologist defaults
  SimpleForm: FC<AnalysisFormProps<P>>   // 0–2 knobs + Run (biologist)
  AdvancedForm?: FC<AnalysisFormProps<P>>// full param set (power) — shown under a disclosure
  ResultView: FC<AnalysisResultProps>    // renders the produced result (card/plot/table/explorer layer)
  methodsText?: (p: P) => string   // for the generated methods paragraph + provenance
}
```

**Why this shape:**
- `requires`/`produces` make the catalog **self-organizing + safe** — the shell computes availability, so
  the biologist can't run DE before clustering; the power user sees exactly what's blocking.
- `SimpleForm` + optional `AdvancedForm` **is** the per-analysis progressive disclosure; if an analysis has
  no advanced knobs it simply omits `AdvancedForm`.
- `inStandardRecipe` lets the shell assemble the guided path automatically from whichever plugins opt in —
  so the "standard analysis" stays correct as plugins are added/removed, no central list to edit.
- `ResultView` + `methodsText` give the result card + the reproducibility/export story a uniform hook.

**Registry** (mirrors `studyExtensionRegistry`): `analysisRegistry.register(plugin)`; auto-discovered by an
`import.meta.glob('../../analyses/*/plugin.tsx')`. Adding an analysis = drop a folder; **zero shell edits.**
Seed set this round (mock): `qc.filter`, `normalize.lognorm`, `dimensionality.pca`, `integration.harmony`,
`clustering.leiden`, `embedding.umap`, `markers.wilcoxon`, `annotation.reference` — enough to prove the
framework spans categories + prerequisites + the recipe.

---

## 3. The shell — layout & flow

The Analysis workflow occupies the study detail page as **study_nav sections** (one extension, three
sections) so it reads as one workspace:

- **`Samples`** — upload + per-sample QC review (the entry point).
- **`Analysis`** — the plugin workspace (guided recipe + catalog + run timeline + result cards).
- **`Explore`** — the persistent WebGL explorer.

*(Alternative: a single "Analysis" section with internal tabs — see the variants in §6/the mockup.)*

### 3.1 `Analysis` section anatomy (the core surface)
```
┌ Analysis ─────────────────────────────────────────────────────────────────┐
│ [ Run standard analysis ▸ ]   ·   [ + Add analysis ]        [ Export ▾ ]   │  ← guided vs catalog vs export
├──────────────┬─────────────────────────────────────────────────────────────┤
│ RUN TIMELINE │  WORKSPACE                                                    │
│ (vertical    │  · active analysis panel (Simple ⟷ Advanced) with Run        │
│  stepper)    │    OR                                                         │
│  ✓ QC        │  · result card of the last-run analysis (summary → expand)   │
│  ✓ Normalize │    with a mini-explorer preview + "Open in Explorer"          │
│  ✓ Cluster   │                                                               │
│  ● UMAP …    │  Guardrail advisories render inline here.                     │
│  + add       │                                                               │
└──────────────┴─────────────────────────────────────────────────────────────┘
```
- **Run timeline** (left): the study's analyses in run order — each a compact row (icon, name, status,
  key param e.g. "res 0.5"). Click to view its result; a **stale** badge appears if an upstream change
  invalidates it. A "**+**" opens the catalog. This is also the branch/compare anchor (a run can fork).
- **Workspace** (center): either the **active analysis form** (when adding/editing) or the **result card**
  (when viewing). The form is Simple by default with an **"Advanced parameters"** accordion.
- **Header**: `Run standard analysis` (guided spine, biologist) · `+ Add analysis` (catalog, power) ·
  `Export` (figure/table/object/script).

### 3.2 The catalog (`+ Add analysis`) — the "tens of analyses" surface
A command-palette-style sheet: search box + **category sections**; each analysis is a card (name, one-line
summary, a `needs: …` chip when gated). Gated cards are dimmed with the missing prerequisite; runnable ones
are bright. This is what keeps 30+ analyses navigable and keeps the biologist path uncluttered (they rarely
open it — they use the recipe).

### 3.3 Progressive disclosure of a single analysis (e.g. Leiden)
- **Simple:** one **resolution** slider (with a friendly "fewer ↔ more clusters" scale) + **Run**. A muted
  "Advanced parameters" link.
- **Advanced (disclosed):** algorithm (Leiden/Louvain), n_neighbors, n_pcs, random_state, flavor, use_rep —
  each a labeled kit `Field`. The Simple knob stays pinned at top so context isn't lost.

### 3.4 QC review (`Samples`)
Per-sample cards, each: violin/knee thumbnails, the **auto-suggested adaptive-MAD thresholds** pre-filled
(editable), a **before/after** cell-count delta, and advisory chips ("sample 3: 3× median %mito",
"you may have removed a low-RNA population"). A global "Apply & continue."

### 3.5 Explorer (`Explore`)
Persistent WebGL UMAP (mock scatter this round), a **color-by** control (cluster / gene search / metadata),
a **marker table** side panel, lasso-select → "create cell set", and a legend. Every analysis that produces
a colorable layer adds an option here. (Deck.gl + the typed-binary stream are a *future* round; this round
renders a mock scatter to prove the UX.)

---

## 4. How progressive disclosure serves both personas (walkthroughs)

**Biologist:** open study → `Samples` (thresholds pre-filled, "looks fine", Apply) → `Analysis` → **Run
standard analysis** (watches QC→normalize→cluster→UMAP tick green) → `Explore` (colors by cluster, searches
a gene, sees markers) → annotate (accepts suggested labels) → Export figure. **No parameter ever forced.**

**Bioinformatician:** `Analysis` → **+ Add analysis** → picks Harmony integration → opens **Advanced**, sets
θ + n_pcs → Run → adds Leiden, opens Advanced, sweeps resolution via **branch run** to compare 0.4/0.8/1.2
side-by-side → runs Wilcoxon markers, reads the **count-split guardrail** note → Export **script + methods
paragraph + `.h5ad`**. **Every knob reachable; nothing hidden behind a "pro" wall.**

---

## 5. Mock-data strategy (interface-only)

Because backend is out of scope, the interface runs on a **mock analysis engine**: `analysisRegistry`
plugins' `run()` return canned results after a short simulated delay (so progress/timeline animation is
real); the Explorer renders a static/generated mock UMAP; catalog gating is computed from a mock run-state
store. This is exactly the **component-gallery cassette** model the repo already uses, so the whole surface
renders in the gallery + passes `gate:ui` with no server. When the backend round lands, each `run()` swaps
to a real job with no shell change — the descriptor's contract is the seam.

---

## 6. Shell direction — **CHOSEN: V2 Explorer-centric** ✅

The archetype (D) and the plugin framework are fixed; the **shell metaphor** was the open call. Three
directions were mocked on-system (V1 Timeline+Workspace · V2 Explorer-centric · V3 Recipe+Library).
**The user chose V2 — Explorer-centric.** So the analysis surface is built around the explorer:

### V2 shell anatomy (what we build)
```
┌ Workspace (the study's analysis surface) ─────────────────────────────────┐
│  ╭─ floating: [Color by ▸ Cluster · Sample · Gene: MS4A1]  [Export ▾]      │
│  │                                                                          │
│  │            WebGL UMAP — the PERSISTENT full-bleed canvas                 │
│  │      (analysis results OVERLAY here: clustering colors the points,       │
│  │       a gene colors by expression, markers highlight, QC dims removed)   │
│  │                                                       ╭──────────────╮   │
│  │                                                       │ CONTEXT PANEL│   │
│  │                                                       │ active form  │   │
│  │                                                       │ (Simple⟷Adv) │   │
│  │                                                       │  or result   │   │
│  │                                                       ╰──────────────╯   │
│  ├──────────────────────── ANALYSES DOCK ─────────────────────────────────┤
│  │ [✓ QC] [✓ Normalize] [✓ Integrate] [● Cluster] [Markers] [ + Add ]      │  ← the pipeline, as a dock
│  └──────────────────────────────────────────────────────────────────────── │
└────────────────────────────────────────────────────────────────────────────┘
```
- **Canvas = the destination, always present.** The WebGL scatter (deck.gl in a future round; a mock
  Canvas scatter this round) fills the workspace. Every analysis result **overlays** it: clustering →
  point colors; gene → expression gradient; QC → before/after dim; markers → highlight + side table.
- **Analyses dock** (bottom rail): the run's analyses as compact status chips (done ✓ / active ● / stale),
  left→right in pipeline order, ending in **`+ Add analysis`** (opens the catalog). The dock is the
  pipeline made ambient — you see status without leaving the canvas.
- **Context panel** (right, collapsible): when you pick/add an analysis, its **form** (Simple⟷Advanced,
  §3.3) slides in here; after a run it becomes the **result** summary (expand → params/provenance). Close
  it and the canvas is full-bleed for pure exploration.
- **Floating controls** (top-left of canvas): **color-by** (cluster / sample / gene search), lasso →
  create cell set, legend. **Export** top-right.
- **Guided on-ramp preserved:** a **"Run standard analysis"** action (in the dock's empty state / a canvas
  CTA when no analyses exist yet) chains the recipe so a biologist reaches a colored UMAP in one click —
  V2 keeps the biologist path via the empty-state CTA rather than a separate recipe surface.
- **Samples/QC** stays a distinct entry (upload + per-sample QC review, §3.4) — the gate before the
  explorer has cells to show; QC's result also overlays the canvas (removed cells dimmed).

**Section layout:** two `study_nav` sections — **`Samples`** (upload + QC review) and **`Workspace`**
(the explorer-centric analysis surface; V2 merges the old "Analysis" + "Explore" into one). *(The V1
timeline/workspace and V3 recipe/library takes are retired; the mockup keeps them for provenance.)*

**Unchanged from the framework:** the `AnalysisPlugin` contract (§2), the `analysisRegistry`, the
three-level progressive disclosure (§1·1), the catalog (§3.2), QC review (§3.4), mock-data engine (§5),
and the study-extension plug-in points (§7) — V2 only changes the shell that hosts them.

---

## 7. Plug-in points (on-system, this round)
- Frontend study extension `modules/analysis/study-extension/extension.tsx` → registers `study_nav`
  (`Samples`/`Analysis`/`Explore`) + `detail_panels` (mirrors `dataset`'s extension).
- New `modules/analysis/` with: `registry.ts` (the `analysisRegistry`), `analyses/*/plugin.tsx` (the seed
  plugins), `components/` (shell: `AnalysisWorkspace`, `RunTimeline`, `AnalysisCatalog`, `AnalysisForm`,
  `ResultCard`, `QcReview`, `Explorer`), `stores/` (mock run-state + selection), `gallery.tsx` (renders
  every surface × state for `gate:ui`).
- No backend, no migrations, no permissions changes this round (all deferred).

---

## 8. What this round delivers vs defers
**Delivers (interface):** the analysis-plugin framework + registry, the shell (timeline + workspace +
catalog + progressive disclosure), QC review, a mock Explorer, result cards + export affordances, the
guided recipe, the gallery coverage + `gate:ui` green — all on mock data.
**Defers (future rounds):** real upload/`ziee-file`, the kind-typed HDF5 working store + catalog, jobs↔
sandbox execution, the scientific rootfs, deck.gl + typed-binary streaming, real statistical methods. The
descriptor `run()`/`ResultView` contract is the seam those land behind.
