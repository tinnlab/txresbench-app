import { isCategoricalCriterion, parseBound, pyStr } from '@/modules/workbench/core'
import type { RunNodeDto } from '@/api-client/types'

/**
 * The run's FILTER as trust-view text — "what was this filtered on?" (ITEM-9 /
 * DEC-5). A pure helper modelled on `FigureRunStamp.tsx`'s `paramsPreview`: the
 * same module, the same `RunNodeDto`, the same problem (an unbounded opaque run
 * field must appear inline in a compact provenance surface).
 *
 * Source precedence mirrors the server's export renderers (DEC-9): the promoted
 * scientific `params` FIRST, the re-run envelope's `params` SECOND — so a run
 * recorded BEFORE the promotion (whose `params` column holds only
 * `{seed, language, arch}`) still shows its real filter instead of runtime
 * metadata. A run with neither renders `''`, which the cell shows as `—` (no
 * empty chrome).
 *
 * ITEM-4: this was `predicatePreview`, and it had a THIRD arm that rendered a
 * recorded selection's `recipe.predicate` — a DSL lift of the same filter — through
 * a shared methods-text renderer. That second encoding is deleted, so a recorded
 * selection is now narrated from its `recipe.criteria` by the SAME `criterionPhrase`
 * that narrates a filter run's own `params.criteria`. One encoding, one sentence.
 */

/** Runtime metadata (not science) + facts that have their OWN column. */
const NON_SCIENTIFIC_KEYS = new Set(['language', 'arch', 'seed'])

/** Characters kept before the ellipsis. A fixed presentation constant (DEC-12) —
 *  it changes how one table cell looks, not what any deployment can do. */
const MAX_PREVIEW_CHARS = 88

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** The scientific params (runtime metadata + seed removed), or null when the
 *  object carries no scientific parameter at all. */
function scientificParams(value: unknown): Record<string, unknown> | null {
  const obj = asObject(value)
  if (!obj) return null
  const entries = Object.entries(obj).filter(([k]) => !NON_SCIENTIFIC_KEYS.has(k))
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

/**
 * A keep-set value as PROSE — the twin of `export/methods.rs::render_scalar`.
 *
 * F2-29: this used to be `JSON.stringify` for every non-string, so it spelled a boolean
 * `true` and a null `null` — JS's spelling. The COMMITTED mask compares in python's
 * (`str(x) in wanted`), the emitted replay script matches it, and the exported RO-Crate
 * narration renders `True`/`False`/`None`. So for a boolean or null-bearing obs column
 * this trust view — the one place a user checks "does the recorded provenance match the
 * filter I ran?" — named a category that does not exist in the data, while the exported
 * bundle for the SAME run named a different one. Two documents, one run, two filters.
 *
 * [`pyStr`] is the shared spelling rule (`core/criteria/criteria.ts`,
 * `primitives.ts::keep_mask` and `cell-filter.py` all use it). A NON-scalar (an array /
 * object keep value) keeps the JSON form, which is what `render_scalar`'s
 * `other => other.to_string()` arm emits.
 */
function scalar(v: unknown): string {
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'number') {
    return pyStr(v)
  }
  if (typeof v === 'string') return v
  return JSON.stringify(v) ?? String(v)
}

/** Render one `{column, control?, min?, max?, keep?}` criterion as a phrase, or null
 *  when it carries no column / imposes no constraint (never shown as an all-pass
 *  filter).
 *
 *  The TS twin of `export/methods.rs::criteria_phrases`, and it applies the same two
 *  rules the keep-mask does, for the same reason: the trust view must show the filter
 *  that ACTUALLY RAN.
 *   - CATEGORICAL FIRST: a keep-set criterion that also carries stale min/max used to
 *     read as a range here while the mask applied the keep-set.
 *   - The canonical `parseBound`, not `!= null`: `min: ''` is an UNTOUCHED control
 *     (no constraint), and used to render as `n_genes ≥ ` with an empty bound. */
function criterionPhrase(c: unknown): string | null {
  const obj = asObject(c)
  const column = typeof obj?.column === 'string' ? obj.column.trim() : ''
  if (!column) return null
  if (isCategoricalCriterion(obj as { control?: string; keep?: Array<string | number> })) {
    const keep = Array.isArray(obj?.keep) ? obj.keep : []
    if (keep.length === 0) return null
    return `${column} in [${keep.map(scalar).join(', ')}]`
  }
  const min = parseBound(obj?.min as string | number | null | undefined)
  const max = parseBound(obj?.max as string | number | null | undefined)
  if (min !== undefined && max !== undefined) return `${column} ${min}–${max}`
  if (min !== undefined) return `${column} ≥ ${min}`
  if (max !== undefined) return `${column} ≤ ${max}`
  return null
}

/** Narrate a criteria list, or `null` when it is not a list at all. An EMPTY string
 *  (a list where nothing constrains) is a real answer and is NOT the same as `null`. */
function criteriaPhrases(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  return value
    .map(criterionPhrase)
    .filter((p): p is string => p !== null)
    .join('; ')
}

/**
 * The FULL filter text for a run (untruncated) — the `Tooltip` body. Empty
 * string when the run recorded no scientific params.
 */
export function criteriaText(run: Pick<RunNodeDto, 'params' | 'rerun_spec'>): string {
  const rerunParams = scientificParams(asObject(run.rerun_spec)?.params)
  const params = scientificParams(run.params) ?? rerunParams
  if (!params) return ''

  // A run that RECORDED criteria is narrated from them, and ONLY from them.
  //
  // F2-32: when the criteria list was present but yielded zero phrases — every
  // criterion imposing no constraint (`min: ''` is the documented UNTOUCHED-control
  // case, an empty keep-set, a blank column) — this fell through to
  // `JSON.stringify(params)`. Under a column literally titled "Filter" (and as the
  // lineage run node's subtitle) that dumped `{"criteria":[{"column":"n_genes","min":""}]}`,
  // naming a column the run never filtered on, while the RO-Crate methods section for
  // the SAME run says the opposite. The honest answer is nothing — the cell renders `—`.
  // The JSON fallback stays ONLY for params that carry no criteria at all (a non-filter
  // run's scientific parameters).
  const own = criteriaPhrases(params.criteria)
  if (own !== null) return own

  // A SELECTION run — the `provenance.record-selection` chokepoint — stores
  // `{recipe, label}`, where the recipe is `{criteria}`. It carries no top-level
  // `criteria` key, so without this arm it fell straight through to
  // `JSON.stringify(params)` — and under a column titled "Filter" a real run read as
  // raw JSON rather than as what was filtered on.
  const recorded = criteriaPhrases(asObject(params.recipe)?.criteria)
  if (recorded !== null) return recorded

  try {
    return JSON.stringify(params)
  } catch {
    return ''
  }
}

/**
 * The TRUNCATED preview for the table cell. The kit `Table`'s `ellipsis` native
 * `title` fallback reads the RAW record field, which does not exist for a derived
 * string — so the cell pairs this with an explicit `<Tooltip>` carrying
 * [`criteriaText`].
 */
export function criteriaPreview(run: Pick<RunNodeDto, 'params' | 'rerun_spec'>): string {
  const full = criteriaText(run)
  return full.length > MAX_PREVIEW_CHARS ? `${full.slice(0, MAX_PREVIEW_CHARS - 1)}…` : full
}
