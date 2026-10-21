# FIX_ROUND-1 — analysis-workflow interface

## What was fixed (all confirmed Phase-6 findings, commit `60c905b`)
Every confirmed finding in `LEDGER.jsonl` was addressed:
- **a11y (gate-critical):** `aria-label` on the range slider + Select/InputNumber/Switch (shared.tsx), the
  gene input + Segmented (ColorByControl), the dock chip status word in `aria-label` + `aria-hidden` icon,
  and a dynamic canvas `aria-label`. Removed a nested-interactive Button (Upload) that risked an axe fail.
- **correctness:** legend counts now from a pure module-eval `CLUSTER_COUNTS` (not a canvas side-effect — was
  0 for every cluster, breaking the clustered snapshot); dock now gates non-runnable chips + `run()` guards
  prerequisites; gene-not-found shows an inline hint (`role=status`) and no longer fades the plot; catalog
  gained a no-results `Empty` + the misleading "trajectory" placeholder replaced.
- **state:** `finish()` no longer clobbers a user's explicit color-by (`colorByUserSet` latch, reset per
  study); `geneDraft` syncs to `colorBy.gene`; `setParams` refactored to remove the nested `set()`.
- **affordance-parity:** kit `Table` (MarkerTable), `Statistic` (ResultCard KPIs), `Upload` (Samples stub),
  and the kit `useIsMobile` hook now used instead of hand-rolled versions.
- **design/responsive:** ContextPanel `hideChrome` prop removes the mobile Sheet's duplicated header/close +
  desktop-only `border-l`; narrow-viewport controls stack + the legend hides on mobile.
- **copy:** softened three mock-implying strings to honest interface-preview wording.
- **polish:** removed the redundant window resize listener + added canvas geometry guards; footer count
  derived from the sample array.
- **tests strengthened (honesty):** new **TEST-14** non-instant progress spec (the previously-uncovered
  visible-progress path); disclosure spec now opens **Leiden** + asserts the resolution control + a named
  advanced field; result spec asserts the KPIs; TEST-3 vocabulary (`pending→running→done`) + TEST-4 wording
  corrected; samples-qc TEST-11 adapted to the kit Upload.

## Re-audit (full blind round, 2 fresh angle-clusters over the fix diff)
- **Cluster A (correctness / Rules-of-Hooks / state / a11y):** 0 new HIGH/MEDIUM. Verified: recipe still
  runs in order under the new guard; `colorByUserSet` never stuck + auto-colors on first clustering + resets
  on study switch; `setParams` loses no updates; `CLUSTER_COUNTS` matches the scatter + non-zero at first
  render; gene lookup case-insensitive; **0 Rules-of-Hooks violations** (the dock `.map` reads only the
  top-level snapshot); added aria-labels correct on the real controls; all four original a11y findings
  RESOLVED.
- **Cluster B (kit-reuse / test-reality / selector-staleness):** 0 new HIGH/MEDIUM. kit `Table`/`Statistic`/
  `Upload` used per their real APIs with no lost functionality (Upload genuinely disabled/non-submitting);
  the new/changed specs assert their claims against **real testids** (progress spec forces the 650ms timed
  path — not a race; disclosure opens Leiden; result asserts KPIs; responsive asserts dock scroll on the
  populated overflow-x branch); **no stale/no-op selectors** (the preserved `analysis-marker-table` outer
  testid keeps TEST-9 valid).

## Low/cosmetic notes — dispositioned (not defects)
- `useIsMobile` 820→768 breakpoint shift: **accepted** — deliberate consequence of reusing the kit-standard
  hook (finding #15); the 390px responsive e2e passes; DEC-14's ~820 was approximate.
- unused `clusterCounts()` accessor + a stale "gene demo" comment: **accepted** — harmless (a benign public
  accessor + a cosmetic comment); not worth churn at convergence.

**New confirmed findings:** 0
