// The CROSS-DATASET column OFFER — which per-entity columns two or more datasets could be
// asked to mean the same thing (ITEM-35), decided from the CATALOG and nothing else.
//
// ── WHAT THIS IS, AND THE ONE THING IT MUST NOT BECOME ──────────────────────────────────
//
// It is an OFFER FILTER. It decides what the integration form LISTS; the USER still declares
// the fusion (INV-1). Its predecessor on the abandoned round was built to INFER compatibility
// at view time and fuse on that inference — that use is superseded and must not come back.
// Nothing here writes, selects, or pre-checks anything: it answers "could these two columns
// be the same vocabulary?" and hands the answer to a person.
//
// ── WHY IT CANNOT READ A BODY (INV-11) ──────────────────────────────────────────────────
//
// A form listing every shared column of two datasets would, on a real import, open dozens of
// column bodies merely because the pane was opened. The tree already refused that affordance
// once, in writing:
//
//     "There is deliberately NO per-row 'read it now' affordance. It is cheap once and
//      ruinous forty times, and the only thing that would make it safe is a budget —
//      inventing a budget to make an affordance safe is evidence the affordance is wrong."
//     — the recorded refusal of the per-row read affordance, in the product tree
//
// So this resolver issues exactly ONE `artifacts.query({})` and NO artifact read at all, like
// `row_space_columns` beside it. Everything it reports is a PRODUCER DECLARATION already on
// the catalog row.
//
// ── WHAT THE CATALOG CAN ACTUALLY ANSWER, measured rather than assumed ──────────────────
//
// `meta.categories` provably cannot: it is capped at 50 entries AND 1024 bytes
// (`_helpers/colsummary.py`), and a count does not bound bytes.
//
// What can is the ITEM-51 pair, stamped by `txr_zarr.Table.categorical` onto the column
// member's own declaration and carried to this client inside `ArtifactRow.structure`. Read
// off the running writer rather than from prose — `txr_columns.write_metadata_column` over a
// 3-level categorical returns:
//
//     structure.columns[0] = { path: "values", kind: "categorical", n_levels: 3,
//                              ordered: false, levels_digest: "9f6af06…",
//                              vocab_digest: "59cc3cf…", vocab_sketch: "aS9q5d+45NCqvH1cgLySaPqjM7SawjIk" }
//
//   · `vocab_digest` is an ORDER-INDEPENDENT SET HASH → answers EQUALITY only.
//   · `vocab_sketch` is the sorted per-level 8-byte short hashes, base64'd → answers SUBSET,
//     because subset needs the elements and a set hash does not have them.
//   · `levels_digest` is ORDER-SENSITIVE and answers NEITHER question. It pins the sequence
//     the codes index into. It is deliberately not consulted here: two datasets carrying one
//     vocabulary written in two orders are the SAME vocabulary, and reading the ordered digest
//     would offer them separately forever while looking like an honest mismatch.
//
// ── THE UNDECIDABLE ARM IS A PRIMARY PATH, NOT A FALLBACK ───────────────────────────────
//
// Both ITEM-51 fields are dropped TOGETHER above `MAX_VOCAB_SKETCH_BYTES` (64 KiB), which
// measures out at 6,144 levels. So the pair is present for `50 < n <= 6144` — the middle band
// — and ABSENT for the entire high-cardinality tail: a 35,477-level very-wide-vocabulary column gets no
// pair at all, and neither does anything like it. That tail is not an edge case, it is most of
// what a user will actually try to align.
//
// Such a pair is `undecidable` and is OFFERED (DEC-19), marked as unverified. Never hidden,
// and never called incompatible: "we could not check" and "these differ" are different facts
// with different remedies, and a form that renders the first as the second tells the user
// their data disagrees when nothing has been compared.
//
// The writer's both-or-neither rule is what makes the absence readable at all: there is no
// path through `vocab_declaration` that emits one field without the other, so EXACTLY ONE
// PRESENT means something rewrote one of them and neither can be trusted — also `undecidable`,
// for a different reason, and deliberately not a partial answer.

import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import {
  columnNameForMember,
  declaredAxes,
  isAxisArtifact,
  siblingsOnAxis,
  tableColumns,
} from './axisSource'

