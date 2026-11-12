# TESTS — analysis-workflow interface

**Convention (match-existing):** txr's frontend has **no unit runner** (no vitest) — its established test
tiers are **e2e (Playwright)** under `src-app/ui/tests/e2e/**` plus `tsc` + `gate:ui` (the gallery
runtime/visual canary, recorded as the A7 boot canary, not a TEST-N). So the pure registry/store logic is
exercised **through the real UI** in e2e (the browser runs `availability()`/`standardRecipe()`/the store
machine) — real-path, external-boundary-only mock ([[feedback_no_cosmetic_tests]]). Each TEST-ID is a
**distinct assertion** (no coverage inflation). **No new permission** → no `[negative-perm]` spec required
(A10 n/a); analysis surfaces inherit the study's existing view/edit gating.

The e2e specs create a study via the existing study API, navigate to `/studies/:id/{samples,workspace}`, and
drive the client-side-mock analysis surface.

- **TEST-1** (tier: e2e) [covers: ITEM-10] file: `src-app/ui/tests/e2e/analysis/navigation.spec.ts` — asserts: opening a study shows the extension's **Samples** and **Workspace** section tabs (registered via `study_nav`), and each routes to its `detail_panels` component.
- **TEST-2** (tier: e2e) [covers: ITEM-4, ITEM-5] file: `src-app/ui/tests/e2e/analysis/workspace.spec.ts` — asserts: an analysis-free Workspace renders the explorer canvas + the empty-state **"Run standard analysis"** CTA in the dock; no result overlay yet.
- **TEST-3** (tier: e2e) [covers: ITEM-1, ITEM-3, ITEM-5] file: `src-app/ui/tests/e2e/analysis/recipe.spec.ts` — asserts: clicking "Run standard analysis" runs the ordered `standardRecipe()`, the **dock chips transition** pending→running→done (the mock store machine), ending with QC/Normalize/Integrate/Cluster done.
- **TEST-4** (tier: e2e) [covers: ITEM-4, ITEM-8] file: `src-app/ui/tests/e2e/analysis/colorby.spec.ts` — asserts: after clustering, the explorer **color-by** switches Cluster→Sample→Gene (typing a gene applies gene coloring without crashing — opaque canvas limits pixel assertions), and the **cluster legend** lists the clusters.
- **TEST-5** (tier: e2e) [covers: ITEM-7, ITEM-1] file: `src-app/ui/tests/e2e/analysis/catalog.spec.ts` — asserts: **Add analysis** opens the catalog with analyses grouped by category; a prerequisite-unmet analysis (e.g. markers) is **dimmed with a `needs: a clustering` chip** while a runnable one is enabled — proving `availability()` gating.
- **TEST-6** (tier: e2e) [covers: ITEM-2] file: `src-app/ui/tests/e2e/analysis/catalog.spec.ts` — asserts: the catalog lists **all eight seed plugins** under their correct categories (QC, Normalization, Dimensionality, Integration, Clustering, Embedding, Markers, Annotation).
- **TEST-7** (tier: e2e) [covers: ITEM-6] file: `src-app/ui/tests/e2e/analysis/disclosure.spec.ts` — asserts: opening an analysis shows the **Simple** form (e.g. Leiden's single resolution control); the **"Advanced parameters"** disclosure reveals the full param set (algorithm/neighbors/PCs/seed) and hides it again — the per-analysis progressive disclosure.
- **TEST-8** (tier: e2e) [covers: ITEM-3, ITEM-6, ITEM-8] file: `src-app/ui/tests/e2e/analysis/result.spec.ts` — asserts: running an analysis from the ContextPanel shows **live progress**, then a **ResultCard** with summary KPIs that expands to params/provenance/methods text, and the canvas reflects the result.
- **TEST-9** (tier: e2e) [covers: ITEM-8] file: `src-app/ui/tests/e2e/analysis/markers.spec.ts` — asserts: running **markers** renders the marker side **table** (top genes) AND the **count-splitting guardrail note** — the statistical-honesty affordance.
- **TEST-10** (tier: e2e) [covers: ITEM-9] file: `src-app/ui/tests/e2e/analysis/samples-qc.spec.ts` — asserts: the **Samples** panel shows per-sample QC cards with adaptive-threshold read-outs + a **before/after** cell-count delta, and a flagged sample shows a **review advisory**; "Apply & continue" routes to Workspace.
- **TEST-11** (tier: e2e) [covers: ITEM-9] file: `src-app/ui/tests/e2e/analysis/samples-qc.spec.ts` — asserts: the upload drop-zone renders as a **stub** ("wiring lands with the data round") and is non-submitting — the honest deferred affordance, not a broken control.
- **TEST-12** (tier: e2e) [covers: ITEM-11] file: `src-app/ui/tests/e2e/analysis/export.spec.ts` — asserts: the **Export** menu lists Figure / Table / AnnData object / Script+methods; choosing Script shows the **methods-text preview**; a stubbed action shows the "will be available in the data round" toast (no crash).
- **TEST-13** (tier: e2e) [covers: ITEM-12] file: `src-app/ui/tests/e2e/analysis/responsive.spec.ts` — asserts: at a **390px** viewport the Workspace has no horizontal page scroll, the ContextPanel collapses to a bottom sheet, and the dock scrolls — responsive fidelity (mirrors ITEM-12's narrow gallery states).
- **TEST-14** (tier: e2e) [covers: ITEM-3, ITEM-6] file: `src-app/ui/tests/e2e/analysis/progress.spec.ts` — asserts: an analysis run (non-instant) shows the live progress bar/running state, then the result card.

**Render/state canary (not a TEST-N, recorded in TEST_RESULTS per A7):** `gate:ui (ui): PASS` — the gallery
runtime-health + Layer-A/axe + Layer-B visual regression over every analysis surface × state (empty /
running / clustered / result / catalog-open / populated-QC) × desktop+390px × light/dark. This is the
per-surface visual DoD (ITEM-12) and the boot/runtime canary. Plus `npm run check (ui): PASS` (tsc).
