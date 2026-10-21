import { useMemo } from 'react'
import {
  isFieldVisible,
  type BindingOrigin,
  type GatingContext,
  type ParamField,
  type ParamsSchema,
} from '@/modules/workbench/core'
import { useWorkbench } from '@/modules/workbench/core/shell/WorkbenchContext'
import { resolveFieldRenderer } from '@/modules/workbench/extensions/widgets/form/fields/registry'
import { registerBuiltinFieldRenderers } from '@/modules/workbench/extensions/widgets/form/fields/builtinFieldRenderers'

// Register the built-in `field.type` → renderer set (ITEM-54) at module load — the
// form dispatches every field through the open registry, so the built-ins must be
// present before the first `GatedField` render. Idempotent (last-wins).
registerBuiltinFieldRenderers()

// The form's own user-facing ORIGIN wording, re-exported from the field that owns it so a
// HOST (the run panel, which marks the same fact on its own summary line) reads the one
// shipped copy rather than keeping a second literal in step by hand. Re-exported HERE, and
// not deep-imported from `fields/`, because this file is the form's entry point for a host
// — reaching past it into a field module is the boundary `lint-layer-boundary` refuses.
// The origin mark's wording now lives with the VOCABULARY (`core/runtime/bindingOrigin.ts`),
// re-exported here only so this module's existing consumers keep one import. Four surfaces
// render this mark — two in `core`, two here — so the `core` barrel is the only place all
// four can reach without a layer-boundary violation, and a literal per surface is the same
// fact waiting to drift into four slightly different claims.
export { BINDING_ORIGIN_COPY } from '@/modules/workbench/core'

// ─── REMOVED: the MULTI-STEP (wizard) form and the Tier-4 CODE-FORM escape hatch ───
//
// This renderer used to have three shapes. Two of them — `SteppedForm` (a Next/Back
// wizard over `ParamsSchema.steps`, with its `Stepper` indicator) and `CodeForm` (a
// lazily-loaded extension-shipped React form behind `ParamsFormRef`) — were deleted as
// UNREACHABLE. They rendered for no user on any surface, and had been maintained and
// bug-fixed twice while doing so.
//
// WHY THEY COULD NOT BE REACHED (re-verified at deletion, not inherited):
//   · `AnalysisRunPanel` is the ONLY host of `<SchemaForm>` in the tree;
//   · it always passes `fallbackParamsFor(analysis)` (`extensions/analysis/inputEconomy.ts`),
//     which synthesises a schema from `appliesTo` alone — a flat `{ fields }` of one
//     artifact-ref control per input SLOT, never `steps`, never `kind: 'code-form'`;
//   · `AnalysisContribution` has no `params` key at all — the only channel that could
//     have carried either shape was removed under INV-1 (`core/contributions/types.ts`);
//   · and it cannot come back in by the side door: `params` is in the REJECTED-KEYS list
//     in `core/runtime/loadProcessors.ts`, so a processor manifest declaring one FAILS
//     TO LOAD. Processor `ui/*.yaml` files are `view_spec`s rendered by the declarative
//     view engine, a different renderer that never constructs a `ParamsSchema`.
//
// TO RESTORE A MULTI-STEP FORM, the missing piece is a params CHANNEL, not a renderer:
//   1. give `AnalysisContribution` a params declaration again (or add a second
//      `<SchemaForm>` host that owns one), and un-reject `params` in `loadProcessors`
//      with a parser for it;
//   2. re-add `steps?: StepSpec[]` to `ParamsSchema` plus `isSteppedSchema` /
//      `reachableSteps` / `stepValid` / a `flattenFields` that reconciles
//      `steps[].fields` with the top-level list — every consumer of `visibleFields`,
//      `artifactRefFields` and `pruneHiddenParams` assumes a FLAT list today;
//   3. re-add this component's submit channel (`onSubmit` / `submitDisabled` /
//      `submitDisabledReason` / `submitting` / `submitLabel`) — the wizard's last step
//      owned Run, which is why the host currently renders Run itself, unconditionally.
// Git history has all of it (branch `chore/delete-stepped-wizard`); do not re-derive it.
//
// THE REFUSAL-REASON RULE SURVIVES THE DELETION and is not optional in a restored
// wizard: whatever disables a submit must pass the REASON alongside the boolean. The
// defect that motivated the original fix was exactly that split — the host computed
// `{disabled, reason}`, handed over only `disabled`, and the sentence explaining the
// refusal was rendered nowhere. On the surviving flat path the host owns Run and states
// its reason via `unavailableReason` (`AnalysisRunPanel`), which is the invariant a
// restored stepper would have to re-honour on its own button.

