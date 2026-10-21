// THE ENTRY-ROW DESCRIPTION (visualize-pane ITEM-47 … ITEM-58) — what one entry of a sibling
// axis READS as, so a section can list an OPEN SET the way `row_space_columns` lists a closed
// one.
//
// ── An annotation is a COLUMN on the entry axis, and that removes a subsystem ───────────
//
// ITEM-47 is the whole architecture of this module in one sentence: the alternative names a
// row can display are ordinary `metadata-column` artifacts declaring the ENTRY axis, exactly
// as the columns `row_space_columns` lists declare the ROW-SPACE axis. So there is no
// annotation registry, no annotation datatype and no annotation concept anywhere below this
// file — {@link resolveAxisEntryRows} enumerates columns with the same declaration rules the
// rest of the pane uses, and the word "annotation" here names a ROLE a column plays in one
// section's header, not a kind of thing.
//
// ── What it reads, and why that is not INV-11's eager scan ──────────────────────────────
//
// INV-11 forbids reading a column BODY *to describe a column*. That is not what happens here
// and the distinction is exact: the rows of this list ARE the entries, and an entry's
// displayed name IS a value of a column — no declaration enumerates 18,000 labels, and a
// producer could not stamp them into `meta` if it wanted to. So the values are read, under
// the SAME bound `axis_entries` already refuses above ({@link ENTRY_BROWSE_MAX}), and the
// LISTING half — which columns exist, what they are called, which one groups — stays
// meta-only and costs nothing.
//
// The read set is every offered annotation column, not just the displayed one, and that is
// ITEM-50's requirement rather than an over-read: *"search matches EVERY annotation, and the
// row says which one hit"*. Reading only the displayed column would make someone pasting a
// key under a header showing something else get no result — the *"perverse"* refusal the
// design names.
//
// ── Nothing here is domain-shaped ──────────────────────────────────────────────────────
//
// The vocabulary is entries, rows, annotations and groups. WHICH axis a section lists, what
// its groups mean and what an annotation is called are all the package's declarations — the
// same split INV-14 states for the pane as a whole.

import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import {
  candidateLabel,
  declaredAxes,
  matchesTypeFilter,
  type ArtifactTypeFilter,
  type AxisResolveOptions,
  type RowSpaceAnchor,
} from './axisSource'
import { entryValueCandidates, type EntryAxis } from './axisEntries'
import { NO_COORDINATE_REFUSAL } from './rowSpaceColumns'

/** The `data.<slice>.source` value that selects this resolver. */
export const AXIS_ENTRY_ROWS_SOURCE = 'axis_entry_rows'

/**
 * The member ENCODINGS a column may declare and still be offered as a DISPLAY name.
 *
 * A name is text. A numeric member is a measurement, and offering one here would turn the
 * header select into a measurement picker whose chosen "name" is `0.0193` on every row — a
 * control that works and answers a question nobody asked. The two encodings below are the
 * two the reader can turn into text at all (`artifactReader`'s own TEXT_MEMBER_KINDS union:
 * `string` is inline utf8, `categorical` is dictionary-encoded with a declared level set),
 * so this is a decodability rule and not a taste one.
 */
const TEXT_MEMBER_KINDS: ReadonlySet<string> = new Set(['string', 'categorical'])

/** The `meta` key by which a column DECLARES that it groups the entries of its axis
 *  (ITEM-53 / INV-16). */
export const GROUPS_ENTRIES_META_KEY = 'groups_entries'

/**
 * Does this column declare that it groups its axis's entries? (ITEM-53, DEC-6.)
 *
 * THE single typed accessor for the frontend's first direct `meta.*` read, which is what
 * DEC-6 resolved it to: the value is already on the wire (`Artifact.meta`), deriving it
 * server-side would put a verbatim copy of it beside itself, and one accessor is the whole
 * concession to the phase-2 finding that no production FE code reads `meta` today — one
 * place to change if it ever does become derived.
 *
 * `true` and only `true`, on the shipped `meta.is_axis_index` precedent: *"the producer SAYS
 * this artifact is a key artifact. That is a declaration, not a naming convention."* A
 * string `"true"`, a `1` and an absent key are all NOT a declaration.
 */