/** The `data.<slice>.source` value that selects this resolver. */
export const COMPATIBLE_COLUMNS_SOURCE = 'compatible_columns'

/**
 * Must EVERY selected dataset carry a column before it is offered for fusion?
 *
 * `true`, and it is a TEMPORARY tightening rather than a permanent rule — named so it is
 * relaxed deliberately instead of rediscovered.
 *
 * ── THE RULE IT SERVES ────────────────────────────────────────────────────────────────
 *
 * **The form must never be more permissive than the compute.** The producer requires every
 * source to carry the column; this resolver's pair rule was `>= 2`, so with three or more
 * datasets a column carried by two of them was offered, the form reported `ready`, and the
 * job died in the sandbox minutes later. With exactly two datasets the two thresholds
 * coincide, which is why the gap was invisible until a third dataset existed.
 *
 * ── WHEN TO FLIP IT ───────────────────────────────────────────────────────────────────
 *
 * When the producer supports PARTIAL carriage (a column present in some sources, absent-coded
 * in the rest — the union mechanism), this becomes `false` and the offer widens. Stage 1 has
 * pinned the matching refusal on their side with the same note, so the future red reads as
 * *expected* rather than as a regression: both sides relax in one change, or the form and the
 * compute disagree again in the other direction.
 */
export const REQUIRE_COLUMN_IN_EVERY_DATASET = true

/** Width, in bytes, of one level's short hash inside a `vocab_sketch`
 *  (`txr_zarr.VOCAB_SKETCH_HASH_BYTES`). The sketch is a concatenation with no delimiter, so
 *  this is the only thing that says where one level ends — a reader that guessed it would
 *  silently mis-slice every sketch and answer subset questions with noise. */
export const VOCAB_SKETCH_HASH_BYTES = 8

/**
 * The largest level count for which the writer publishes a comparable vocabulary.
 *
 * `MAX_VOCAB_SKETCH_BYTES` (64 KiB) over 8 bytes/level, base64'd, measures out here — the
 * writer states the number in prose and this is the reader's copy of it. Named because the
 * ONLY honest use of a level count in this module is comparing against THIS, and a bare
 * `levels > 0` was standing in for it (see `compareDeclarations`).
 */
export const VOCAB_SKETCH_LEVEL_BUDGET = 6144

/**
 * The SEMANTIC kind of a column, normalised out of the STORAGE kind the writer stamps.
 *
 * These are two different vocabularies and conflating them was a live defect. The storage
 * vocabulary is `categorical | string | numeric` (`txr_zarr.Table`), and
 * `txr_columns.write_metadata_column` routes every object-dtype series — the single most
 * common label encoding, an ordinary imported label column — through `t.string(...)` while
 * stamping `meta.kind = "categorical"`. So the storage kind and the display kind DISAGREE BY
 * CONSTRUCTION for the commonest case.
 *
 * Comparing raw storage kinds therefore produced two wrong answers, both reachable: two string
 * label columns were called plainly compatible with "both carry measurements" and NO unverified
 * mark, and a label that is a pandas Categorical in one dataset and plain strings in the other —
 * the ordinary heterogeneous-import case this form exists for — was called `incompatible` with
 * an assertion that is the inverse of the truth, and dropped from the offer entirely.
 *
 * `undefined` for a kind this build does not know, which is `undecidable`, never a verdict.
 */
type SemanticKind = 'label' | 'measure'

function semanticKind(storageKind: string | undefined): SemanticKind | undefined {
  if (storageKind === 'categorical' || storageKind === 'string') return 'label'
  if (storageKind === 'numeric' || storageKind === 'continuous') return 'measure'
  return undefined
}

/**
 * How confidently the catalog can answer "could these columns mean the same thing?".
 *
 * A CLOSED vocabulary of three, and the third is not a degraded form of the first two:
 * - `compatible`   — the declarations agree (same vocabulary, or one contains the other, or
 *                    both are continuous). The pair is offered plainly.
 * - `undecidable`  — the declarations do not carry enough to decide. OFFERED and MARKED.
 * - `incompatible` — the declarations positively DISAGREE about kind (categorical against
 *                    continuous). Offered as refused, with the reason, rather than hidden:
 *                    a column the user came to align that is simply missing from the list is
 *                    a surface that lost their question.
 */
