/**
 * Documented runtime-health BASELINE (`gallery.config.json` → `runtimeBaselineModule`).
 *
 * `runtime-health.mjs` treats every console-error / page-error on a gallery surface as a
 * gating HIGH — correct by default, because a surface that logs an error usually IS broken.
 * But two of the declarative-engine fixtures exist SPECIFICALLY to drive a failure path
 * (declarative-rendering-hardening Slice 3): they would be worthless if they did not fail.
 * Baselining them here is the framework's designed seam for that — the findings are STILL
 * emitted to `RUNTIME_FINDINGS.jsonl` and listed in a dedicated rollup, so this is an
 * auditable subtraction, never a silent mute.
 *
 * Deliberately NARROW. It is scoped to two specific surfaces, matches only the two console
 * categories, and NEVER matches the `crash` category — an `AppErrorBoundary` crash still
 * gates every surface, including these.
 *
 * If you add a fixture here, state (a) WHICH surface, (b) WHY the log is expected by design,
 * and (c) what would still gate. Anything you cannot answer is a real defect, not a baseline.
 */

/** Surfaces whose whole purpose is to exercise a failure path. */
const DELIBERATE_FAILURE_SURFACES = new Set([
  // The resolver REJECTS (the fake host throws 503). `viewData.readSliceFromApi` logs the
  // failure for developer diagnosis and returns an `error` status, which the region renders
  // as its retryable alert — that alert IS the thing under test (INV-1). Still gating here:
  // an ErrorBoundary crash, a contrast failure, a missing accessible name, a failed request.
  'declarative-error-data-narrow',
  'declarative-error-data-wide',
  // A widget with a deliberately invalid `for_each` clause throws at render. React logs the
  // caught error and `WidgetErrorBoundary.componentDidCatch` logs `[declarative] widget
  // render failed` — the isolation + the NAMED, retryable placeholder are what is under test
  // (INV-4). Still gating here: a crash that escapes the per-widget boundary (which is
  // exactly the regression this fixture would catch), contrast, a11y names, requests.
  'declarative-malformed-widget-narrow',
  'declarative-malformed-widget-wide',
])

// ONLY the console channel. `page-error` (an UNCAUGHT exception) still gates on every
// surface — that is precisely the signal a removed/broken `WidgetErrorBoundary` would emit,
// and baselining it would blind the malformed-widget fixture to its own regression.
const CONSOLE_CATEGORIES = new Set(['console-error'])

export function isRuntimeBaselined(finding) {
  if (!finding || !DELIBERATE_FAILURE_SURFACES.has(finding.surface)) return false
  // `crash` (an AppErrorBoundary trip) is NEVER baselined, on any surface.
  return CONSOLE_CATEGORIES.has(finding.category)
}