export function declaresGroupsEntries(meta: unknown): boolean {
  return meta != null && typeof meta === 'object' && (meta as Record<string, unknown>)[GROUPS_ENTRIES_META_KEY] === true
}

/**
 * One column offered as a display name for the entries — the `Show:` header's options
 * (ITEM-48).
 *
 * Shaped as the engine's ordinary OPTION record (`{value, label}`) rather than as a bespoke
 * pair, so the header renders through the same normalization every other closed-set control
 * uses and no second option vocabulary enters the language. `value` is the IDENTITY (the
 * artifact id, or `''` for the key); `label` is display and is never keyed on (INV-1).
 */
export interface EntryAnnotation {
  /** the artifact this annotation IS. For the KEY option that is the AXIS artifact itself —
   *  a real identity rather than a sentinel, so an unset `show` (`null`) and a chosen "show me
   *  the key" are two different states and INV-2's *"`null` is the only unset"* holds without a
   *  magic empty string entering the option set. */
  value: string
  /** what the option READS as. For the key it is the datatype's declared `key_label`. */
  label: string
  /** whether this option is the axis KEY itself. Exactly one option carries it. */
  is_key: boolean
  /** whether this column declared {@link declaresGroupsEntries}. Display of the flag is the
   *  view's business; the fact is the engine's. */
  groups: boolean
}

/** One entry, described as a ROW of the section's list. */
export interface AxisEntryRow {
  /** THE IDENTITY (INV-1 / ITEM-57). Everything emitted carries this and never the label:
   *  a displayed name may be deprecated, reused or re-annotated, and a stored label would
   *  silently change meaning. */
  key: string
  /** what the row READS as — the displayed annotation's value, or {@link AxisEntryRow.key}
   *  when that annotation has no value here (ITEM-51). */
  label: string
  /** ITEM-51 — the explicit `— no <Annotation>` note, or `null`. A row with no value under
   *  the chosen header shows its KEY and SAYS the value is absent; it never silently falls
   *  back to another annotation, because a list that quietly mixes two vocabularies is
   *  unreadable precisely when it looks fine. */
  missing_note: string | null
  /** the declared group this entry belongs to, or `null` when no column groups the axis. */
  group: string | null
  /**
   * ITEM-52 / INV-17 — the qualifier this row carries IN THE LIST, or `null`.
   *
   * Present only when the displayed name is CONTESTED (two rows read the same), which is
   * `mintColumnKeys`' shipped contested-only rule at the entry level: a list is SCANNED, so
   * a qualifier on every row is noise.
   *
   * WHAT it qualifies WITH is the ladder {@link entryDistinguisher} walks, and the rung below
   * the declared group is the entry's own KEY. Qualifying only when a column declared
   * `groups_entries` would answer the contest on ONE import path and leave the ordinary
   * ungrouped one producing two byte-identical rows — the same name, no qualifier, nothing on
   * the row that says which entry it is. The key is not a storage index and does not become
   * one by being used here: it is the identity this row already carries ({@link
   * AxisEntryRow.key}), the thing every emitted plot is keyed on, and the only distinguisher
   * that exists whether or not anyone declared a grouping. What the ladder still never reaches
   * for is the storage-mangled/deduplicated column name — `<name>-1` — which is invented by
   * storage, means nothing to the reader and is exactly what INV-15 keeps out of the science.
   */
  qualifier: string | null
  /**
   * ITEM-58 — the name an EMITTED plot of this entry carries, which ALWAYS qualifies.
   *
   * Deliberately not {@link AxisEntryRow.qualifier}: a title is read alone with no
   * neighbours to compare against, so there is no contest to detect and under-qualifying is
   * simply ambiguous. It also means a title cannot go stale when the contested set changes
   * later — the plot reads the same whether or not a same-named entry happens to exist today.
   *
   * So it qualifies with the SAME ladder and simply skips the contest test: the declared group
   * when a column declares one, otherwise the entry's key. Two plots of two entries that
   * happen to share a displayed name are therefore always two distinguishable pictures, with
   * or without a grouping column — before this, an ungrouped pane emitted two plots carrying
   * one title, which is the two-pictures-nobody-can-tell-apart failure ITEM-58 names.
   */
  title: string
  /** every annotation's value for this entry, in the header's own option order — the search
   *  corpus (ITEM-50) and the source of the `matched <Annotation> · <value>` sub-line. */
  values: ReadonlyArray<{ title: string; value: string }>
  /** ITEM-39's gate shape (`unavailableReason`, ITEM-29c) for this row's ▶, or `null`. A
   *  non-empty string IS the refusal, so a ▶ that cannot plot can never be pressed silently
   *  — the dead-control failure this round exists to remove. */
  plot_refusal: string | null
}

