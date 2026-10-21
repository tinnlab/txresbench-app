// The `artifact_ref` widget renderer (PLAN.md ITEM-7) — the VISIBLE form of an input the
// run consumes (INV-4).
//
// It replaces auto-resolution. The host used to resolve an analysis' input from the
// catalog between click and job, and threw `found ${options.length}` whenever the count
// was not exactly 1 — so two compatible matrices made the analysis unlaunchable, and one
// compatible artifact made the choice invisible. Neither state was something the user
// could see, let alone correct; in the incident that motivated this, a hardcoded column
// source matched NOTHING and the run reported a silent zero with no error at all.
// (The concrete case is in `docs/design/processor-manifest-ui-separation.md`.)
//
// Three cardinalities, three different right answers:
//
//   0 candidates → an explicit empty state that NAMES what is missing. A disabled, blank
//                  listbox is the illegible control F9 targets.
//   1 candidate  → a read-only SUMMARY, pre-selected. There is no choice to offer, so a
//                  listbox would be a control with one option; but the value is still
//                  shown, because "what is launched is what was shown" is the invariant,
//                  and the pre-selection is performed HERE (visibly) rather than at launch.
//   2+           → a real picker.
//
// The candidate set comes from the widget's OWN `source` (INV-2), resolved against THIS
// widget's render scope — which is the `for_each` iteration's scope when the ref is
// repeated, so an axis-scoped `of` naming the loop variable resolves per row.