export type Compatibility = 'compatible' | 'undecidable' | 'incompatible'

/** How two vocabularies relate, when that could be decided at all. */
export type VocabRelation = 'identical' | 'contains' | 'disjoint-or-partial' | 'unknown'

/** One offered column, as the form renders it. Every field is a producer declaration or a
 *  comparison OF producer declarations — nothing here was read out of a column body. */
export interface CompatibleColumn {
  /** The column's declared name, shared across the datasets that carry it. */
  name: string
  /** The declared semantic kind, when every carrier agrees; `mixed` when they do not. */
  kind: string
  compatibility: Compatibility
  /** The largest declared level count across the carriers, `null` for a continuous column or
   *  when no carrier declared one. */
  levels: number | null
  /** The row's own sentence — why it is offered the way it is. Written here because the
   *  reason is a fact about the DECLARATIONS, which the view cannot see. */
  note: string
  /** Is this column OFFERABLE for fusion, as opposed to merely displayable?
   *
   *  Separate from `compatibility` because they answer different questions. `compatibility` is
   *  "could these two mean the same thing"; this is "will the producer accept it". A column can
   *  be perfectly compatible and still unfusable — a numeric pair is `compatible` ("both carry
   *  measurements"), and the producer refuses anything that is not categorical. Offering it
   *  produced a form that reported ready and a job that died in the sandbox minutes later. */
  offerable: boolean
}

export interface CompatibleColumnsArgs {
  /** `$`-ref to the datasets being integrated — a LIST of artifact ids. */
  of?: string
  /** Which axis's columns to compare. */
  axis?: string
}

/** What the slice lands. `anchored` and `count` travel in the PAYLOAD rather than as a slice
 *  status, for the reason `row_space_columns` states: the several emptinesses a section must
 *  tell apart (nothing chosen / chosen-and-sharing-nothing) both have to reach the view, and a
 *  status carries only one of them. */
export interface CompatibleColumns {
  anchored: boolean
  /** How many datasets were named. Below two there is no pair to compare and `columns` is
   *  empty — an alignment over one dataset is not an alignment. */
  datasets: number
  count: number
  columns: CompatibleColumn[]
  /**
   * The OFFERABLE columns as `{value,label}` — what a closed-set control binds.
   *
   * Built here rather than in the view because the LABEL is where a choice says what it means
   * at the point of choosing, and what it means is a fact about the DECLARATIONS the view
   * cannot see. It carries the `undecidable` rows: that arm is a primary path (it is the whole
   * high-cardinality tail), so hiding it would remove most of what a user came to align. The
   * mark travels IN the label, so an unverified choice cannot be made without reading that it
   * is unverified.
   *
   * `incompatible` rows are NOT offered — they are shown in the table with their reason. A
   * verdict a user can read and a choice a user can make are different affordances, and
   * offering a pair the declarations positively disagree about would be offering a fusion the
   * catalog already knows is wrong.
   */
  options: Array<{ value: string; label: string }>
}

const NOTHING: CompatibleColumns = { anchored: false, datasets: 0, count: 0, columns: [], options: [] }

/** The declared ITEM-51 pair of ONE column artifact, plus the kind it declares.
 *
 *  `undefined` for a member that declares no vocabulary — which is the ordinary state of a
 *  continuous column and of every categorical above the sketch budget. */
interface Declaration {
  kind: string | undefined
  levels: number | null
  digest: string | undefined
  sketch: string | undefined
  /**
   * The producer's `ordered` flag — CARRIED AND DELIBERATELY NEVER READ (ITEM-37 / INV-15).
   *
   * An ordered categorical is offered and fused exactly like any other, by unioning the level
   * sets: `ordered: true` earns its keep in ORDINAL analysis, and this pipeline does none of
   * that with categoricals.
   *
   * It is in scope precisely so that the rule is ENFORCEABLE. With the field absent, a test
   * asserting "the ordered verdict equals the unordered one" cannot fail — the classifier has
   * nothing to branch on, so the two coincide by construction and the guard proves nothing. A
   * negative control confirmed exactly that: an injected ordered-refusal branch read a field
   * that did not exist and the suite stayed green. Carrying it makes the mutation observable,
   * which is what turns the equality assertion into a real one.
   */
  ordered: boolean | undefined
}