/** One declared group and how many entries it holds (ITEM-54). */
export interface EntryGroup {
  name: string
  count: number
}

/** The whole answer for one `axis_entry_rows` binding. ALWAYS total — every absence is a
 *  state in the payload rather than a missing slice, on `row_space_columns`' rule: a view
 *  has to be able to say WHICH emptiness it is looking at, and a slice STATUS carries one. */
export interface AxisEntryRows {
  rows: AxisEntryRow[]
  count: number
  /** the axis's DECLARED entry count, present even when the list is refused — `4,100,000
   *  entries` is exactly what makes a refusal legible. */
  length: number
  /** whether a row space is anchored at all (A0 vs anchored-and-empty). */
  anchored: boolean
  /** whether the entries resolved and were listed. */
  browsable: boolean
  /** WHY there is no list, or `null`. */
  refusal: string | null
  /** the `Show:` options, key first (ITEM-48/ITEM-49). */
  annotations: EntryAnnotation[]
  /** ITEM-56 — whether the header select should RENDER at all. One declared annotation is
   *  nothing to distinguish, so the control does not exist rather than existing disabled. */
  show_select: boolean
  /** the RESOLVED chosen annotation (`''` = the axis key). Resolved rather than echoed: a
   *  stored choice naming a column this row space does not have falls back to the key and
   *  says so, instead of displaying nothing. */
  show: string
  /** what the header reads. */
  show_title: string
  /** ITEM-49 — the header is on its DEFAULT (the axis key), so the section can SAY that is
   *  what it picked rather than appearing to have been configured. */
  show_is_default: boolean
  /** ITEM-49's *"and the section SAYS that is what it picked"* — the sentence, or `null`.
   *  Present only while the choice is the DEFAULT and there was an alternative: a section with
   *  one option had no decision to report, and a section showing what the user chose does not
   *  need to explain it back to them. */
  show_note: string | null
  /** the declared groups with counts, in first-appearance order (ITEM-54). Empty when no
   *  column groups the axis. */
  groups: EntryGroup[]
  /** ITEM-56 — whether headings should render. ONE group is not a grouping. */
  grouped: boolean
  /** how many artifacts carry values for these entries against the anchored row space — the
   *  ▶'s availability, and it is entry-INDEPENDENT (candidacy is "declares this axis"). */
  n_sources: number
  /**
   * WHICH artifacts those are — one list for the whole axis, not one per entry.
   *
   * Entry-independence is a property of the candidate rule and not a simplification: an
   * artifact that declares this axis is indexed by its keys, so it carries EVERY entry of it
   * (`entryValueCandidates`' third condition). Two entries therefore always resolve to the
   * same sources, and a `{ entry → sources }` map of 18,000 identical arrays would be the same
   * fact written 18,000 times. `axis_entry_values`' `as: sources` arm still answers per entry,
   * because it answers about CHOSEN entries and its shape is the disposition's input.
   */
  sources: EntrySourceRef[]
  /**
   * PRESENCE. `true` on every answer this resolver produces, and therefore ABSENT (undefined)
   * exactly when the slice never answered at all — a failed read, or a widget rendered in a
   * terminal `error`/`empty` region arm, where `DeclarativeRegion` keeps widgets mounted and
   * `$data.entries` is simply not there.
   *
   * It exists because a `when:` predicate cannot otherwise tell "no reason to refuse" from "the
   * slice never answered": `evalWhen`'s `!=` arm is a strict `!==`, so `$data.entries.refusal !=
   * null` is TRUE for an undefined slice and the section renders an alert whose `text` is
   * undefined — an empty info box as its only surface. This is the same defect round 1 closed on
   * `PaneFrame` with the same witness, arriving on a second slice: **gate on a RESOLVED FACT,
   * never on the absence of a value.**
   */
  resolved: boolean
}

