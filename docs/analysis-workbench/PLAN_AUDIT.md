# PLAN_AUDIT — analysis-workflow interface (audited against the codebase)

## Breakage risk
Additive, frontend-only. The module adds **new files only** under `modules/analysis/**` and rides the
existing study-extension glob (`modules/*/study-extension/extension.tsx`, verified in
`study/extensions/index.ts:8`) — **no edit to any existing file**, so no existing caller breaks. Risks
identified + mitigations:
- **Store registration without routes** — `study/module.tsx` uses `createModule({routes, stores, …})`.
  Need to confirm `createModule` accepts a module with `stores` but **no `routes`** (the analysis module is
  panel-only, mounted via the study section slot, not the router). Mitigation: `metadata` + `stores` +
  `dependencies` are independent fields; if `routes` is required-non-empty, fall back to registering the
  store the way `dataset` implicitly does (it adds none) — but analysis DOES need its own store, so verify
  at ITEM-10 (cheap `tsc`). **Not a blocker; a to-confirm.**
- **Canvas under `gate:ui` / headless** — `ExplorerCanvas` uses `<canvas>` 2D; headless Chromium supports
  it. Runtime-health checks DOM console/contrast, not canvas pixels; Layer-B visual regression snapshots the
  canvas deterministically (seeded mock generator → stable). Mitigation: deterministic seed (no `Math.random`
  in the draw path) so snapshots don't flake. Folded into ITEM-3/ITEM-4.
- **Section availability** — the Workspace/Samples panels read `Stores.StudyDetail.study`; they render under
  `StudyDetailPage`, which loads the study before rendering panels (verified `StudyDetailPage.tsx`), so the
  study context exists. Empty-study state handled (empty explorer + CTA).
- **e2e needs a real study** — no analysis backend, but the **study** backend is real; the spec creates a
  study via the existing API and navigates to `/studies/:id/workspace`; analysis data is client-side mock.
  Feasible with the existing harness.

## Pattern conformance
- Study-extension FE registration → mirrors `dataset/study-extension/extension.tsx` exactly (nav + panels +
  `export default {}`). ✔
- Panels → zero-prop, store-reading, `Card`-framed, `data-testid`'d, like `DatasetsPanel.tsx`. ✔
- Store → `defineStore('AnalysisWorkspace', {state, actions})` like `StudyDetail.store.ts`; divergence:
  actions mutate mock state instead of `ApiClient` calls (justified — no backend; a DECISION). ✔ (noted)
- Module → `createModule` like `study/module.tsx` (stores + dependencies + extension import). ✔
- Gallery → `export const gallery: ModuleGallery` seeding store state per surface×state like
  `study/gallery.tsx`. ✔
- Kit + tokens → `@txresbench/kit` primitives + shadcn tokens only; no hex/antd. The mockup is the visual source,
  translated to kit. ✔
- `analysisRegistry` → mirrors the study-extension registry shape (register + glob + pure selectors). ✔

## Migration collisions
**None.** No migration added this round (interface-only). Highest existing = `202607190005` (jobs);
untouched.

## OpenAPI regen
**None.** No backend route/type change → `openapi.json` + `api-client/types.ts` unchanged in BOTH `ui/`
and `desktop/ui/`. No `just openapi-regen`. (Excludes this diff from the backend gates by construction.)

## Per-item verdicts
- **ITEM-1** — verdict: PASS — pure TS registry + selectors; mirrors the study-extension registry seam; unit-testable, no framework fight.
- **ITEM-2** — verdict: PASS — plugin descriptors are plain modules auto-discovered by a Vite glob (same mechanism as study extensions); no new dep.
- **ITEM-3** — verdict: CONCERN — store diverges from the `StudyDetail` precedent by holding mock state + a client-side `run()` instead of `ApiClient` calls. Justified by the interface-only scope (DEC-1); keep the `defineStore` shape identical so the data round swaps `run()` internals only. Deterministic mock generator (no RNG in draw) required for snapshot stability.
- **ITEM-4** — verdict: CONCERN — Canvas scatter is a NEW rendering pattern in this app (no deck.gl yet). Self-contained, DPR/resize/reduced-motion-safe, deterministic. Acceptable as the interface-round stand-in; deck.gl is the data-round replacement behind the same component boundary.
- **ITEM-5** — verdict: PASS — dock is kit `Badge`/`Button`/`ScrollArea`; empty-state CTA is a standard `Empty`+`Button`. Mirrors sibling toolbar/rail idioms.
- **ITEM-6** — verdict: PASS — ContextPanel is a kit `Sheet`/panel + `<details>`-style disclosure (kit `Accordion` or a controlled disclosure); AnalysisForm renders the plugin's Simple/Advanced forms; ResultCard mirrors a `Card` + `Statistic`s. Progressive disclosure is the design's core.
- **ITEM-7** — verdict: PASS — catalog is a kit `Dialog`/`Sheet` command-palette; gating computed by the pure `availability()` selector. Bounded set (~30), single render.
- **ITEM-8** — verdict: PASS — result overlays recolor the canvas via the store's color-by/result state; marker table is kit `Table`; guardrail note is an `Alert`. No new mechanism.
- **ITEM-9** — verdict: PASS — Samples panel is a `Card` grid mirroring `DatasetsPanel`; upload is a stubbed drop-zone (kit `Upload` visual, disabled action) — honest "lands with the data round" copy. QC advisories are `Alert`/`Tag`.
- **ITEM-10** — verdict: CONCERN — confirm `createModule` accepts a stores-only, routes-less module (the panel mounts via the study slot, not the router). If not, register the store via the same path the framework exposes; cheap `tsc` check at implementation. Not a blocker.
- **ITEM-11** — verdict: PASS — ExportMenu is a kit `Dropdown`; actions stubbed with a toast + a real methods-text preview. No backend dependency; the affordance is the deliverable.
- **ITEM-12** — verdict: PASS — gallery seeds per surface×state incl. 390px; mirrors `study/gallery.tsx`. `check:state-matrix` will demand a cell per new conditional state — budgeted.

**No BLOCKED verdicts.** Two CONCERNs (ITEM-3, ITEM-4) are scope-justified divergences with named
mitigations; one (ITEM-10) is a cheap to-confirm at implementation. Proceed.