export interface SchemaFormProps {
  params: ParamsSchema
  value: Record<string, unknown>
  /**
   * An edit. `edited.fieldId` names the field the USER touched (ITEM-14/INV-5).
   *
   * The id is carried rather than left to be re-derived from the two bags, because
   * re-picking a value that happens to be the one already there is a real edit — it is
   * how a user REVIEWS an auto-bound input — and a bag diff cannot see it: both bags
   * hold the same value, which is the whole point of the gesture. A host that only
   * cares about the values ignores the second argument and is unaffected.
   */
  onChange: (next: Record<string, unknown>, edited?: { fieldId: string }) => void
  /**
   * How each field's current value was CHOSEN, keyed by field id (ITEM-15). Threaded to
   * the field renderers so a control that displays a binding displays its origin (INV-2).
   *
   * OPTIONAL: a form given none renders byte-identically to one rendered before this
   * prop existed — no mark, no wrapper, no attribute. Absence is unknown, never `'user'`.
   */
  origins?: Record<string, BindingOrigin>
  'data-testid'?: string
}

/**
 * The declarative params HOST renderer (P6 / ITEM-8). Renders an analysis's P5
 * `ParamsSchema` into `@ziee/kit` controls — the no-code path — as a PURE controlled
 * form: each field binds to `value[field.id]` and edits flow out through
 * `onChange({ ...value, [id]: next })`. ONE shape: the ordered field list. Field
 * visibility (ITEM-36) and dependent options (ITEM-37) are threaded through the live
 * form `value`. Run is the HOST's (see the removal note above).
 */
export function SchemaForm({
  params,
  value,
  onChange,
  origins,
  'data-testid': testid = 'schemaform',
}: SchemaFormProps) {
  const { producedTypeIds } = useWorkbench()
  const gating: GatingContext = useMemo(() => ({ producedTypeIds }), [producedTypeIds])

  return (
    <div data-testid={testid} className="flex flex-col gap-4">
      {params.fields.map(field => (
        <GatedField
          key={field.id}
          field={field}
          value={value}
          gating={gating}
          onChange={onChange}
          origin={origins?.[field.id]}
        />
      ))}
    </div>
  )
}

/** One field, gated by its `when` clause against the live project state + form VALUES
 *  (ITEM-36), then dispatched to the registry renderer for its `field.type` (ITEM-54).
 *  An unregistered/extension-declared type resolves to the visible `UnknownFieldFallback`
 *  (never a crash). `repeatPer` (repeat a sub-field per selected artifact-ref) is not
 *  yet rendered — a later slice. */
function GatedField({
  field,
  value,
  gating,
  onChange,
  origin,
}: {
  field: ParamField
  value: Record<string, unknown>
  gating: GatingContext
  onChange: (next: Record<string, unknown>, edited?: { fieldId: string }) => void
  origin?: BindingOrigin
}) {
  const { lattice } = useWorkbench()
  // Visibility now threads the current form values, so `when: { field, eq: … }`
  // value-predicates drive show/hide. A hidden field's value is excluded from the
  // submitted params by `pruneHiddenParams` at submit time (no stale-value leak).
  if (!isFieldVisible(field, value, gating, lattice)) return null

  // The edit names ITS OWN field — the control knows which field it is, so nothing
  // downstream has to guess it back out of a diff (INV-5: a re-pick of the value already
  // there is an edit, and a diff cannot see one).
  const set = (next: unknown) => onChange({ ...value, [field.id]: next }, { fieldId: field.id })
  // Registry dispatch by `field.type` (replaces the artifact-ref/widget/scalar if-chain
  // + `ScalarField`'s switch). `values` carries the whole record so a renderer can read
  // siblings (string templated defaults / enum dependent options).
  const Renderer = resolveFieldRenderer(field.type)
  return <Renderer field={field} value={value[field.id]} values={value} onChange={set} origin={origin} />
}