/** One artifact that can supply values for these entries. `(artifact, selector)` is the
 *  identity; `title` is display only (INV-1). The selector is the ENTRY key and so is supplied
 *  per press rather than stored here. */
// The THREE alignment fields this ref used to carry — `alignment_unknown`, `alignment_mark`
// and `plot_note` — are DELETED (owner, ledger #28 + #29). See the note at the top of
// `rowSpaceColumns.ts`: the OFFER is unchanged (these sources are still every source they
// were), only the telling went.
export interface EntrySourceRef {
  artifact: string
  datatype: string
  title: string
}

/** The empty answer — nothing anchored, nothing attempted, nothing claimed. */
export const NO_AXIS_ENTRY_ROWS: AxisEntryRows = {
  rows: [],
  count: 0,
  length: 0,
  anchored: false,
  browsable: false,
  refusal: null,
  annotations: [],
  show_select: false,
  show: '',
  show_title: '',
  show_is_default: true,
  show_note: null,
  groups: [],
  grouped: false,
  n_sources: 0,
  sources: [],
  // NO_AXIS_ENTRY_ROWS is a real ANSWER (the resolver returning "nothing anchored"), not the
  // absence of one — so it is resolved. Only a slice that never ran is unresolved.
  resolved: true,
}

/** The sentence a row with no value under the chosen header states (ITEM-51). Exported so
 *  the spec pins the literal and the attribution cannot drift into a silent fallback. */
export function missingNoteFor(annotationTitle: string): string {
  return `— no ${annotationTitle}`
}

/** The refusal every row's ▶ carries when nothing on the anchored row space can supply the
 *  entries' values (ITEM-39's gate applied to the section's own precondition). Stated on the
 *  CONTROL rather than by hiding it: a list that offers rows whose ▶ silently does nothing
 *  is the inert-affordance failure, and hiding the ▶ would leave the reader with no
 *  explanation for why this list cannot be plotted. */
export const NO_ENTRY_SOURCES_REFUSAL =
  'Nothing on these rows carries values for these entries, so there is nothing to plot yet.'

/** Two columns both claiming to group the axis. Refused rather than arbitrated: taking the
 *  first would be `[0]` with a declaration wrapped round it (INV-3), and the two would group
 *  the same list two different ways. */
export function ambiguousGroupingRefusal(titles: readonly string[]): string {
  return (
    `${titles.length} columns declare that they group these entries (${titles.join(', ')}), so ` +
    'nothing groups them. One of them should stop declaring it.'
  )
}

/** ITEM-49's sentence. Exported so the spec pins the literal rather than re-typing it. */
export function defaultShowNote(title: string): string {
  return `Showing the ${title} — this list's own default, because it is the one name every entry has.`
}

/** The fallback title for the axis KEY option when the datatype declares no `key_label`.
 *  Neutral, and never invented from a column name — inventing one would be the *"first
 *  aligned string column"* default ITEM-49 refuses, one level down. */
export const DEFAULT_KEY_TITLE = 'Key'

/** What the DATATYPE registry declares about one datatype's axes — the only thing this
 *  module needs from it, taken as a port so the resolver stays unit-drivable with a plain
 *  map and never reaches for a module-global registry. */
export type DeclaredAxesOf = (datatypeId: string) => ReadonlyArray<{ name?: string; key_label?: string }> | undefined

