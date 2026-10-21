# DRIFT-1 — implementation vs plan (analysis-workflow interface)

Reconciled after Phase-5 implementation (commit `78da802`). Each fork-reported deviation +
independently-verified findings, classified. `tsc` re-verified green by me after the fixes below.

- **DRIFT-1.1** — verdict: impl-wins — **ITEM-12 390px gallery states.** VERIFIED: `@ziee/gallery`'s `SeededSurfaceEntry` (registry/types.ts:62) has no `viewport`/`width` field, so per-surface narrow-viewport is not expressible as a gallery cell. PLAN ITEM-12 amended: 390px is covered by the responsive e2e (TEST-13) + the visual-regression layer. Plan corrected; no code change needed.

- **DRIFT-1.2** — verdict: plan-wins — **inline status hex.** The fork claimed "no semantic success token in cyto's kit" and used inline `#16a34a` for the dock done-dot (AnalysesDock.tsx:96). VERIFIED FALSE: the kit ships semantic `--success`/`--success-foreground`/`--warning` tokens (kit `Tag`/`Alert` tones use `bg-success`/`text-success`). FIXED: the done-dot now uses `bg-success text-success-foreground` (token), no inline hex. (Data-viz cluster colors in `ExplorerCanvas.tsx` + `mock/umap.ts` legitimately stay literal — canvas `fillStyle` needs real colors + it is categorical data encoding, not chrome.)

- **DRIFT-1.3** — verdict: impl-wins — **kit requires `data-testid` on interactive components** (type-enforced across Button/Select/Switch/Tag/Alert/Dropdown/Progress/Input/Segmented). Discovered kit convention (not in PLAN); the fork added testids throughout. This is additive + helps the e2e — accepted; DEC-17 already anticipated a testid scheme, so this is conformant, not a divergence.

- **DRIFT-1.4** — verdict: impl-wins — **kit `Button` `size ∈ {default,lg,icon}`** (no `sm`). The fork dropped `size="sm"`; the panel-close button uses `size="icon"` + `aria-label`. Kit constraint; conformant.

- **DRIFT-1.5** — verdict: none — **TEST-4 (color-by) asserts legend + gene-input value + canvas-visible rather than the internal `colorMode`** (the store isn't readable from the browser in Playwright). This is real-path observation of the same behavior (the user-visible effect of the color-by change), which is exactly what an e2e should assert — not a drift. Flagged for the Phase-6 test-reality angle to confirm the assertion is not hollow.

- **DRIFT-1.6** — verdict: impl-wins — **marker "side table" lives in the markers `ResultView` (context panel) + the cluster legend overlays the canvas**, rather than a permanent explorer side panel. This is the V2 shell composition (results overlay/dock into the explorer; INTERFACE_DESIGN §6) — matches the chosen design, not a divergence from it. TESTS.md TEST-9 asserts the marker table + guardrail note render (wherever composed).

- **DRIFT-1.7** — verdict: none — **`module.tsx` imports the extension** belt-and-suspenders though the study glob also discovers it (ES-module singleton → the `analysisRegistry.register` side-effect runs once). Needed because the module must register its STORE (unlike `dataset`, which adds none). Correct.

- **DRIFT-1.8** — verdict: none — **store holds client-side mock state + a `window.__ANALYSIS_MOCK_INSTANT__` seam**, no ApiClient. Exactly DEC-1/DEC-11/DEC-13. Correct.

**Unresolved drifts:** 0