function declarationOf(row: ArtifactRow): Declaration | undefined {
  const members = tableColumns(row.structure) as Array<Record<string, unknown>>
  // A metadata-column artifact declares exactly one member (`values`). Several members is a
  // TABLE, which is a different thing to compare and not what this offer is about — skipped
  // rather than guessed at, since picking one member of several is the kind of silent choice
  // INV-2 refuses.
  if (members.length !== 1) return undefined
  const m = members[0]
  return {
    kind: typeof m.kind === 'string' ? m.kind : undefined,
    levels: typeof m.n_levels === 'number' ? m.n_levels : null,
    digest: typeof m.vocab_digest === 'string' && m.vocab_digest !== '' ? m.vocab_digest : undefined,
    sketch: typeof m.vocab_sketch === 'string' && m.vocab_sketch !== '' ? m.vocab_sketch : undefined,
    ordered: typeof m.ordered === 'boolean' ? m.ordered : undefined,
  }
}

/**
 * Decode a `vocab_sketch` into its per-level short hashes.
 *
 * The sketch is base64 over CONCATENATED fixed-width hashes with no delimiter, so a length
 * that is not a whole number of hashes means the string is not a sketch this build can read —
 * `undefined`, which the caller turns into `undecidable`. Never a truncated best-effort: a
 * partially-decoded sketch is a set with levels missing, and a strict superset would then test
 * as a subset, which is a WRONG answer with no signal (the writer's own test says exactly this
 * about a short sketch, `test_vocab_digest.py:81`).
 */
export function decodeVocabSketch(sketch: string): Set<string> | undefined {
  let bytes: Uint8Array
  try {
    const binary = atob(sketch)
    bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  } catch {
    return undefined
  }
  if (bytes.length === 0 || bytes.length % VOCAB_SKETCH_HASH_BYTES !== 0) return undefined
  const out = new Set<string>()
  for (let i = 0; i < bytes.length; i += VOCAB_SKETCH_HASH_BYTES) {
    let hex = ''
    for (let j = 0; j < VOCAB_SKETCH_HASH_BYTES; j++) hex += bytes[i + j].toString(16).padStart(2, '0')
    out.add(hex)
  }
  return out
}

/** Is `a` a subset of `b`? Pure set containment over decoded sketches. */
function isSubset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) if (!b.has(x)) return false
  return true
}

/**
 * Compare the declarations of one column NAME across the datasets that carry it.
 *
 * The order of the arms is the whole logic and each is a different question:
 *   1. kinds DISAGREE            → `incompatible`. A positive disagreement, stated.
 *   2. not categorical           → `compatible`. Two continuous columns need no vocabulary to
 *                                  be alignable; there is nothing to compare and nothing is
 *                                  claimed beyond that.
 *   3. any declaration incomplete → `undecidable`. Includes the whole high-cardinality tail
 *                                  and the both-or-neither violation. Reached BEFORE any
 *                                  digest comparison, so a missing field can never be read as
 *                                  a mismatch.
 *   4. every digest equal         → `compatible` / `identical`.
 *   5. sketches nest              → `compatible` / `contains`. This is the arm `authority`
 *                                  mode's level-drop needs, and the reason a set hash alone
 *                                  was not enough.
 *   6. otherwise                  → `incompatible` / `disjoint-or-partial`. Decided, and
 *                                  different from `undecidable`: here the elements WERE
 *                                  compared and they do not nest.
 */