/**
 * What the axis's own KEY is CALLED (ITEM-49) — the datatype-declared `key_label`, resolved
 * across the datatypes actually present in this project.
 *
 * It cannot be read off the key artifact's own datatype: `key_label` is declared by the
 * PRIMARY datatype that owns the axis (`axes: [{ name, key_label }]`), while the key artifact
 * itself is an ordinary column. So the question is asked of every datatype the project holds,
 * and answered only when they AGREE — two datatypes declaring the same axis name with two
 * different key labels is a genuine disagreement, and picking one would be `[0]` over a
 * declaration set (INV-3). Disagreement (and absence) fall back to {@link DEFAULT_KEY_TITLE},
 * which claims nothing.
 */
export function resolveKeyLabel(
  artifacts: readonly ArtifactRow[],
  axisLabel: string,
  axesOf: DeclaredAxesOf,
): string | undefined {
  const found = new Set<string>()
  for (const datatype of new Set(artifacts.map(a => a.datatype))) {
    for (const axis of axesOf(datatype) ?? []) {
      if (axis?.name !== axisLabel) continue
      const label = typeof axis.key_label === 'string' ? axis.key_label.trim() : ''
      if (label !== '') found.add(label)
    }
  }
  return found.size === 1 ? [...found][0] : undefined
}

/** The `args` an `axis_entry_rows` slice declares. */
export interface AxisEntryRowsArgs extends ArtifactTypeFilter {
  /** a `$`-ref to the anchored row space's identity (an `AxisSummary.content_hash`). */
  axis_of?: string
  /** the sibling axis's declared LABEL, within that row space. */
  axis?: string
  /** a `$`-ref to the CHOSEN annotation's artifact id — SECTION state (ITEM-60), never pane
   *  state: it is a display preference of one section, and pane state is closed at two
   *  values (INV-13). `''`/absent ⇒ the axis key (ITEM-49). */
  show?: string
  /** the datatype filter for the VALUE candidates the ▶ needs (`n_sources`). Distinct from
   *  the inherited annotation filter above, which narrows what the header may DISPLAY. */
  values_datatype?: string
  /** a `$`-ref to the CHOSEN COORDINATE artifact's id (`$scope.coordinate`) — the same arg
   *  `row_space_columns` takes, and for the same reason. An entry's ▶ emits a plot drawn in
   *  the pane's frame, so with no coordinate chosen there is no frame to draw it in and the
   *  row REFUSES, in the words {@link NO_COORDINATE_REFUSAL} spells for every surface. Absent
   *  / unresolved ⇒ unframed ⇒ refused: the safe direction, because the alternative is the
   *  silent `layouts[0]` picture this gate exists to make unreachable. */
  coordinate?: string
}

/** One annotation column's values, read once. Injected, so this module does no IO. */
export type ReadAnnotationValues = (row: ArtifactRow) => Promise<readonly string[]>

/** What a section needs to know about the axis's own KEY before any read: what to call it.
 *  Injected as a plain string because only the caller holds the datatype registry, and a
 *  resolver that reached for a global registry would be untestable without one. */
export interface EntryAxisDisplay {
  /** the datatype-declared `key_label` for this axis, or `undefined` when none is declared. */
  key_label?: string
}

/**
 * Which columns may DISPLAY these entries — PURE, meta-only, zero reads.
 *
 * Three conditions, each a declaration:
 *   · it declares the ENTRY axis (so it carries one value per entry, by construction);
 *   · it passes the view's declared type filter (KIND — what the section said it wants);
 *   · it declares a single TEXT-bearing member ({@link TEXT_MEMBER_KINDS}).
 *
 * `offeredOnRowSpace` is deliberately NOT applied. That predicate asks whether an artifact's
 * values line up with the ANCHORED ROW SPACE, and an annotation lines up with the ENTRY axis
 * instead — applying it here would drop every annotation the section exists to display,
 * which is the kind of near-miss a shared predicate invites and a comment is cheaper than.
 */
