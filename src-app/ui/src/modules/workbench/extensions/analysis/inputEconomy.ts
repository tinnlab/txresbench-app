// Input economy (ITEM-21) — the "don't make the user re-pick the obvious"
// helpers the run config uses: auto-pick the SOLE compatible artifact for an input,
// summarize inputs → produces, and gate Run with a reason when a required input is
// unmet. Pure — the run pane wires them to `SchemaForm`'s value + the picker's
// resolved artifacts; the unit test drives them directly. NONE of these edit
// `SchemaForm` (a concurrent agent owns `form/`); they operate on the params object
// + the analysis descriptor.

import {
  artifactRefFields,
  readWidgetGate,
  type AnalysisContribution,
  type ArtifactRefField,
  type TypeSelector,
  type ParamsSchema,
  type BindingOrigin,
} from '@/modules/workbench/core'

/** The REQUIRED artifact-ref inputs of an analysis. A SINGLE-value input defaults to
 *  required (the common "the analysis needs one input" case) unless it opts out with
 *  `required:false`; a MULTIPLE input defaults to optional (a 0-or-more reference set)
 *  unless it opts in with `required:true`. */
export function requiredArtifactRefFields(analysis: AnalysisContribution): TypeSelector[] {
  // Every `appliesTo` selector with a slot is a required input — the whole point of the
  // key (DEC-5). The old default-by-cardinality rule ("single ⇒ required unless it opts
  // out, multiple ⇒ optional unless it opts in") went with `params.fields`: a form field
  // could be optional, an applicability condition cannot. A MULTIPLE slot is still
  // 0-or-more at launch; it is required in the sense that the analysis is not offered
  // without a compatible artifact for it.
  return (analysis.appliesTo ?? []).filter(sel => !!sel.slot)
}

/**
 * Auto-pick the SOLE compatible artifact for each UNSET single-value artifact-ref
 * field (ITEM-21). `artifactsByField` maps a field id → the compatible artifacts the
 * picker already resolved (project-scoped, type-filtered). Returns only the fields
 * newly set — a params patch to merge — so an already-chosen or ambiguous
 * (>1 option) field is never overwritten.
 *
 * ITEM-13 — it also REPORTS which slots it bound (`autoBound`), rather than leaving the
 * caller to work that out from the patch. The two are the same set here by construction,
 * and that is exactly the point: the caller records `'auto'` for what this function says
 * it did, so the origin map and the params it accompanies cannot come to disagree the
 * moment either side's rules change (a re-derivation is a second implementation of the
 * pick rules, kept in step by hand).
 */
export function autoPickSoleArtifacts(
  analysis: AnalysisContribution,
  params: Record<string, unknown>,
  artifactsByField: Record<string, { id: string }[]>,
): { patch: Record<string, string>; autoBound: string[] } {
  const patch: Record<string, string> = {}
  for (const field of (analysis.appliesTo ?? []).filter(s => !!s.slot)) {
    if (field.multiple) continue // auto-pick only single-value inputs (never a multi-select)
    // ITEM-29f — DECLARED, or not at all (R2 / INV-3, DEC-15).
    //
    // This site had no UI at all: the patch goes straight into `params` from a MOUNT effect,
    // and `runGate` then reports the form READY — so a run could launch on a binding nobody
    // ever looked at. The widget at least rendered a sentence. Under R2 a sole candidate may be
    // bound only where the analysis declared it, and here that is the whole of the rule, since
    // "show what it bound" has no surface to happen on.
    if (field.auto_bind_sole_candidate !== true) continue
    const current = params[field.slot!]
    if (typeof current === 'string' && current) continue // already chosen
    const options = artifactsByField[field.slot!] ?? []
    if (options.length === 1) patch[field.slot!] = options[0].id
  }
  return { patch, autoBound: Object.keys(patch) }
}

/** The produced-datatype summary for the "inputs → produces" line (deduped). */
export function producesSummary(analysis: AnalysisContribution): string[] {
  return [...new Set(analysis.produces ?? [])]
}

/** The inputs summary — each artifact-ref field + its currently-selected artifact id
 *  (the left side of the "inputs → produces" line).
 *
 *  ITEM-16 — each entry also carries HOW its binding was chosen, read from the caller's
 *  per-slot `origins` map, so the summary line can mark the inputs nobody reviewed. This
 *  is the SECOND surface R8 asks for: a mark rendered only on the control is a mark the
 *  reader loses the moment they look away from it.
 *
 *  `origins` is optional and is read, never inferred: called without it every entry's
 *  `origin` is `undefined` and the output is byte-identical to before (INV-4 — an absent
 *  origin is absent, not `'user'`). */
export function inputsSummary(
  analysis: AnalysisContribution,
  params: Record<string, unknown>,
  origins?: Record<string, BindingOrigin>,
): { field: string; label: string; artifactId?: string; origin?: BindingOrigin }[] {
  return (analysis.appliesTo ?? [])
    .filter(sel => !!sel.slot)
    .map(sel => {
      const v = params[sel.slot!]
      const artifactId = typeof v === 'string' && v ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined
      // The label is the SLOT name. A `title` was presentation the manifest no longer
      // carries (INV-1); a view that wants a nicer word puts it on its own control.
      return { field: sel.slot!, label: sel.slot!, artifactId, origin: origins?.[sel.slot!] }
    })
}

/** Whether Run should be disabled + WHY (ITEM-21 / ITEM-52) — a required artifact-ref
 *  input with no selection blocks the run; the reason names the missing input(s). A
 *  fully-satisfied form returns `{ disabled: false }`. (Viewer-gating is separate:
 *  viewers don't see Run at all — see the panel's `canEdit` check.)
 *
 *  `isVisible` (ITEM-36 seam) — when a conditional (`when`) schema hides a required
 *  field, that field must NOT block Run (it's excluded from the submitted params by
 *  `pruneHiddenParams`, so gating on it would strand the form un-runnable). The host
 *  passes the SAME visibility predicate `SchemaForm` renders with; omitted ⇒ every
 *  field is visible (a flat/non-conditional schema — byte-identical to before). */
