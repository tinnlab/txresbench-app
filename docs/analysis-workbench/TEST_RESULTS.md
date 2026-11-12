# TEST_RESULTS — analysis-workflow interface (Phase 8)

## Frontend static + canary gates (workspace: ui)
- `npm run check (ui): PASS` — `tsc --noEmit` clean.
- `gate:ui (ui): PASS` — via `npm run gate:ui -- --skip-visual` (**txr's supported mode** — see the
  visual-harness note below): tsc ✓ · lint (guardrails + colors) ✓ · **runtime-health 15/15 surfaces clean,
  0 gating HIGH findings** (no console error / pageerror / failed request / crash / WCAG-AA contrast failure
  on any analysis surface × state × theme). Log: `/data/pbya/txresbench/tmp/lifecycle-logs/analysis-gateui.log`.

> **Visual-layer note (pre-existing txr gap, not this diff):** the full `npm run gate:ui` (Layer A layout
> invariants + axe + Layer B pixel regression) requires `src-app/ui/playwright.visual.config.ts` +
> `tests/e2e/visual/`, which **do not exist in txr** (absent on `origin/main`; my diff touches no playwright
> config). So `--skip-visual` is the mode txr supports today; runtime-health carries the automated
> a11y-contrast + runtime checks. Flagged as an SDK/app dogfooding gap (SDK_GAPS). The interactive design
> mockup + the e2e specs are the visual evidence this round.

## E2E specs (Playwright, --workers=1; real backend + fresh txresbench_e2e DB)
Full logs: `analysis-e2e.log` (13/14 first pass) + `analysis-e2e-rerun.log` (the 1 selector fix → PASS).
All 14 enumerated tier:e2e tests PASS:

- **TEST-1**: PASS — navigation.spec (Samples + Workspace sections registered via study_nav)
- **TEST-2**: PASS — workspace.spec (empty explorer + "Run standard analysis" CTA)
- **TEST-3**: PASS — recipe.spec (standardRecipe runs; chips reach done)
- **TEST-4**: PASS — colorby.spec (cluster→sample→gene color-by; legend lists clusters)
- **TEST-5**: PASS — catalog.spec (availability() gating both directions)
- **TEST-6**: PASS — catalog.spec (all eight seed plugins by category)
- **TEST-7**: PASS — disclosure.spec (Leiden resolution control + Advanced params)
- **TEST-8**: PASS — result.spec (result card + KPIs + expandable provenance)
- **TEST-9**: PASS — markers.spec (marker table + count-splitting guardrail)
- **TEST-10**: PASS — samples-qc.spec (per-sample QC review + flagged advisory)
- **TEST-11**: PASS — samples-qc.spec (upload drop-zone non-submitting stub; selector fixed to the `[role=button]` dropzone)
- **TEST-12**: PASS — export.spec (export formats + methods-text preview)
- **TEST-13**: PASS — responsive.spec (390px: no x-overflow, bottom-sheet context panel, dock scrolls)
- **TEST-14**: PASS — progress.spec (non-instant run shows live progress then the result card)

## Deterministic Phase-8 checks
- **A2** clean tree — all load-bearing files committed (the one spec selector fix committed this round).
- **A3** no diff-added `.skip`/`.only` (verified). **A4** no cosmetic/always-true asserts (verified).
- **A5** TESTS.md not shrunk (added TEST-14; no TEST-ID removed). **A7** `gate:ui (ui): PASS` recorded above.
- **A8/A9/A10** n/a — no built-in MCP server, no backend, **no new permission** this round (analysis
  surfaces inherit the study's existing view/edit gating; DEC-6).
- No backend diff → backend integration chain n/a.