export function entryAnnotationCandidates(
  artifacts: readonly ArtifactRow[],
  axis: EntryAxis,
  filter: ArtifactTypeFilter,
  opts?: AxisResolveOptions,
): ArtifactRow[] {
  return artifacts.filter(
    a =>
      a.id !== axis.artifact &&
      declaredAxes(a.structure).includes(axis.label) &&
      matchesTypeFilter(a, filter, opts) &&
      textMemberCount(a.structure) === 1,
  )
}

/** How many TEXT-bearing 1-D members a structure declares. */
function textMemberCount(structure: unknown): number {
  if (structure == null || typeof structure !== 'object') return 0
  const cols = (structure as { columns?: unknown }).columns
  if (!Array.isArray(cols)) return 0
  return cols.filter(c => {
    const kind = (c as { kind?: unknown } | null)?.kind
    return typeof kind === 'string' && TEXT_MEMBER_KINDS.has(kind)
  }).length
}

/**
 * The `Show:` options for an axis — the KEY first, then every offered annotation column by
 * title. PURE.
 *
 * The key is FIRST and is the default (ITEM-49): it is the one option guaranteed to exist
 * and to be identity-bearing, and every alternative default — *"the first aligned string
 * column"* — is `layouts[0]` in another costume.
 */
export function entryAnnotationOptions(
  axis: EntryAxis,
  candidates: readonly ArtifactRow[],
  display: EntryAxisDisplay | undefined,
): EntryAnnotation[] {
  const key: EntryAnnotation = {
    value: axis.artifact,
    label: display?.key_label?.trim() || DEFAULT_KEY_TITLE,
    is_key: true,
    groups: false,
  }
  const rest = candidates
    .map(row => ({
      value: row.id,
      label: candidateLabel(row),
      is_key: false,
      groups: declaresGroupsEntries(row.meta),
    }))
    // Stable and DECLARED — by title, so the header does not reorder itself between two
    // catalog reads that returned the same rows in a different order. Not by "importance":
    // there is no such declaration to read.
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
  return [key, ...rest]
}

/** The one column that declares it groups the axis, `undefined` when none does, or the
 *  REFUSAL when more than one does. */
export function resolveGroupingColumn(candidates: readonly ArtifactRow[]): {
  row?: ArtifactRow
  refusal?: string
} {
  const declared = candidates.filter(c => declaresGroupsEntries(c.meta))
  if (declared.length === 0) return {}
  if (declared.length === 1) return { row: declared[0] }
  return { refusal: ambiguousGroupingRefusal(declared.map(candidateLabel)) }
}

/** What one annotation column reads as at position `i`, or `''`. A value that is absent,
 *  blank or whitespace is ABSENT — a name made of spaces is not a name, and treating it as
 *  one produces a row that looks unlabelled and cannot be searched for. */
function valueAt(values: readonly string[] | undefined, i: number): string {
  const raw = values?.[i]
  return typeof raw === 'string' ? raw.trim() : ''
}

/** The inputs {@link describeEntryRows} needs beyond the keys — one already-read column per
 *  annotation artifact id. */
export type AnnotationValues = ReadonlyMap<string, readonly string[]>

/**
 * WHAT distinguishes this row from another reading the same name — one rung of a declared
 * ladder, or `null` when the row already distinguishes itself.
 *
 * The ladder, highest rung first:
 *
 *   1. the DECLARED group (`meta.groups_entries`) — a producer said what its column is for,
 *      and a declaration outranks anything this module could derive;
 *   2. the entry's own KEY — the axis's identity, present on every row of every axis, and the
 *      answer when nobody declared a grouping (the ordinary case, and the one the group-only
 *      rule silently failed);
 *   3. nothing. NOT a storage index: `<name>-1` is minted by storage to keep two columns apart
 *      in a file, it names nothing the reader can look up, and it is precisely what INV-15
 *      keeps out of the science.
 *
 * A rung that READS AS THE LABEL ALREADY is skipped rather than appended, on both sides for
 * the same reason: `k-3 (k-3)` and `left (left)` are stutters that add a parenthesis and no
 * information. So a row whose displayed annotation has fallen back to its key (ITEM-51) shows
 * the key ONCE and stops — the label already IS the identity, and there is nothing below it to
 * fall to. A row displaying the grouping column itself falls PAST the group to the key, which
 * is a real distinguisher rather than a repetition.
 */