import * as React from 'react'
import {
  Badge,
  Button,
  MultiSelect,
  RadioGroup,
  Select,
  type MultiSelectOption,
  type SelectOption,
  type SelectOptionGroup,
} from '@ziee/kit'
import { BINDING_ORIGIN_COPY, ORIGIN_AUTO } from '@/modules/workbench/core/runtime/bindingOrigin'
import { DEFAULT_VALUE_PREVIEW, previewableColumn } from '@/core/workstore'
import type { ArtifactRefWidget as ArtifactRefWidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { evalExpr, type Scope } from '@/modules/workbench/core/runtime/expr'
import {
  resolveArtifactRefSource,
  type ArtifactRefCandidate,
} from '@/modules/workbench/core/runtime/axisSource'
import {
  candidateDatasetLabel,
  groupCandidates,
  shouldShowGroups,
} from '@/modules/workbench/core/runtime/candidateGroups'
import { readCatalogScope, type ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import {
  declaredDistinctCount,
  declaredValuePreview,
  readValuePreviewScope,
  type ArtifactValuePreviewSource,
  type ValuePreview,
} from '@/modules/workbench/core/artifacts/valuePreview'
import { EMIT_ICON, EmitControl } from './EmitControl'
import type { WidgetRenderContext, WidgetRenderer } from './registry'
import { WidgetField } from './WidgetField'

/**
 * Expand a picked artifact-ref VALUE into the full set of artifact ids the run must bind
 * (ITEM-35, DEC-D).
 *
 * Each selected id contributes: a FUSED candidate its whole member set (primary first); an
 * UNFUSED candidate ITSELF. Deduped, in selection order. This is what makes the member set
 * AUTHORITATIVE for what the run consumes — `resolveInputs` binds it and skips the raw value, so
 * an unfused pick that contributed NOTHING here would be silently DROPPED from a mixed
 * multi-select (some columns fuse across datasets, single-dataset ones do not), which is the
 * inverse of the provenance hole ITEM-35 closes.
 *
 * Returns `undefined` — no member sidecar, the byte-identical pre-ITEM-35 path — ONLY when
 * NOTHING selected was fused, so an ordinary pick's dispatch is unchanged and `resolveInputs`
 * binds the raw value exactly as before. Exported pure for direct unit test.
 */
export function expandSelectionArtifacts(
  value: string | string[],
  candidates: readonly Pick<ArtifactRefCandidate, 'id' | 'artifacts'>[],
): readonly string[] | undefined {
  const ids = Array.isArray(value) ? value : [value]
  let anyFused = false
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const set = candidates.find(c => c.id === id)?.artifacts
    const expansion = set && set.length > 0 ? set : [id]
    if (set && set.length > 0) anyFused = true
    for (const member of expansion) {
      if (typeof member === 'string' && member && !seen.has(member)) {
        seen.add(member)
        out.push(member)
      }
    }
  }
  return anyFused && out.length > 0 ? out : undefined
}

/** Copy is centralized (not inlined per branch) so a future i18n pass has one target, and
 *  so the empty state's wording is asserted rather than re-typed in a test. */
export const ARTIFACT_REF_COPY = {
  emptyTitle: 'Nothing to choose yet',
  emptyDescription:
    'No artifact in this project matches what this input accepts. Import a dataset, or run the analysis that produces it.',
  emptyDependent:
    'Choose the input above first — this list is scoped to the dataset that choice belongs to.',
  soleCandidate: 'Only one match — selected automatically.',
  /** The MARK, and it is a different thing from the sentence above it.
   *
   *  R8: *"a marker seen only at the moment of choosing is not a marker; it is a disclaimer
   *  nobody sees again."* The sentence is field DESCRIPTION — prose about how this control
   *  behaves. This rides ON the value, beside the artifact it describes, so what a reader
   *  takes away from glancing at the form is that THIS binding was not theirs. It is also
   *  the only half of the pair that has an analogue anywhere else the value travels (the
   *  recorded input, the exported bundle), which is what makes it a marker rather than a
   *  disclaimer.
   *
   *  The STRING is `BINDING_ORIGIN_COPY`'s, not this object's own: the fallback form's
   *  control and the run panel's summary state the same fact, and one mark spelled three
   *  ways is the drift this change exists to end. Re-exported here so a reader of this
   *  file's copy table is not left wondering where the mark's wording went. */
  autoBoundMark: BINDING_ORIGIN_COPY.autoBound,
  /** WHY a DECLARED auto-bind did not fire. INV-10: sole candidacy is not consent, and a
   *  refusal that says nothing is indistinguishable from a control that forgot. */
  refusedAmbiguous:
    'Only one match, but it could not be told apart from another candidate — choose it yourself.',
  refusedUnaligned:
    'Only one match, but its alignment to these rows is not declared — choose it yourself.',
  /** Shown for the instant between "one candidate resolved" and "that candidate is bound".
   *  A control must never name a value the run has not been given. */
  resolving: 'Selecting…',
  placeholder: 'Select artifacts…',
  search: 'Filter by name…',
  noMatch: 'No artifact matches that filter',
  /** DEC-2 — the preview is an EXCERPT, never "the first N". Two of its three sources are
   *  the column's VOCABULARY (a declared level set, a distinct-value summary), which is a
   *  fair excerpt of what the column contains and carries no row order at all. `e.g.` is
   *  the one prefix true of all three; "first 5" would be a confident claim about an
   *  ordering the data does not have. */
  previewPrefix: 'e.g.',
  /** Said aloud when a `control: radio` declaration exceeds {@link ARTIFACT_REF_RADIO_MAX} and
   *  falls back to a searchable list. A SUBSTITUTION the user is not told about is how a
   *  shipped control drifts from its stated design without anyone noticing. */
  radioOverflowed: (n: number): string =>
    `${n.toLocaleString()} candidates — too many to list side by side, so they are offered in a ` +
    'searchable list instead. One is still active at a time.',
} as const

/**
 * The cardinality above which a DECLARED radio falls back to a searchable list.
 *
 * Declared, not silent: see {@link ARTIFACT_REF_COPY.radioOverflowed}.
 *
 * It used to be re-exported as the deleted row-space anchor's `ANCHOR_RADIO_MAX`, so the two
 * controls that sat one above the other could not drift to two thresholds. There is only one
 * such control now, so there is only this declaration.
 */
export const ARTIFACT_REF_RADIO_MAX = 8

/**
 * Whether the sole candidate may be BOUND for the user, and if not, why not (ITEM-29b).
 *
 * Two rules, and they are different propositions:
 *
 *   · **R2 / INV-3** — auto-binding at all requires the spec to have DECLARED
 *     `auto_bind_sole_candidate: true`. Absence is OFF (DEC-15). A resolver that takes the only
 *     candidate because it is the only one is `candidates[0]` with a nicer sentence, and R2
 *     forbids it precisely because the form then shows a choice nobody made.
 *   · **INV-10** — a DECLARED auto-bind still does not fire for a candidate that is CONTESTED
 *     (its label could not be told apart from another in this same offer) or **A3** (its
 *     alignment to the anchored row space is undeclared). *"Sole candidacy is not consent. The
 *     pane opens unselected and says why."*
 *
 * A3 is `alignmentUnknown === true` and NOT `!== false`: `undefined` means the question was
 * never asked, which is the state of every candidate today (the A0–A3 states exist only
 * relative to an anchored row space, and the shipped sources are dataset-scoped siblings). The
 * engine-side offering predicate (ITEM-17/ITEM-18) is what starts answering it; the refusal is
 * in force from that day without a second edit here.
 *
 * Exported because it is a RULE, not a rendering: it is what ITEM-13's auto-anchor has to obey
 * too, and a rule observable only through one component's DOM is a rule the next caller
 * re-derives slightly differently.
 */
export function autoBindVerdict(
  spec: Pick<ArtifactRefWidgetSpec, 'auto_bind_sole_candidate'>,
  candidates: readonly ArtifactRefCandidate[],
): { bind: boolean; refusedBecause?: string } {
  if (candidates.length !== 1) return { bind: false }
  if (spec.auto_bind_sole_candidate !== true) return { bind: false }
  const only = candidates[0]
  if (only.ambiguous === true) return { bind: false, refusedBecause: ARTIFACT_REF_COPY.refusedAmbiguous }
  if (only.alignmentUnknown === true) return { bind: false, refusedBecause: ARTIFACT_REF_COPY.refusedUnaligned }
  return { bind: true }
}

/** How many values the preview shows. Five is enough to tell an identifier column from a
 *  label column at a glance — which is the entire job — and short enough to sit on one
 *  line under the control. */
const PREVIEW_LIMIT = DEFAULT_VALUE_PREVIEW


// ── the CHOSEN artifact, and the tree it came from ───────────────────────────────────
//
// The data is a tree — a dataset holds artifacts — and the picker used to flatten it into
// strings, naming the dataset only when two labels collided and only as a SUFFIX. Both arms now
// render the tree, from one derivation, so a user reads the same thing whichever arm a view
// declared. A single group is not drawn: the heading would repeat on every row what is true of
// all of them.
//
// Grouping alone fixed only HALF of it, and the reported defect is the other half. A heading
// tells the user which dataset an option came from WHILE THE LIST IS OPEN; the moment the choice
// is made the list closes and the control was left showing the bare artifact name. On a project
// with two datasets that name is `expression` in both, so the answer to "which expression?" was
// visible only during the act of choosing and never afterwards — including on the sole-candidate
// arm, where the user never saw a list at all. So every place an artifact is displayed AS CHOSEN
// renders {@link ChosenArtifact}, and the dataset is part of the choice, not part of the browsing.

/**
 * What one CHOSEN artifact reads as. The single composition behind all three displays — the
 * single picker's closed trigger, each tag of the `multiple` picker, and the sole-candidate
 * summary — so a user cannot learn one shape here and meet another one there.
 *
 * Two lines, and which one gives is the whole design:
 *
 *   · the ARTIFACT's own name truncates. It is producer-generated and short in practice, and its
 *     tail carries nothing.
 *   · the DATASET wraps and is never clipped. It is the DISCRIMINATOR — the entire reason it is
 *     on screen is to tell two identically-named artifacts apart — and dataset names are
 *     user-supplied, so they are the long ones and they differ LATE (two imports of one study
 *     whose names agree until their final word). Truncating it removes exactly the substring
 *     the user needs, which is the mistake the label-suffix version already made once.
 *
 * ── `showDataset` — print what distinguishes, suppress what is constant ────────────────
 *
 * The paragraph above is about a CHOSEN artifact, where the dataset is the answer to "which
 * one did I pick?" and there is no list beside it to compare against. In the OFFER it is a
 * different string: an offer scoped to one anchored row space carries the same dataset on
 * every option, so it repeats a constant N times in the line meant to tell the options apart
 * — the exact noise `shouldShowGroups` already refuses for the grouped list arm, which the
 * radio arm was bypassing by rendering this component directly.
 *
 * So the caller says whether the dataset distinguishes anything here. When it does not, the
 * second line carries the candidate's declared COVERAGE instead — which is what varies, and
 * what a reader looking at two coordinate sets is actually asking. Where nothing is declared
 * the line is simply absent; it is never computed from a column body (INV-11).
 */
function ChosenArtifact({
  id,
  candidate,
  showDataset = true,
  showCoverage = true,
}: {
  id: string
  candidate: ArtifactRefCandidate
  showDataset?: boolean
  showCoverage?: boolean
}): React.ReactElement {
  // Both when the dataset distinguishes AND something is declared about the shape: the two
  // facts are independent and neither is the other's fallback. Either may be suppressed by the
  // caller, on the same grounds in both cases — it is constant across the list it is in, so it
  // is said once above it instead (see the radio arm).
  const coverage = showCoverage ? candidate.coverage : undefined
  const dataset = showDataset ? candidateDatasetLabel(candidate) : undefined
  const second = [dataset, coverage].filter(Boolean).join(' · ') || undefined
  return (
    <span
      className="flex min-w-0 max-w-full flex-col items-start gap-0.5 text-start"
      data-testid={`${id}-selected`}
      // The artifact this display NAMES. Stamped on the node that renders the name rather than
      // taken from the binding, so "the control shows what it holds" stays checkable off the DOM
      // — the same reason the value excerpt carries the id it was drawn FROM.
      data-artifact-id={candidate.id}
    >
      <span className="w-full truncate" title={candidate.label}>
        {candidate.label}
      </span>
      {second ? (
        <span
          className="w-full text-xs leading-tight break-words whitespace-normal text-muted-foreground"
          data-testid={`${id}-selected-dataset`}
        >
          {second}
        </span>
      ) : null}
    </span>
  )
}

/** Options for the MULTI arm — a flat list carrying an optional `group` heading, and a per-option
 *  tag rendering ({@link ChosenArtifact}) because a tag stands alone with no heading above it. */
function multiOptions(id: string, candidates: readonly ArtifactRefCandidate[]): MultiSelectOption[] {
  const groups = groupCandidates(candidates)
  const show = shouldShowGroups(groups)
  return groups.flatMap(g =>
    g.candidates.map(c => ({
      value: c.id,
      label: c.label,
      ...(show ? { group: g.label } : {}),
      selectedLabel: <ChosenArtifact id={id} candidate={c} />,
    })),
  )
}

// ── THE A3 MARK IS GONE FROM THE OFFER (owner, ledger #28 + #29) ──────────────────────────
//
// `markedCandidates` + `AlignmentMark` stood here: the per-candidate "· alignment not declared"
// this picker printed beside an option whose producer declared no alignment to the anchored row
// space, under DEC-11's *"offered but MARKED"*. The AGGREGATE arm of the same rule had already
// been deleted on 2026-08-13 for saying one fact in three places; the owner then asked for the
// § Coordinates alert to go (#28) and for the emitted plot's copy to go too (#29), which
// retires the rule itself rather than one more of its instances.
//
// The OFFER is untouched: every candidate this control listed, it still lists, in the same
// order, selectable in the same way. What went is the telling. `autoBindVerdict` above still
// refuses to auto-bind a sole A3 candidate — that is a decision about BINDING (INV-10's "sole
// candidacy is not consent"), not a mark, and no surface prints it unless the bind was declared
// and refused.

/** Options for the SINGLE arm — one group per dataset, or a flat list when there is one. */
function singleOptions(candidates: readonly ArtifactRefCandidate[]): (SelectOption | SelectOptionGroup)[] {
  const groups = groupCandidates(candidates)
  const opt = (c: ArtifactRefCandidate): SelectOption => ({ value: c.id, label: c.label })
  if (!shouldShowGroups(groups)) return groups.flatMap(g => g.candidates).map(opt)
  return groups.map(g => ({ label: g.label, options: g.candidates.map(opt) }))
}

/** The currently-bound selection, normalized to an id list regardless of `multiple`. */
function boundIds(spec: ArtifactRefWidgetSpec, scope: Scope): string[] {
  const v = spec.value != null ? evalExpr(spec.value, scope) : undefined
  const list = Array.isArray(v) ? v : v == null ? [] : [v]
  return list.filter((x): x is string => typeof x === 'string' && x !== '')
}

const testid = (spec: ArtifactRefWidgetSpec): string => `widget-${spec.id ?? 'artifact_ref'}`

// ── the VALUE PREVIEW ────────────────────────────────────────────────────────────────
//
// A picker offers artifacts by NAME, and on a real dataset the names do not say which is
// which: an identifier column and a label column on one axis render as two strings a user
// cannot tell apart, and picking wrong is SILENT — the run matches its patterns against
// identifiers, finds nothing, and reports zero rather than failing. Three of the column's
// own values make the distinction obvious with no schema knowledge, and the system already
// holds them (see `core/artifacts/valuePreview.ts` for the three sources and their costs).
//
// It is IMPLICIT for every `artifact_ref` rather than an opt-in `preview: true`, and the
// argument is not "flags are ugly" — it is that this flag would be unset exactly where it
// matters. The control that caused the defect is one an author wrote without knowing the
// distinction between the two columns existed; asking that author to also remember a flag
// puts the fix behind the same knowledge whose absence is the bug. The cost is bounded
// structurally instead: nothing is read until a selection exists (DEC-1), nothing is read
// for a declaration that carries no text-encoded column (`previewableColumn`, so a matrix
// or a numeric column costs zero requests), and the commonest case is answered by the
// catalog row already in hand.

/**
 * The preview for the currently-bound artifact — `undefined` whenever there is nothing to
 * show YET, nothing to show AT ALL, or the read failed.
 *
 * Three properties, all structural rather than remembered:
 *
 *   · **Nothing before a selection.** `row` is the BOUND artifact, so an unbound picker —
 *     and a sole-candidate arm whose pre-selection has not landed — previews nothing.
 *   · **A pending read shows nothing, never the previous column's values.** The fetched
 *     entry carries the id it was fetched FOR and is compared at RENDER time, so a stale
 *     preview is not merely cleared on time, it is unrenderable. Clearing it in the effect
 *     instead would leave one paint in which the old values sit under the new selection.
 *   · **A failure is silent and non-blocking (DEC-4).** The rejection is swallowed HERE,
 *     at the surface that decided the read was worth attempting, and nothing else in the
 *     control observes it: the form stays operable and Run stays enabled. The dev data
 *     this was built against has no bytes at all in the object store, so this is the
 *     ordinary path, not the exceptional one.
 */
function useValuePreview(
  row: ArtifactRow | undefined,
  source: ArtifactValuePreviewSource | undefined,
): { artifactId: string; preview: ValuePreview; distinct?: number } | undefined {
  // The DECLARATION gate, off the row the control already holds. `previewableColumn` is
  // the ONE rule for what may be previewed and it reads the stored ENCODING
  // (`string` = inline utf8, `categorical` = dictionary-encoded) — never a semantic term
  // like the source's `values: text`, and never `meta.kind`, which classifies a bool
  // column as categorical while the encoding calls it numeric (DEC-3 says numeric gets no
  // preview, so the encoding governs).
  const member = row ? previewableColumn(row.structure) : undefined
  const declared = declaredValuePreview(row, member !== undefined, PREVIEW_LIMIT)
  // Read only what the row could not already answer. On the shipped data this is the arm
  // that never runs — which is the point of ordering the sources by cost.
  const artifactId = row && member && !declared && source ? row.id : undefined
  // Held on a ref rather than in the dep list. An artifact is IMMUTABLE and
  // content-addressed, so the same id always names the same bytes and therefore the same
  // excerpt — but the ROW OBJECT is re-created on every catalog fetch, so depending on
  // `structure` by identity re-issues the read on every epoch bump for an answer that
  // cannot have changed. (Measured: a re-render with an equal-but-new row doubled the
  // reads.) The ref is written during render, beside the value it mirrors, so the effect
  // below can never see a structure belonging to a different id than the one it fetches.
  const structureRef = React.useRef<unknown>(undefined)
  structureRef.current = row?.structure

  const [fetched, setFetched] = React.useState<{ id: string; preview: ValuePreview } | undefined>()
  React.useEffect(() => {
    if (artifactId === undefined || source === undefined) return
    let cancelled = false
    source
      .previewValues({ artifactId, structure: structureRef.current, limit: PREVIEW_LIMIT })
      .then(p => {
        // An EMPTY excerpt is not an excerpt: rendering `e.g.` with nothing after it claims
        // to be showing values while showing none.
        if (!cancelled && p && p.values.length > 0) setFetched({ id: artifactId, preview: p })
      })
      .catch(() => {
        // DEC-4. The preview is an aid, not a gate — a missing blob, a network failure or
        // a store whose metadata carries no levels leaves the form exactly as it was.
      })
    return () => {
      cancelled = true
    }
  }, [artifactId, source])

  // The excerpt carries the id it was DRAWN FROM, and the caller renders THAT rather than
  // restating the binding. The distinction is the whole difference between an attribute
  // that can catch a stale excerpt and one that cannot: a `data-artifact-id` taken from the
  // bound row says "this is column B's field" no matter whose values are in it, so column
  // A's values under column B's name would carry B's id and read as correct everywhere.
  // (Measured: a mutation that keeps the previous excerpt survived BOTH test tiers until
  // this id came from the excerpt.)
  const drawn = declared
    ? { artifactId: row?.id, preview: declared }
    : fetched && fetched.id === artifactId
      ? { artifactId: fetched.id, preview: fetched.preview }
      : undefined
  if (!drawn?.artifactId) return undefined
  // DEC-5: free, so worth showing — and never a substitute for the values, so it is
  // attached to a preview rather than rendered in place of one.
  return { artifactId: drawn.artifactId, preview: drawn.preview, distinct: declaredDistinctCount(row, member) }
}

/** The preview line. Rendered through `WidgetField`'s `detail` slot, so it is placed and
 *  described-by like any other fact about the control rather than floated beside it. */
function ValuePreviewLine({
  id,
  artifactId,
  preview,
  distinct,
}: {
  id: string
  artifactId: string
  preview: ValuePreview
  distinct?: number
}): React.ReactElement {
  return (
    // WRAPS to at most two lines; it does NOT truncate to one.
    //
    // Measured on the real form in a docked pane: a single truncating line rendered
    // `e.g. A1BG, A1BG-A…` — one and a half values — which is not enough to tell an
    // identifier column from a label column, and telling them apart is the only reason
    // this line exists. `line-clamp-2` keeps the bound (a column of long values cannot
    // grow the form) while letting the common case show all of them, and it degrades by
    // dropping the LAST values rather than the first, so what survives is still a legible
    // start of the list.
    <span
      className="line-clamp-2 break-words"
      data-testid={`${id}-preview`}
      // The artifact these VALUES came from — the excerpt's own provenance, not the
      // control's binding. A preview drawn from the wrong column is indistinguishable from
      // a correct one by reading it, so the provenance is on the node; and it has to be
      // the EXCERPT's or it merely restates which field it is sitting in.
      data-artifact-id={artifactId}
      data-preview-source={preview.source}
    >
      {ARTIFACT_REF_COPY.previewPrefix} {preview.values.join(', ')}
      {distinct === undefined ? null : (
        <span className="tabular-nums opacity-80" data-testid={`${id}-preview-distinct`}>
          {' · '}
          {distinct.toLocaleString()} distinct
        </span>
      )}
    </span>
  )
}

function ArtifactRefControl({
  spec,
  ctx,
  candidates,
  selected,
  artifacts,
}: {
  spec: ArtifactRefWidgetSpec
  ctx: WidgetRenderContext
  candidates: ArtifactRefCandidate[]
  selected: string[]
  /** the catalog rows this control resolved against — the preview needs the BOUND row's
   *  own declaration, which the candidate framing (`{id,label,datatype}`) drops. */
  artifacts: readonly ArtifactRow[]
}): React.ReactElement {
  const id = testid(spec)
  // The preview attaches to ONE bound artifact. With several bound (a `multiple` picker
  // mid-selection) there is no single column to excerpt: showing one of them would be an
  // excerpt the user has no way to attribute, and stacking N is noise in a form. With none
  // bound there is nothing to preview at all (acceptance 5).
  const boundRow = selected.length === 1 ? artifacts.find(a => a.id === selected[0]) : undefined
  const previewed = useValuePreview(boundRow, readValuePreviewScope(ctx.scope))
  const detail =
    previewed && boundRow ? (
      <ValuePreviewLine
        id={id}
        artifactId={previewed.artifactId}
        preview={previewed.preview}
        distinct={previewed.distinct}
      />
    ) : undefined
  const extra: Record<string, unknown> = {}
  for (const [k, expr] of Object.entries(spec.args ?? {})) extra[k] = evalExpr(expr, ctx.scope)
  // `origin` DEFAULTS to nothing, which `ViewStore.set` reads as `'user'`. Every picker arm
  // below calls `emit` with one argument and is therefore a human choice by construction;
  // the sole-candidate effect is the one caller that passes `ORIGIN_AUTO`, and it has to
  // say so explicitly. A control that under-reports cannot do it by forgetting a `false`.
  const emit = (value: string | string[], origin?: typeof ORIGIN_AUTO): void => {
    const members = expandSelectionArtifacts(value, candidates)
    ctx.dispatch(spec.onChange, { ...extra, value }, origin || members ? { ...(origin ? { origin } : {}), ...(members ? { artifacts: members } : {}) } : undefined)
  }

  // The SOLE-candidate pre-selection. It is an effect, not a render-time dispatch: a
  // dispatch during render would set store state mid-paint. It runs once per (widget,
  // candidate) because the resulting `set` lands in the binding and the guard then holds
  // — a control that re-emitted every render would fight any later user edit, and with
  // one candidate there is no later user edit to fight, which is exactly why the guard
  // has to be on the VALUE rather than on a mounted-once ref.
  //
  // ITEM-29b — it now fires only when the SPEC DECLARED it, and only when INV-10 permits.
  // It was unconditional, which is a resolver taking `[0]` with no way to turn it off: R2's
  // named failure, wearing a sentence.
  const verdict = autoBindVerdict(spec, candidates)
  const sole = verdict.bind ? candidates[0].id : undefined
  const alreadyBound = sole !== undefined && selected.length === 1 && selected[0] === sole
  React.useEffect(() => {
    if (sole === undefined || alreadyBound || !spec.onChange) return
    emit(spec.multiple ? [sole] : sole, ORIGIN_AUTO)
    // `emit` closes over the dispatch + resolved args; the guard above is what makes this
    // idempotent, so re-running on a re-render is a no-op rather than a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sole, alreadyBound, spec.onChange, spec.multiple])

  // ── `auto_select_first` — THE OPENING SELECTION (ledger #24) ─────────────────────────────
  //
  // Declared, single-valued, and only while NOTHING is selected: the guard is the current
  // binding, so a user who moves the radio is never moved back, and a later render cannot
  // re-assert the first option over their choice. It carries `ORIGIN_AUTO` for the same reason
  // the sole-candidate bind does — the value is the app's, and the control says so — and it is
  // an effect rather than a render-time dispatch because a dispatch during render would set
  // store state mid-paint.
  //
  // It does NOT consult `autoBindVerdict`: see `auto_select_first`'s own doc. The refusals that
  // verdict encodes are about an INVISIBLE binding, and this one is checked in a radio the user
  // is looking at.
  const firstId =
    spec.auto_select_first === true && spec.multiple !== true && candidates.length > 0
      ? candidates[0].id
      : undefined
  const nothingSelected = selected.length === 0
  React.useEffect(() => {
    if (firstId === undefined || !nothingSelected || !spec.onChange) return
    emit(firstId, ORIGIN_AUTO)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId, nothingSelected, spec.onChange])

  if (candidates.length === 0) {
    // Two DIFFERENT absences, two different next actions: an axis-scoped source with no
    // anchor is waiting on the control above it, and saying "import a dataset" there would
    // send the user somewhere that cannot help. The distinction is the whole reason the
    // resolver returns empty rather than falling back to a project-wide list.
    const dependent = spec.source != null && 'axis' in spec.source
    // The PROJECT-WIDE arm is the one a view may speak for (`empty_text`): it is the only
    // place in the system where "this source offers nothing" is known, so it is the only
    // place that sentence can be stated without a predicate that could be wrong about it.
    // The dependent arm keeps core's wording — a control waiting on the one above it is a
    // different absence, and an import instruction there points at nothing that helps.
    const emptyDescription =
      !dependent && typeof spec.empty_text === 'string' && spec.empty_text.trim() !== ''
        ? spec.empty_text.trim()
        : dependent
          ? ARTIFACT_REF_COPY.emptyDependent
          : ARTIFACT_REF_COPY.emptyDescription
    return (
      <WidgetField
        label={spec.label}
        testid={`${id}-field`}
        ariaLabel={spec.aria_label ?? 'artifact'}
        description={emptyDescription}
      >
        {({ id: controlId, describedBy }) => (
          // `<output>` rather than a `<div>`: `WidgetField` associates its visible label
          // with `htmlFor`, and only a LABELABLE element can be the target — a div would
          // leave the label pointing at nothing, which is the a11y defect the shared field
          // scaffold exists to prevent.
          <output
            id={controlId}
            data-testid={`${id}-empty`}
            data-empty="true"
            aria-describedby={describedBy}
            className="block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          >
            {ARTIFACT_REF_COPY.emptyTitle}
          </output>
        )}
      </WidgetField>
    )
  }

  // The read-only SUMMARY arm belongs to the AUTO-BOUND case ONLY. Without the declaration
  // there is nothing to summarize: no choice has been made, so rendering a summary would state
  // a value the run has not been given — the exact invisible resolution this widget replaced.
  // An undeclared (or refused) sole candidate therefore falls through to the ordinary picker,
  // which offers its one option and lets the user choose it.
  if (candidates.length === 1 && verdict.bind) {
    const only = candidates[0]
    // The summary renders THE BOUND VALUE, not the candidate.
    //
    // It used to render `only.label` unconditionally, which made "what is shown" and "what
    // is held" two independent facts about the same control — and the whole point of this
    // arm is that they are one fact. If the pre-selection below has not landed yet (the
    // effect runs after paint), or cannot land (the dispatch rejects, the store was
    // recreated under it, the action is gone), the old summary went on naming an artifact
    // the run would never receive. That is the invisible resolution this widget replaced,
    // reintroduced one layer up, and it is unfalsifiable from the UI: the form looks
    // resolved and the launch silently binds nothing.
    //
    // Derived from `selected`, the divergence is not merely detected, it is impossible —
    // an unlanded pre-selection reads as "not chosen yet", which is the truth.
    const bound = selected.length === 1 && selected[0] === only.id
    return (
      <WidgetField
        label={spec.label}
        testid={`${id}-field`}
        ariaLabel={spec.aria_label ?? 'artifact'}
        description={ARTIFACT_REF_COPY.soleCandidate}
        detail={detail}
        error={ctx.error}
      >
        {({ id: controlId, describedBy }) => (
          <output
            id={controlId}
            data-testid={`${id}-summary`}
            data-artifact-id={bound ? only.id : ''}
            data-pending={bound ? undefined : 'true'}
            // The ORIGIN of what is held, not of what could be held — so it appears only once
            // the pre-selection has actually landed, for the same reason the value itself
            // does. Marking an unlanded binding would state how a value the run has not been
            // given was chosen, which is the invisible-resolution defect one layer up.
            data-binding-origin={bound ? ORIGIN_AUTO : undefined}
            aria-describedby={describedBy}
            className="flex w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
          >
            {/* The dataset belongs here MOST of all: this is the arm where the choice was made
                for the user, so the control is the only place they can ever read which dataset
                the run is about to consume. */}
            {bound ? <ChosenArtifact id={id} candidate={only} /> : ARTIFACT_REF_COPY.resolving}
            {/* Rendered as TEXT inside the control, not as a `title`/tooltip: a mark that needs
                a gesture to reveal is not visible, and INV-2 says "without hover". */}
            {bound && (
              <Badge data-testid={`${id}-origin`} tone="warning" className="ms-auto shrink-0">
                {ARTIFACT_REF_COPY.autoBoundMark}
              </Badge>
            )}
          </output>
        )}
      </WidgetField>
    )
  }

  if (spec.multiple) {
    return (
      <WidgetField
        label={spec.label}
        testid={`${id}-field`}
        ariaLabel="artifacts"
        description={verdict.refusedBecause}
        detail={detail}
        error={ctx.error}
      >
        {({ id: controlId, ariaLabel, describedBy, invalid }) => (
          <MultiSelect
            id={controlId}
            data-testid={`${id}-select`}
            aria-label={spec.label ?? spec.aria_label ?? ariaLabel}
            aria-describedby={describedBy}
            invalid={invalid}
            // GROUPED by source dataset (see `candidateGroups`). The dataset is a heading, not a
            // label suffix: a suffix goes where truncation eats it first, so the substring that
            // tells two similar options apart is the first thing to disappear. Each option also
            // carries its own TAG rendering, because the heading is gone once the popover closes.
            options={multiOptions(id, candidates)}
            value={selected}
            onChange={(v: string[]) => emit(v)}
            placeholder={ARTIFACT_REF_COPY.placeholder}
            searchPlaceholder={ARTIFACT_REF_COPY.search}
            emptyText={ARTIFACT_REF_COPY.noMatch}
            removeLabel={(l: string) => `Remove ${l}`}
          />
        )}
      </WidgetField>
    )
  }

  const byId = new Map(candidates.map(c => [c.id, c]))

  // ── THE RADIO ARM (owner, DEC-10: *"Row space and Coordinates are RADIO — one active choice
  // each"*) ──────────────────────────────────────────────────────────────────────────────
  //
  // The instruction named a CONTROL. It was read as single-choice SEMANTICS and shipped as a
  // dropdown, and the shipped spec's own prose kept asserting the radio (`coordinates.yaml`:
  // *"§ Coordinates IS the radio, because it is the FRAME"*) — a design and its implementation
  // describing different things while both stayed green.
  //
  // It is DECLARED per widget (`control: radio`) rather than made the default for every
  // `artifact_ref`: this seam serves run forms with hundreds of candidates, where a radio is
  // simply the wrong control. And the frame picker is the one place where seeing every
  // alternative WITHOUT a gesture is the point — an unopened dropdown showing one name gives
  // no hint that a SECOND candidate frame exists, which is precisely the mistake the pane
  // exists to prevent.
  //
  // Above {@link ARTIFACT_REF_RADIO_MAX} it falls back to the list AND SAYS SO.
  const asRadio = spec.control === 'radio' && candidates.length > 0
  const radioOverflowed = asRadio && candidates.length > ARTIFACT_REF_RADIO_MAX
  // Does naming the dataset tell any two of these options apart? Exactly the verdict the
  // grouped list arm already takes — reused, not restated, so the two arms cannot come to
  // disagree about when a source is worth a line.
  const radioGroups = groupCandidates(candidates)
  const datasetDistinguishes = shouldShowGroups(radioGroups)
  /** Draw the group HEADINGS? The same verdict, under its own name because the radio arm asks
   *  it for a second purpose — a heading, not a per-row line — and the two must not drift. */
  const radioGrouped = datasetDistinguishes
  // ── THE SAME RULE, APPLIED TO COVERAGE ────────────────────────────────────────────────
  //
  // Coverage was put on the second line because it is what VARIES between two coordinate sets
  // — but on a picker scoped to one anchored row space it frequently does not: every candidate
  // covers the same rows, so the line repeats one string N times in the slot whose whole job is
  // to tell the options apart. That is the identical defect as the dataset, one fix later, and
  // fixing only the reported instance is how this pane keeps re-earning the same complaint.
  //
  // So a coverage that is true of EVERY option is stated once, above the list, and dropped from
  // the rows. A coverage that differs (a 50-component decomposition beside a 2-D layout) stays
  // on the rows, where it distinguishes. The fact is never lost — only ever said in the place
  // where it says something.
  const coverages = candidates.map(c => c.coverage)
  const sharedCoverage =
    coverages.length > 1 && coverages[0] != null && coverages.every(v => v === coverages[0])
      ? coverages[0]
      : undefined
  /**
   * THE PER-OPTION EMIT CONTROL (ledger #27) — the ▶ the mockup draws on every option row.
   *
   * It is the same icon-only control the emitting sections' rows carry, named for its SUBJECT
   * (the option) rather than for the verb, so a list of ten does not announce ten controls
   * called "Plot".
   *
   * ── Choosing and drawing are two acts on one row ─────────────────────────────────────────
   *
   * kit's radio renders each option's content inside the `<label>` that activates the choice,
   * so a press here would ALSO move the selection — silently reframing the pane as a side
   * effect of asking for a picture. `preventDefault` suppresses exactly that (the label's
   * activation IS the click's default action) and `stopPropagation` keeps the press off the
   * group. The independence is asserted end to end rather than trusted.
   */
  const rowAction = spec.row_action
  const emitRow = (c: ArtifactRefCandidate): React.ReactNode => {
    if (!rowAction?.onClick) return null
    // `$option` — WHICH ROW the press came from, in the view's own vocabulary. It carries the
    // three facts an emitted plot has to keep about the thing it is a picture OF: the identity
    // it is drawn from, the name it was born with, and whose data it is. Nothing here is
    // derived from the pane's CURRENT selection — a row's ▶ is about that row.
    const optionScope: Scope = {
      ...ctx.scope,
      option: { id: c.id, label: c.label, dataset: candidateDatasetLabel(c) },
    }
    const refusal = rowAction.unavailableReason
      ? (() => {
          const v = evalExpr(rowAction.unavailableReason, optionScope)
          return typeof v === 'string' && v.trim() !== '' ? v : undefined
        })()
      : undefined
    // The subject, never the verb (ITEM-30). `label` is the stem the view declared.
    const name = `${rowAction.label ?? 'Plot'} ${c.label}`
    const press = (): void => {
      const args: Record<string, unknown> = {}
      for (const [k, expr] of Object.entries(rowAction.args ?? {})) {
        args[k] = evalExpr(expr, optionScope)
      }
      ctx.dispatch(rowAction.onClick, args)
    }
    // {@link EmitControl} — the pane's ONE emit control (owner, ledger #33). The glyph, the
    // borderless variant and the choose-vs-draw click suppression documented above all live
    // there now, so this arm cannot drift from the column section's and the entry-axis section'.
    if (rowAction.icon === EMIT_ICON) {
      return <EmitControl data-testid={`${id}-emit-${c.id}`} name={name} refusal={refusal} onPress={press} />
    }
    // A row action that is NOT an emit keeps the wordy button: the shared control is the ▶, not
    // "whatever a row_action renders as", and an unrecognised icon must degrade to something
    // readable rather than to an unnamed square.
    return (
      <Button
        variant="ghost"
        data-testid={`${id}-emit-${c.id}`}
        aria-label={name}
        tooltip={refusal ?? name}
        unavailableReason={refusal}
        onClick={(e: React.MouseEvent) => {
          e.preventDefault()
          e.stopPropagation()
          if (refusal !== undefined) return
          press()
        }}
      >
        {rowAction.label ?? 'Plot'}
      </Button>
    )
  }

  if (asRadio && !radioOverflowed) {
    // The option's rendering, one derivation for every group — a candidate reads the same
    // wherever it appears, which is `ChosenArtifact`'s own one-shape rule.
    const radioOption = (c: ArtifactRefCandidate): { value: string; label: React.ReactNode } => ({
      value: c.id,
      label: (
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="flex min-w-0 flex-1 flex-col items-start">
            {/* NEVER the dataset on the row when the list is GROUPED: the heading above already
                says it, and repeating it per option is the constant-in-a-distinguishing-slot
                defect this arm has now paid for twice. */}
            <ChosenArtifact
              id={id}
              candidate={c}
              showDataset={datasetDistinguishes && !radioGrouped}
              showCoverage={sharedCoverage == null}
            />
          </span>
          {emitRow(c)}
        </span>
      ),
    })
    return (
      <WidgetField
        label={spec.label}
        testid={`${id}-field`}
        ariaLabel={spec.aria_label ?? 'artifact'}
        description={verdict.refusedBecause}
        detail={detail}
        error={ctx.error}
      >
        {({ id: controlId, ariaLabel, describedBy, invalid }) => {
          // ONE derivation of what this control is CALLED, read by the group box and by the
          // ungrouped radiogroup. Two spellings of it is how the two came to disagree.
          const controlName = spec.label ?? spec.aria_label ?? ariaLabel
          return (
          <>
          {sharedCoverage ? (
            <p className="mb-1 text-xs text-muted-foreground" data-testid={`${id}-shared-coverage`}>
              {sharedCoverage}
            </p>
          ) : null}
          {/* ── GROUPED UNDER DATASET HEADINGS, and only where there is more than one ──────
              The same verdict the grouped list arm takes (`shouldShowGroups`), reused rather
              than restated: one dataset means the heading would repeat one constant above
              every option, which is the noise this pane refuses everywhere else.
              One `RadioGroup` PER GROUP, because the kit's radio has no heading vocabulary and
              inventing one here would be an app-side fork of a kit control. Single choice
              still holds across the groups by construction — the value is one string, so it
              selects an option in exactly one of them — and each group's accessible name is
              the control's name plus its dataset, so the heading reaches both readers. */}
          {/* THE CONTROL'S STABLE ADDRESS. `${id}-radio` names the CONTROL, and the control is
              one thing whether or not the offer splits into per-dataset groups. It shipped as
              the testid of the single `RadioGroup`, so grouping MOVED it — three specs broke on
              `getByTestId('…-radio')` resolving to two elements — and, worse, a caller could
              not address the control at all without knowing the shape of the data it was
              rendering. The address is now shape-independent by construction: the container
              always exists, the groups are its parts. */}
          <div
            data-testid={`${id}-radio`}
            data-radio-groups={radioGrouped ? radioGroups.length : 1}
            // ── THE CONTROL'S NAME LIVES HERE WHEN THE OFFER GROUPS ────────────────────────
            //
            // Each inner radiogroup used to be named `<control> — <dataset>`, which made EVERY
            // group answer to the control's name: `getByRole('radiogroup', {name: 'Coordinates'})`
            // matched two elements and three specs died on it. That is the SAME defect as the
            // moved testid, one address later — the control changed shape and so did its name.
            //
            // The nesting carries what the concatenated string was reaching for, and it reads
            // better for the same reason: a labelled GROUP containing per-dataset radiogroups
            // announces "Coordinates → Batch B", where two radiogroups both called "Coordinates"
            // announce the control twice and the dataset never.
            {...(radioGrouped ? { role: 'group', 'aria-label': controlName } : {})}
            // A REAL BOX, deliberately not `display: contents`. A contents box is invisible to
            // every geometry-based check — `toBeVisible()` measures a bounding rect — so the
            // stable address would exist in the DOM and be unassertable, which is a subtler
            // version of the defect it is here to fix.
            className="flex w-full flex-col gap-2"
          >
          {radioGroups.map((g, i) => (
            <React.Fragment key={g.datasetIds.join(' ')}>
              {radioGrouped ? (
                <p
                  data-testid={`${id}-group-${i}`}
                  id={`${controlId}-group-${i}`}
                  className="mt-1 text-xs font-medium text-muted-foreground first:mt-0"
                >
                  {g.label}
                </p>
              ) : null}
              <RadioGroup
                // The FIELD's control id belongs to the first group: `WidgetField` points its
                // visible label at it with `htmlFor`, and a label pointing at nothing is the
                // a11y defect the shared field scaffold exists to prevent.
                id={i === 0 ? controlId : `${controlId}-${i}`}
                data-testid={`${id}-radio-group-${i}`}
                // The option's own content is a flex ITEM of kit's row, so it does not stretch
                // and a per-option action would sit tight against the name instead of at the
                // row's right edge (where the mockup puts it, and where every other emitting
                // row in this pane puts it). Grown from the CONSUMER rather than by forking the
                // kit control — one scoped rule, no new component.
                className="[&>div>label]:min-w-0 [&>div>label]:flex-1"
                // GROUPED ⇒ the DATASET alone. The control's own name is on the group box
                // above, so repeating it here would be the constant-in-every-slot defect this
                // whole arm keeps paying for, in the accessible-name channel.
                aria-label={radioGrouped ? g.label : controlName}
                aria-describedby={i === 0 ? describedBy : undefined}
                invalid={invalid}
                // '' is "nothing chosen" and selects no option — the SAME unset spelling the
                // list arm uses, so INV-2's `null` reaches both controls as one shape.
                value={selected[0] ?? ''}
                onChange={(v: string) => emit(v)}
                options={g.candidates.map(radioOption)}
              />
            </React.Fragment>
          ))}
          </div>
          </>
          )
        }}
      </WidgetField>
    )
  }

  return (
    <WidgetField
      label={spec.label}
      testid={`${id}-field`}
      ariaLabel={spec.aria_label ?? 'artifact'}
      // INV-10 — a DECLARED auto-bind that was REFUSED says so, beside the control. Refusing
      // silently would leave a spec author certain their declaration was in force and a user
      // certain the form had simply not filled itself in yet; both would be looking at the same
      // unbound picker with nothing to distinguish it from one that never declared anything.
      //
      // Below it, the one fact about the OFFER that a control must state before the choice: a
      // declared radio that OVERFLOWED into this list is a substitution and not the design.
      description={
        verdict.refusedBecause ??
        (radioOverflowed ? ARTIFACT_REF_COPY.radioOverflowed(candidates.length) : undefined)
      }
      detail={detail}
      error={ctx.error}
    >
      {({ id: controlId, ariaLabel, describedBy, invalid }) => (
        // The kit `Select`, with one GROUP per dataset.
        //
        // This arm was a NATIVE `<select>` with `<optgroup>` headings, and the reason given was
        // that the kit control could not be operated under the shipped-form conformance harness
        // (jsdom): a picker whose affordance cannot be proven operable is worse than a plain one.
        // That reason no longer holds — the harness drives this control end to end (open, read
        // the offered set, choose) and every property that tier asserts is asserted here too.
        // What the native element could NOT do is the defect the user reported: an `<option>` is
        // a flat string, so the closed control could only ever say `expression`, never WHICH
        // dataset's expression, and nothing about the row could truncate on purpose.
        <Select
          id={controlId}
          data-testid={`${id}-select`}
          aria-label={spec.label ?? spec.aria_label ?? ariaLabel}
          aria-describedby={describedBy}
          invalid={invalid}
          // '' is "nothing chosen" and it renders the placeholder. Unlike a native select there
          // is no first-option-auto-shows trap to guard: an unmatched value selects nothing.
          value={selected[0] ?? ''}
          onChange={(v: string) => emit(v)}
          placeholder={ARTIFACT_REF_COPY.placeholder}
          options={singleOptions(candidates)}
          // The SAME search copy the `multiple` arm has always shown. A project with many
          // candidates makes a scroll-only list unusable, and the two arms answering the same
          // question with different words is how one of them gets re-learned late.
          //
          // The dataset is searchable because it is the GROUP HEADING and the kit matches a
          // heading as well as a row — which matters most exactly here: every candidate can be
          // named `expression`, so typing the artifact name narrows nothing and the dataset is
          // the only thing that tells them apart.
          searchPlaceholder={ARTIFACT_REF_COPY.search}
          emptyText={ARTIFACT_REF_COPY.noMatch}
          optionRender={o => {
            // The row sits UNDER its dataset heading, so it names the artifact only — repeating
            // the dataset on every row is the noise `shouldShowGroups` already refuses.
            const label = byId.get(o.value)?.label ?? o.value
            return (
              <span className="flex min-w-0 items-baseline">
                <span className="truncate" title={label}>
                  {label}
                </span>
              </span>
            )
          }}
          labelRender={o => {
            const c = o ? byId.get(o.value) : undefined
            if (c) return <ChosenArtifact id={id} candidate={c} />
            // Bound to something this source no longer offers (a detached dataset, a changed
            // `source`). Render NOTHING rather than let the raw id surface: an artifact id is
            // not a name, and the control must not claim a choice the list cannot show.
            return selected.length > 0 ? '' : undefined
          }}
          // A two-line value in a control sized for one: drop the fixed height and the
          // one-line clamp the kit's trigger applies to its value slot. `cn`'s twMerge drops the
          // conflicting base classes, so these REPLACE them rather than race them.
          className="h-auto min-h-8 py-1.5 data-[size=default]:h-auto *:data-[slot=select-value]:block *:data-[slot=select-value]:line-clamp-none *:data-[slot=select-value]:min-w-0"
        />
      )}
    </WidgetField>
  )
}

export const ArtifactRefRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as ArtifactRefWidgetSpec
  const { artifacts, lattice } = readCatalogScope(ctx.scope)
  const candidates = resolveArtifactRefSource(artifacts, w.source, ctx.scope, { lattice })
  return (
    <ArtifactRefControl
      spec={w}
      ctx={ctx}
      candidates={candidates}
      selected={boundIds(w, ctx.scope)}
      artifacts={artifacts}
    />
  )
}
