// The save-path selection recorder (filter-provenance ITEM-13/15, DEC-2/DEC-6).
//
// `Provenance.recordCapture` shipped with ZERO production callers: the
// provenance capture chokepoint was fully implemented and never invoked, so
// a committed filter left no durable, replayable record anywhere. DEC-2 puts the
// recording at the SAVE/COMMIT point ("we only create the mask when the user clicks
// save, so capture there") — this action is what a declared `call_action` step in a
// processor's `view_spec` invokes at that point.
//
// It stays UI-as-DATA: a processor YAML declares `call_action: { id:
// 'provenance.record-selection', params: {...} }` on its existing save action. NO new
// interpreter verb, NO `ctx.api` arbitrary-route capability (DEC-4, withdrawn), NO new
// React component.
//
// ## ONE encoding (ITEM-4)
//
// What gets recorded is the run's `criteria` — the SAME `{column, control?, min?, max?,
// keep?}[]` the compute kernel filters on (`cell-filter.py::criteria_keep_mask`) and the
// live preview recomputes from. It is persisted as a FLAT `{criteria}` recipe under the
// `subset.filter` action type through `POST /provenance/actions` (project EDIT), the
// generic chokepoint that takes the action type as an EXPLICIT field.
//
// `subset.filter` is the right type because the server's `action_registry::emit_code` has
// an arm for exactly this shape: it reads `recipe["criteria"]` as an array and emits the
// replay script via `emit_criteria_script` — the arm that exists for "a committed
// keep-mask carrying the declarative UI's own criteria shape", and it is `dispatchable`.
// The sibling route `POST /provenance/selections` cannot reach it: that route hardcodes
// the `selection.` prefix and derives the rest from the recipe's `kind`, so a criteria
// recipe sent there lands on the `selection.column` arm, which requires string `col`/`op`/
// `val` fields a criteria list does not have and answers `MalformedRecipe`. Choosing the
// action type explicitly, on the route that accepts one, is what makes the record land.
//
// This action used to record something else: the criteria LIFTED into a DSL
// `CellSetPredicate`, obtained from `POST /selection/by-predicate` with a client-side
// `buildRecipe` fallback when that hop 4xx'd (which was the common case — its evaluation
// context deferred column resolution). That was a SECOND encoding of one filter, and the
// two could describe different cell sets while both reported success: a recorded
// predicate constraining what the committed mask did not, at rc=0, three times over five
// audit rounds. The lift, the by-predicate hop and the client fallback are all deleted.
// One encoding cannot disagree with itself.

import { z } from 'zod'
import { Provenance } from '@/modules/provenance/stores/Provenance.store'
import { Permissions } from '@/api-client/permissions'
import { defineAction, markSurfaced } from '@/core/actions/defineAction'
import {
  criterionColumn,
  isCategoricalCriterion,
  parseBound,
  type FilterCriterion,
} from '@/modules/workbench/core'

const params = z.object({
  /** the project the selection belongs to (from the run bag, `$<into>.projectId`). */
  project_id: z.string().min(1),
  /** the artifact the predicate was evaluated over — the run's OWN resolved input
   *  (`$<into>.inputs[0].artifactId`), so the recorded input and the run's `used` edge
   *  cannot disagree (DEC-6, Carrier A). */
  input_artifact_id: z.string().min(1),
  /** an optional human label for the recorded selection. */
  label: z.string().nullish(),
  /** the criteria the run filtered on (`$state.criteria`) — the ONE encoding of the
   *  filter, and what gets recorded. When NO criterion constrains anything, NOTHING is
   *  recorded: an all-true "selection" is the degenerate state this feature exists to
   *  catch, so it must not be recordable. */
  criteria: z.array(z.unknown()).nullish(),
  /** present on every declared-action invocation; ignored here. */
  view_id: z.string().optional(),
})

export type RecordSelectionParams = z.infer<typeof params>

/** The outcome a caller (or a test) can assert on. */
export interface RecordSelectionResult {
  recorded: boolean
  /** what was recorded — the run's criteria, or nothing (no criterion constrained). */
  source: 'criteria' | 'none'
}

/** Does this criterion actually constrain the committed keep-mask?
 *
 *  The SAME two rules `keep_mask` (the live preview) and `criteria_keep_mask` (the
 *  committed kernel) apply, read from the shared criteria vocabulary — so "nothing is
 *  recorded" here means exactly "nothing was filtered" there, and never disagrees with
 *  it. A criterion with no column, an empty keep-set, or two unparseable bounds imposes
 *  nothing. CATEGORICAL FIRST: a keep-set criterion carrying stale min/max is a keep-set.
 */
function constrains(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false
  const criterion = c as FilterCriterion
  if (!criterionColumn(criterion)) return false
  if (isCategoricalCriterion(criterion)) {
    // `isCategoricalCriterion` answers TRUE for an EXPLICIT `control: 'multiselect'`
    // before it ever looks at `keep` (the shape-inference branch is the fallback), so it
    // is a "which branch" predicate, not a "does it constrain" one. An empty keep-set
    // constrains NOTHING — the kernel treats it as absent — and recording it would be
    // exactly the all-true "selection" INV-1 forbids.
    return Array.isArray(criterion.keep) && criterion.keep.length > 0
  }
  return parseBound(criterion.min) !== undefined || parseBound(criterion.max) !== undefined
}