export function entryDistinguisher(label: string, key: string, group: string | null): string | null {
  for (const rung of [group, key]) {
    if (rung != null && rung !== '' && rung !== label) return rung
  }
  return null
}

/**
 * Describe every entry as a row. PURE over already-read columns, so the whole display rule
 * — label, missing note, group, contested qualifier, always-qualified title — is unit-driven
 * with plain arrays and no catalog, no port and no network.
 */
export function describeEntryRows(
  keys: readonly string[],
  annotations: readonly EntryAnnotation[],
  values: AnnotationValues,
  grouping: { artifact: string } | undefined,
  plotRefusal: string | null,
): AxisEntryRow[] {
  const groupValues = grouping ? values.get(grouping.artifact) : undefined
  // Which annotation is DISPLAYED is decided by the caller, which passes it first — see
  // {@link resolveAxisEntryRows}. Position 0 here is the caller's own declaration and not a
  // discovered order, which is the distinction INV-3 is about.
  const shown = annotations[0]
  const shownValues = shown && !shown.is_key ? values.get(shown.value) : undefined

  const labels: string[] = []
  for (let i = 0; i < keys.length; i++) {
    const v = shown && shown.is_key ? keys[i] : valueAt(shownValues, i)
    labels.push(v === '' ? keys[i] : v)
  }
  // The CONTEST is computed over the whole list, because "is this name shared?" is a fact
  // about the list and a row on its own cannot answer it — the same reason `row_space_columns`
  // computes its aggregates centrally.
  const occurrences = new Map<string, number>()
  for (const l of labels) occurrences.set(l, (occurrences.get(l) ?? 0) + 1)

  const rows: AxisEntryRow[] = []
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const displayed = shown && shown.is_key ? key : valueAt(shownValues, i)
    const label = labels[i]
    const group = groupValues ? valueAt(groupValues, i) || null : null
    const contested = (occurrences.get(label) ?? 0) > 1
    // ONE ladder for both, walked once ({@link entryDistinguisher}); the two differ ONLY in
    // whether the contest is consulted, which is the whole of the list-vs-title distinction.
    const distinguisher = entryDistinguisher(label, key, group)
    const qualifier = contested ? distinguisher : null
    rows.push({
      key,
      label,
      missing_note: shown && !shown.is_key && displayed === '' ? missingNoteFor(shown.label) : null,
      group,
      qualifier,
      // ALWAYS qualified (ITEM-58) — with the group where one is declared and with the key
      // where none is, including for an entry that is uncontested today and becomes contested
      // later. A title is read alone, so it cannot wait to find out.
      title: distinguisher ? `${label} (${distinguisher})` : label,
      values: annotations.map(a => ({
        title: a.label,
        value: a.is_key ? key : valueAt(values.get(a.value), i),
      })),
      plot_refusal: plotRefusal,
    })
  }
  return rows
}

/** Group counts in FIRST-APPEARANCE order — the axis's own order, which is the only order
 *  anything here is entitled to. Sorting by size would be a judgement about which group
 *  matters, and sorting by name would hide the axis's own arrangement. */
export function groupsOf(rows: readonly AxisEntryRow[]): EntryGroup[] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (r.group == null) continue
    counts.set(r.group, (counts.get(r.group) ?? 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }))
}

/**
 * Resolve an `axis_entry_rows` slice.
 *
 * The ORDER of the work is the whole of INV-11's bound: the axis is resolved and its
 * annotations enumerated from declarations first, and the reads happen only on the browse
 * arm — so an unanchored pane, an absent axis, an ambiguous label and an over-budget axis
 * each cost ZERO bytes, exactly as {@link resolveAxisEntries} does.
 */