export function compareDeclarations(decls: readonly Declaration[]): {
  compatibility: Compatibility
  relation: VocabRelation
  note: string
} {
  const kinds = decls.map(d => semanticKind(d.kind))
  // AN UNDECLARED (or unrecognised) KIND IS UNDECIDABLE, never a verdict. It used to fall into
  // the disagreement arm against a declared neighbour — "declared as (undeclared) in one dataset
  // and categorical in another" — which asserts a positive disagreement about a column nobody
  // described, and removes it from the offer. The module's own rule is that "we could not check"
  // and "these differ" are different facts; this is that rule applied one arm earlier.
  if (kinds.some(k => k === undefined)) {
    return {
      compatibility: 'undecidable',
      relation: 'unknown',
      note: 'at least one dataset does not say what kind of column this is, so whether they match cannot be checked here',
    }
  }
  const distinct = new Set(kinds)
  if (distinct.size > 1) {
    return {
      compatibility: 'incompatible',
      relation: 'unknown',
      note: 'one dataset measures this and the other labels with it — a measurement and a label are not the same column',
    }
  }
  if (distinct.has('measure')) {
    return {
      compatibility: 'compatible',
      relation: 'unknown',
      note: 'both carry measurements — there is no vocabulary to reconcile',
    }
  }

  const incomplete = decls.some(d => d.digest === undefined || d.sketch === undefined)
  if (incomplete) {
    // ABOVE THE BUDGET, or not published at all — two different causes with two different
    // sentences. The predicate was `levels > 0`, which is true of essentially every label
    // column, so a 3-level column carrying a both-or-neither violation was told it had "too
    // many categories". That is the same "renders 'could not check' as a specific wrong cause"
    // failure this module forbids one screen up.
    const overBudget = decls.some(d => (d.levels ?? 0) > VOCAB_SKETCH_LEVEL_BUDGET)
    return {
      compatibility: 'undecidable',
      relation: 'unknown',
      note: overBudget
        ? 'too many categories for the datasets to publish a comparable vocabulary, so whether they match cannot be checked here'
        : 'no comparable vocabulary was published for this column, so whether they match cannot be checked here',
    }
  }

  const digests = new Set(decls.map(d => d.digest))
  if (digests.size === 1) {
    return {
      compatibility: 'compatible',
      relation: 'identical',
      note: 'the same set of categories in every dataset',
    }
  }

  const sketches = decls.map(d => decodeVocabSketch(d.sketch as string))
  if (sketches.some(s => s === undefined)) {
    return {
      compatibility: 'undecidable',
      relation: 'unknown',
      note: 'the published vocabulary could not be read, so whether they match cannot be checked here',
    }
  }
  const sets = sketches as Set<string>[]
  // Sorted by size so containment only has to be checked outward — the widest set is the only
  // possible container, and if the smallest does not fit in it, nothing nests.
  const bySize = [...sets].sort((a, b) => a.size - b.size)
  const widest = bySize[bySize.length - 1]
  if (bySize.every(s => isSubset(s, widest))) {
    return {
      compatibility: 'compatible',
      relation: 'contains',
      note: 'one dataset uses a subset of the other’s categories — the wider set covers them all',
    }
  }
  return {
    compatibility: 'incompatible',
    relation: 'disjoint-or-partial',
    note: 'each dataset uses categories the other does not, so neither set covers the pair',
  }
}

/**
 * Resolve the offer.
 *
 * PURE over the catalog rows the caller already fetched, so the whole classification is
 * unit-testable with no port at all — and the INV-11 guarantee is structural rather than
 * promised, since there is no read function in scope to call.
 */