/** The `ctx` extras a declarative `call_action` supplies (`InterpreterCtx`). Typed
 *  structurally so this module does not import the workbench interpreter (a
 *  cross-module dependency the module boundary forbids). */
interface ToastCapableCtx {
  toast?: (msg: { success?: string; error?: string } | string) => void
}

/** Surface `message` to the USER as an error, whatever ctx we were handed.
 *
 *  A declared `call_action` step that THROWS aborts `interpretBody` before the
 *  next effect, and `WidgetHost.dispatch` only `console.error`s the rejection —
 *  so a throw alone is invisible: the button appears to do nothing. Every failure
 *  path therefore toasts FIRST, then throws (the throw is what stops the caller's
 *  unconditional success toast from rendering). */
function surfaceFailure(ctx: unknown, message: string): never {
  const toast = (ctx as ToastCapableCtx | undefined)?.toast
  const err = new Error(message)
  if (typeof toast === 'function') {
    toast({ error: message })
    // MARKED only when the message ACTUALLY went somewhere. A generic dispatcher (the
    // declarative `WidgetHost`) toasts rejections so nothing fails silently; marking
    // unconditionally would let a ctx WITHOUT a toast suppress the dispatcher's own
    // message and produce exactly the silent failure this feature exists to remove.
    markSurfaced(err)
  }
  throw err
}

/** The user-facing wording for "the science happened, the record did not".
 *
 *  The mask commit ALREADY succeeded when this action runs (the view's own run action
 *  does `run_processor` → `wait_for: completed` first), and a completed run cannot be
 *  rolled back — so the honest outcome is: the commit stands, the capture failure
 *  is reported, and the success toast does not render. */
const PARTIAL_FAILURE_MESSAGE =
  'The keep-mask was committed, but its provenance recipe was NOT recorded — this run is not reproducible.'

/** The action type a criteria recipe is captured under.
 *
 *  `subset.filter` is the server `action_registry` arm built for this exact shape — it
 *  reads `recipe["criteria"]` as an array and emits the replay script through
 *  `emit_criteria_script`. It is `dispatchable`, and it is reachable ONLY through
 *  `POST /provenance/actions`, which takes the action type explicitly. */
const CRITERIA_ACTION_TYPE = 'subset.filter'

export const recordSelectionAction = defineAction<RecordSelectionParams, RecordSelectionResult>({
  id: 'provenance.record-selection',
  title: 'Record selection provenance',
  description:
    'Persist the committed selection as a durable recipe (the run criteria + pinned input) in the project provenance graph.',
  group: 'Provenance',
  keywords: ['provenance', 'selection', 'recipe', 'reproducibility'],
  // The route gate is `provenance::read` + a per-project EDIT role
  // (`handlers::record_action` → `authz::require_project_edit` — the same pair the
  // `selections` route enforces); the backend stays authoritative, this is the
  // manifest/documentation mirror.
  permission: Permissions.ProvenanceRead,
  mutating: true,
  // Driven by a processor's declared save action, not by a human palette entry.
  surfaces: { palette: false },
  params,
  run: async (p, ctx) => {
    // What the run actually filtered on. A criterion that constrains NOTHING (no
    // column, an empty keep-set, two unparseable bounds) is not a filter, and the
    // same rules decide that here and in the kernel — so "recorded nothing" always
    // means "filtered nothing", never "we could not express what you filtered".
    const criteria = (p.criteria ?? []).filter(constrains) as FilterCriterion[]
    if (criteria.length === 0) {
      // NO constraining criteria at all — a legitimate no-op (an all-true
      // "selection" must not be recordable).
      return { recorded: false, source: 'none' }
    }

    // The FLAT recipe: the criteria themselves, and NOTHING else. The action type
    // carries "what kind of action this was", so a `kind` key inside the recipe would
    // be a SECOND encoding of that same fact, free to disagree with the type the run is
    // actually stored under (INV-10). There is no second encoding to reconcile and no
    // evaluation hop that can fail — the record IS the filter that ran.
    const recipe = { criteria }

    // `recordCapture` RESOLVES ⇒ recorded, THROWS ⇒ not recorded (it used to
    // return an unread `false`). Toast first so the user actually sees it, then
    // rethrow so a declared body's subsequent unconditional `toast: {success}`
    // never renders.
    //
    // F2-36: the try wraps ONLY the call, and no `if (!recorded)` guard is left
    // inside it. That guard was unreachable (the store has no `return false` path)
    // AND a live trap: it called `surfaceFailure`, which THROWS, straight into this
    // catch, which called `surfaceFailure` again — ONE failure, TWO toasts, the
    // second nesting the first's sentence inside its own parentheses.
    // `markSurfaced` cannot dedupe that (each call mints a fresh Error), and it is
    // exactly the duplicate-message symptom that mechanism was introduced to
    // eliminate, in the action that owns it.
    try {
      await Provenance.recordCapture(
        p.project_id,
        p.input_artifact_id,
        CRITERIA_ACTION_TYPE,
        recipe,
        p.label ?? undefined,
      )
    } catch (err) {
      surfaceFailure(
        ctx,
        `${PARTIAL_FAILURE_MESSAGE} (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    return { recorded: true, source: 'criteria' }
  },
})