export function runGate(
  analysis: AnalysisContribution,
  params: Record<string, unknown>,
  isVisible?: (fieldId: string) => boolean,
): { disabled: boolean; reason?: string } {
  const unmet = requiredArtifactRefFields(analysis)
    .filter(sel => (isVisible ? isVisible(sel.slot!) : true))
    .filter(sel => {
      const v = params[sel.slot!]
      if (Array.isArray(v)) return v.length === 0
      return typeof v !== 'string' || v === ''
    })
  if (unmet.length > 0) {
    // The SLOT name — a `title` was presentation the manifest no longer carries.
    return { disabled: true, reason: `Select ${unmet.map(sel => sel.slot!).join(', ')}` }
  }
  return { disabled: false }
}

// ─── ITEM-52 — live selection submit-gating (a pure helper the run panel consumes) ───

/**
 * The selection half of the run gate (ITEM-52): a host widget that owns its own live
 * validation embeds a `{ gate: { canSubmit, reason } }` in its emitted value. This scans the
 * params for the FIRST invalid embedded gate and disables Run with its reason — so the Run
 * button reflects the widget's verdict live, without the panel recomputing anything.
 * Domain-agnostic: any widget value declaring `canSubmit:false` blocks Run. A form with
 * no gate-bearing widget → `{ disabled: false }`.
 *
 * PRODUCER-LESS as of ITEM-39: the four dimension primitives that emitted a gate (from their
 * `summarize` validity) are deleted, and no declarative widget emits one yet — so this always
 * returns `{disabled:false}` today. Kept as the generic seam (deleting it is a run-panel
 * behavior change); see the standing note on `core/form/gate.ts`.
 *
 * `isVisible` (ITEM-36 seam) — mirrors `runGate`: a conditionally-HIDDEN selection widget
 * whose STALE value still carries `canSubmit:false` must NOT strand Run (its value is
 * dropped from the submitted params by `pruneHiddenParams`, so gating on it is a phantom
 * block). The host passes the SAME visibility predicate `SchemaForm` renders with;
 * omitted ⇒ every field is visible (a flat/code schema — byte-identical to before).
 */
export function selectionSubmitGate(
  params: Record<string, unknown>,
  isVisible?: (fieldId: string) => boolean,
): { disabled: boolean; reason?: string } {
  for (const [id, v] of Object.entries(params)) {
    if (isVisible && !isVisible(id)) continue // hidden field's gate is pruned on submit — don't block on it
    const gate = readWidgetGate(v)
    if (gate && !gate.canSubmit) return { disabled: true, reason: gate.reason ?? 'Selection is not valid for a run' }
  }
  return { disabled: false }
}

// ─── ITEM-64 — data-driven defaults: REMOVED, not stubbed ────────────────────────
//
// `summaryColumnRefs` / `dataDrivenDefaultPatch` and their private
// `numberFieldsWithResolver` lived here. They read `params.fields[].defaultResolver` — a
// JS FUNCTION on a form field — and `params` left `AnalysisContribution` with the rest of
// the form schema (INV-1). A resolver was never representable in the YAML a manifest
// actually is (the loader could only ever have carried a string), so nothing could declare
// one any more and `numberFieldsWithResolver` had been reduced to a literal `return []`.
//
// That made both exports EMPTY BY CONSTRUCTION for every input, and the run panel's
// effect short-circuited on `refs.length === 0` before touching a byte — so the panel was
// calling two helpers to be told nothing, forever. A function that exists only to return
// nothing is worse than an absent one: the caller reads as though it asked a question and
// got an answer. Removed with its call site rather than left as a stub.
//
// Nothing that mattered is lost. The resolver ARITHMETIC survives on the primitives in
// `core/form/defaults.ts` (covered by `core/form/defaults.test.ts`), and a view that wants
// a data-driven starting value computes it in its own `derived` block, where the data it
// derives from is in scope.

/** The FALLBACK form for an analysis that ships no `ui:` view (ITEM-4).
 *
 *  An analysis with a view renders that view — one pane, one form, the view's own
 *  controls and option sources (INV-2/INV-3). This exists for the other case: a
 *  processor that declares no UI at all still has to be launchable, so the run pane
 *  synthesizes the only form that can be derived without presentation data — one
 *  artifact-ref control per input SLOT.
 *
 *  That first paragraph described the INTENT and, until this was written, nothing enforced
 *  it: `AnalysisRunPanel` called this unconditionally, so a view-backed analysis got this
 *  form too — over `appliesTo` alone, i.e. missing every input its view declares beyond a
 *  manifest slot. The enforcement is `analysisOwnsItsForm`
 *  (`core/contributions/ownForm.ts`), which the panel now branches on before reaching here.
 *  Do not call this without that check.
 *
 *  It is deliberately plain. There is no title, no help text and no field ordering to
 *  read, because the manifest no longer carries any (INV-1) — the slot name is the
 *  label. A processor that wants better than that ships a view, which is the point.
 */
export function fallbackParamsFor(analysis: AnalysisContribution): ParamsSchema {
  return {
    fields: (analysis.appliesTo ?? [])
      .filter(sel => !!sel.slot)
      .map(sel => ({
        id: sel.slot!,
        type: 'artifact-ref' as const,
        title: sel.slot!,
        accepts: sel,
        required: true,
        multiple: sel.multiple,
      })),
  } as ParamsSchema
}