export function resolveCompatibleColumns(
  artifacts: readonly ArtifactRow[],
  args: CompatibleColumnsArgs,
  datasetIds: readonly string[],
): CompatibleColumns {
  const axis = typeof args.axis === 'string' && args.axis !== '' ? args.axis : undefined
  const ids = [...new Set(datasetIds.filter(id => typeof id === 'string' && id !== ''))]
  if (!axis || ids.length === 0) return NOTHING
  // BELOW TWO there is nothing to compare, and answering with one dataset's columns would be
  // a different question wearing this one's name — the same trap `anchorId` refuses when a
  // list names several anchors. `anchored: true` so the view can tell "not enough datasets
  // yet" from "nothing chosen at all"; both are empty and they need different sentences.
  if (ids.length < 2) return { anchored: true, datasets: ids.length, count: 0, columns: [], options: [] }

  // name → per-dataset declaration. A dataset carrying the name TWICE (a re-run landing a
  // second column of one name is a real, measured event) contributes its first declaration
  // only: this offer is about whether the NAME means one thing across datasets, and a
  // contested name inside ONE dataset is a different defect with its own remedy. It is
  // recorded on the row rather than silently merged.
  const byName = new Map<string, Map<string, Declaration>>()
  const contested = new Set<string>()
  for (const datasetId of ids) {
    for (const row of siblingsOnAxis(artifacts, datasetId, axis)) {
      // An axis is not a column ON itself — offering the key artifact offers the row
      // identifiers as something to align, which is one distinct value per row.
      if (isAxisArtifact(row.structure)) continue
      if (!declaredAxes(row.structure).includes(axis)) continue
      const members = tableColumns(row.structure)
      const name = columnNameForMember(row, members[0] ?? {}, members.length)
      if (!name) continue
      const decl = declarationOf(row)
      if (!decl) continue
      let per = byName.get(name)
      if (!per) {
        per = new Map()
        byName.set(name, per)
      }
      if (per.has(datasetId)) contested.add(name)
      else per.set(datasetId, decl)
    }
  }

  const columns: CompatibleColumn[] = []
  for (const [name, per] of byName) {
    // A column only ONE dataset carries is not a pair. It is dropped rather than offered as
    // refused, because "the other dataset does not have it" is not a compatibility verdict —
    // there is no second thing to be compatible with.
    if (per.size < 2) continue
    const decls = [...per.values()]
    const verdict = compareDeclarations(decls)
    const kinds = new Set(decls.map(d => d.kind ?? '(undeclared)'))
    const levels = decls.reduce<number | null>(
      (max, d) => (d.levels === null ? max : Math.max(max ?? 0, d.levels)),
      null,
    )
    // ── OFFERABLE IS NARROWER THAN COMPATIBLE, IN TWO WAYS THE PRODUCER ENFORCES ──────
    //
    // 1. The producer fuses CATEGORICALS only. A numeric pair is `compatible` here ("both
    //    carry measurements") and is hard-refused there, so offering it is a form that reports
    //    ready and a job that fails after the user commits.
    // 2. The producer requires EVERY chosen dataset to carry the column; this resolver's pair
    //    rule is only `>= 2`. With exactly two datasets the two coincide, which is why the gap
    //    was invisible — with three, a column carried by two of them was offered and killed the
    //    run.
    //
    // Non-offerable rows stay in the TABLE with their reason. A verdict a user can read and a
    // choice a user can make are different affordances.
    const carriedByAll = REQUIRE_COLUMN_IN_EVERY_DATASET ? per.size === ids.length : per.size >= 2
    const isLabel = decls.every(d => semanticKind(d.kind) === 'label')
    const offerable = verdict.compatibility !== 'incompatible' && isLabel && carriedByAll
    const unofferableNote = !isLabel
      ? '. Not offered: only label columns can be unified — a measurement column has no vocabulary to fuse'
      : !carriedByAll
        ? `. Not offered: carried by ${per.size} of the ${ids.length} chosen datasets, and every one must carry it`
        : ''
    columns.push({
      name,
      offerable,
      kind: kinds.size === 1 ? [...kinds][0] : 'mixed',
      compatibility: verdict.compatibility,
      levels,
      note: (contested.has(name)
        ? `${verdict.note}. One dataset declares this name more than once, so which column it refers to is ambiguous`
        : verdict.note) + unofferableNote,
    })
  }

  // Stable and DECLARED: offerable first (so the rows a user can act on are not buried under
  // refusals), then by name. Never by "importance" — there is no such declaration to read, and
  // inventing a ranking is what the sibling resolver's comment warns against.
  const rank: Record<Compatibility, number> = { compatible: 0, undecidable: 1, incompatible: 2 }
  columns.sort((a, b) => rank[a.compatibility] - rank[b.compatibility] || a.name.localeCompare(b.name))

  const options = columns
    .filter(c => c.offerable)
    .map(c => ({
      value: c.name,
      label: c.compatibility === 'undecidable' ? `${c.name} — unverified: ${c.note}` : c.name,
    }))

  return { anchored: true, datasets: ids.length, count: columns.length, columns, options }
}