export async function resolveAxisEntryRows(
  artifacts: readonly ArtifactRow[],
  axis: EntryAxis | undefined,
  anchor: RowSpaceAnchor | undefined,
  args: AxisEntryRowsArgs,
  entries: { entries: readonly string[]; length: number; anchored: boolean; browsable: boolean; refusal: string | null },
  display: EntryAxisDisplay | undefined,
  read: ReadAnnotationValues,
  opts?: AxisResolveOptions,
): Promise<AxisEntryRows> {
  if (!axis) {
    return { ...NO_AXIS_ENTRY_ROWS, anchored: entries.anchored, length: entries.length, refusal: entries.refusal }
  }
  const candidates = entryAnnotationCandidates(artifacts, axis, args, opts)
  const options = entryAnnotationOptions(axis, candidates, display)
  const grouping = resolveGroupingColumn(candidates)
  // A stored choice naming a column this row space does not have resolves BACK to the key
  // rather than to nothing: the header is a display preference and the list still has to be
  // readable. It is not a silent substitution — the key is the declared default and the
  // section says so.
  const asked = typeof args.show === 'string' ? args.show : ''
  const chosen = options.find(o => o.value === asked) ?? options[0]
  const ordered = [chosen, ...options.filter(o => o !== chosen)]

  const valueRows = anchor
    ? entryValueCandidates(
        artifacts,
        axis,
        anchor,
        args.values_datatype === undefined ? {} : { datatype: args.values_datatype },
        opts,
      )
    : []
  // NO A3 MARK ON THE VALUE SOURCES — retired with every other alignment mark in this pane
  // (owner, ledger #28 + #29; see the note at the top of `rowSpaceColumns.ts`). The sources
  // themselves are unchanged: every artifact that could supply values before still does.
  const sources: EntrySourceRef[] = valueRows.map(row => ({
    artifact: row.id,
    datatype: row.datatype,
    title: candidateLabel(row),
  }))
  const nSources = sources.length
  const base: AxisEntryRows = {
    ...NO_AXIS_ENTRY_ROWS,
    length: entries.length,
    anchored: entries.anchored,
    browsable: entries.browsable,
    refusal: grouping.refusal ?? entries.refusal,
    annotations: options,
    // ITEM-56 — one option is nothing to distinguish, so the control does not RENDER. The
    // key alone is one option.
    show_select: options.length > 1,
    show: chosen.value,
    show_title: chosen.label,
    show_is_default: chosen.is_key,
    show_note: chosen.is_key && options.length > 1 ? defaultShowNote(chosen.label) : null,
    n_sources: nSources,
    sources,
  }
  if (!entries.browsable) return base

  // The reads. Every offered annotation, because search matches every one of them (ITEM-50)
  // — and each is the SAME bounded column the keys already are.
  const values = new Map<string, readonly string[]>()
  await Promise.all(
    candidates.map(async row => {
      try {
        values.set(row.id, await read(row))
      } catch (e) {
        // One unreadable annotation costs THAT annotation, not the list: "this column will
        // not open" and "there is nothing here" are different situations, and a list that
        // vanished because one of five columns failed would report the wrong one.
        console.error(`[declarative] axis_entry_rows: could not read annotation ${row.id}`, e)
      }
    }),
  )
  // THE FRAME GATE (ITEM-39), the entry-axis twin of `row_space_columns`'. Precedence is the
  // same and for the same reason: a row with its OWN permanent reason keeps it, because
  // choosing a coordinate would not make that row available and naming the actionable reason
  // when acting changes nothing is the less informative answer.
  const framed =
    typeof args.coordinate === 'string' &&
    args.coordinate !== '' &&
    artifacts.some(a => a.id === args.coordinate)
  const rows = describeEntryRows(
    entries.entries,
    ordered,
    values,
    grouping.row ? { artifact: grouping.row.id } : undefined,
    nSources === 0 ? NO_ENTRY_SOURCES_REFUSAL : framed ? null : NO_COORDINATE_REFUSAL,
  )
  const groups = groupsOf(rows)
  return {
    ...base,
    rows,
    count: rows.length,
    groups,
    // ITEM-56 at the group level — ONE group is not a grouping, and a single heading over
    // everything is noise.
    grouped: groups.length > 1,
  }
}
