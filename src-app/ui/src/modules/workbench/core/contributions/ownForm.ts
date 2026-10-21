// Does an analysis OWN its form? (INV-2 / INV-3 / INV-4)
//
// One predicate, three consumers, because three surfaces have to agree and a copied
// `(a.ui?.length ?? 0) > 0` is exactly the drift this round exists to remove:
//   · `AnalysisRunPanel`  — refuses to synthesize a rival slot-only form (the CONSTRUCTION
//     site, so every host of that panel is covered at once).
//   · `analysis.launch`   — reveals the analysis' OWN pane instead of opening a run pane
//     beside it (`project-extension/WorkbenchSection.tsx`).
//   · `inputEconomy.ts`   — `fallbackParamsFor`'s contract is stated against it.
//
// ── Why the run pane may not offer its own form for such an analysis ──────────────────
//
// The fallback form is synthesized from `appliesTo` ALONE (`fallbackParamsFor`), and
// `appliesTo` is an APPLICABILITY fact, not an input list. A view legitimately declares
// inputs the manifest cannot express, because their option set does not exist until an
// earlier control has a value — a sibling artifact on an axis of the artifact the user just
// picked is the shipped shape. Those inputs are absent from the fallback form, so a Run from
// it dispatches with them UNSET while the surface shows a complete-looking form.
//
// Unset is not the same as failed. Where the compute reads a missing optional input as an
// empty match set, the job completes, emits its columns, and reports zeros — no error
// anywhere, on a run the user believes they configured. That is precisely what INV-4 ("what
// is launched is what was shown") forbids, and it was reachable from the launcher through a
// surface nobody looked at.
//
// It is also the design doc's own opening symptom, still standing: "Two forms, two panes, one
// analysis … the same primary-button label, and the input is visible only in the pane they
// would never open." The `layout.regions` half of that fan was removed; this half was not.
//
// ── Why the DECLARATION, and not "a view actually registered" ─────────────────────────
//
// `registerDeclarativeViews` is fail-CLOSED at the analysis: if any file in `ui:` is missing
// or unparseable, NOTHING is registered for it ("half a form is not a form"), while the
// ANALYSIS itself still registers. Keying this predicate on registration would hand exactly
// that broken case back to the slot-only form — the same invisible-input failure, one step
// later. So a declared-but-unloadable view means the analysis is not runnable, and it must
// READ not-runnable rather than quietly run something else. (The panel still consults the
// REGISTRY to decide whether it can offer to reveal the pane: pointing at a pane that does
// not exist would be a lie, and the two states have different remedies.)

import type { AnalysisContribution } from './types.ts'

/**
 * True when this analysis declares at least one view FILE — i.e. it ships its own form, and
 * that form is the only surface entitled to launch it.
 *
 * The unit is a declared FILE, never the presence of the key: `ui: []` registers no pane
 * (`loadProcessors` skips an empty list), so such an analysis genuinely has no form of its
 * own and the generic fallback is its honest surface (ITEM-4).
 */
export function analysisOwnsItsForm(analysis: Pick<AnalysisContribution, 'ui'>): boolean {
  return (analysis.ui?.length ?? 0) > 0
}
