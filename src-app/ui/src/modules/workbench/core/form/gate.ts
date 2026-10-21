// The WIDGET-VALUE SUBMIT-GATE contract (ITEM-52). A host widget that owns its own live
// validation can embed its verdict in the value it emits; the run panel then disables Run
// with that reason WITHOUT recomputing anything. Domain-agnostic: any widget value that
// declares `{ gate: { canSubmit:false } }` blocks Run.
//
// PROVENANCE: the surviving tail of `core/interaction/summarize.ts`. It lives HERE, beside
// the other widget/params schema types, because it is a WIDGET VALUE contract — it was
// only ever in `interaction/` because the multi-group `summarize` evaluator (deleted with
// the dimension primitives, its sole consumer) happened to derive one.
//
// STANDING NOTE — this contract currently has NO producer in the tree: the four dimension
// primitives that emitted `{gate}` are deleted, and no declarative widget emits one yet.
// It is kept (not deleted) because it is the generic seam `AnalysisRunPanel` gates on and
// removing it is a run-panel behavior change beyond this slice; the next widget that needs
// live submit-gating implements this shape. If none appears, delete this file with
// `selectionSubmitGate`.

/** The submit-gate verdict — `canSubmit=false` disables Run WITH a reason. */
export interface SubmitGate {
  canSubmit: boolean
  reason?: string
}

/** A widget value that embeds its live submit gate so the run panel can disable Run
 *  WITHOUT recomputing anything (the async live eval stays IN the widget, which owns
 *  the data context). */
export interface WidgetGateValue {
  gate?: SubmitGate
}

/** Read an embedded submit gate off an arbitrary widget value (null when absent). */
export function readWidgetGate(value: unknown): SubmitGate | null {
  if (value && typeof value === 'object' && 'gate' in value) {
    const g = (value as WidgetGateValue).gate
    if (g && typeof g === 'object' && typeof g.canSubmit === 'boolean') return g
  }
  return null
}
