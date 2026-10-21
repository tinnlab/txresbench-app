// SAME-NAME FUSION, AND THE CHECK IT RESTS ON (dimension-membership ITEM-32, Q1/Q11 ruled).
//
// Two datasets each carry a column called the same thing. The owner ruled: FUSE them into one
// offer — but only where the two vocabularies reconcile, and never silently otherwise.
//
// ── FUSION IS A PRESENTATION DECISION RESTING ON A CHECK, NOT AN IDENTITY ────────────────────
//
// The artifacts natural key deliberately EXCLUDES the name
// (`202608030004_workstore_baseline.sql:76`) precisely so two same-named columns can legitimately
// coexist and mean different things, and `candidateLabel` records that a name is "display only
// and is never keyed on". Nothing below joins on a name for any purpose except deciding what to
// SHOW; the identity of every offer stays its artifact id.
//
// ── THE CHECK IS THREE-VALUED, AND IT IS DECIDED FROM THE CATALOG ALONE (INV-8) ──────────────
//
//   reconciled  — the vocabularies are provably equal, or one is provably a subset of the other.
//   mismatched  — they provably conflict.
//   undecidable — the declarations cannot answer. NOT a soft yes.
//
// MISMATCHED AND UNDECIDABLE BOTH OFFER SEPARATELY, and the reasoning is the plan's:
//
//   1. A fused row with a warning cannot be acted on — the user cannot un-fuse it, while two
//      rows can always be picked individually. The disagreement is expressed as STRUCTURE (two
//      offers, two legends) rather than as prose the reader must translate back into an action.
//   2. This pane has already paid for a mark that fires on something the reader cannot fix: the
//      alignment mark was retired from four surfaces at once for exactly that. A warning bolted
//      to a merged artifact is the same failure one layer down.
//   3. Undecidable must fall to the SAFE side. Fusing on "we could not tell" is a confident
//      merge on an unanswered question — the same error class as reading A3 (unknown) as A1
//      (matched), which this pane has already shipped once.
//
// ── WHAT IT READS, AND WHY THE DIGEST HAD TO EXIST (ITEM-34) ─────────────────────────────────
//
// The pre-ITEM-34 answer was `meta.categories`, the producer's preview, capped at 50 entries AND
// 1 KiB. `colsummary.py` defines `high_cardinality` as `len(categories) < n_categories` — "the
// preview is not the whole set" — so a comparison over a truncated preview cannot answer the
// question at all, and on real data the honest answer would have been `undecidable` for most
// columns. `vocab_digest` (an order-independent SET hash, 32 bytes at any cardinality) and
// `vocab_sketch` (the same sorted per-level short hashes, so SUBSET is decidable) are what let
// the ruling actually fire. The preview remains as the fallback for artifacts written before the
// digest existed — INV-9's "a default, not a rewrite".
//
// ── THE CONSISTENCY RULE, READ SIDE ─────────────────────────────────────────────────────────
//
// `vocab_declaration` emits BOTH fields or NEITHER, and drops the digest when the sketch does not
// fit. So a declaration carrying exactly ONE of them is a state the writer cannot produce, which
// means something rewrote one of them, which means neither can be trusted: exactly one present ⇒
// `undecidable`. That refusal is what makes the write-side invariant load-bearing rather than one
// refactor away from being false.

import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'

/** The verdict. Only `reconciled` fuses. */
export type VocabVerdict = 'reconciled' | 'mismatched' | 'undecidable'

/** How the verdict was reached — carried so a surface can say WHICH evidence answered, and so a
 *  test can tell "reconciled because the digests matched" from "reconciled because two capped
 *  previews happened to agree". They are not the same confidence. */
export type VocabEvidence = 'digest' | 'sketch' | 'preview' | 'continuous' | 'none'

export interface VocabCheck {
  readonly verdict: VocabVerdict
  readonly evidence: VocabEvidence
  /** the one-line reason, for a surface that wants to state it. Never empty. */
  readonly because: string
}

/** What one candidate DECLARES about its own vocabulary — read off the producer's declaration,
 *  never off a body (INV-8). */
export interface VocabDeclaration {
  /** the producer's semantic summary kind (`categorical` / `continuous` / anything else). */
  readonly kind?: string
  /** ITEM-34's order-independent SET hash. */
  readonly digest?: string
  /** ITEM-34's sorted per-level short hashes, base64. */
  readonly sketch?: string
  /** the producer's `ordered` flag — a property of the SEQUENCE, which a set hash cannot see. */
  readonly ordered?: boolean
  /** the TRUE distinct level count. */
  readonly nLevels?: number
  /** the capped preview, and whether it is COMPLETE (`preview.length === nLevels`). */
  readonly preview?: readonly string[]
  /** a continuous column's declared range (Q11 — the only tell of divergent meaning available
   *  without a body read, so it is surfaced rather than checked). */
  readonly min?: number
  readonly max?: number
}

/** The sole declared member of a table structure, under either spelling the producer writes. */
function soleMember(structure: unknown): Record<string, unknown> | undefined {
  if (structure == null || typeof structure !== 'object') return undefined
  const t = structure as { columns?: unknown; arrays?: unknown }
  const members = Array.isArray(t.columns) ? t.columns : Array.isArray(t.arrays) ? t.arrays : undefined
  if (!members || members.length !== 1) return undefined
  const sole = members.reduce(first => first)
  return sole != null && typeof sole === 'object' ? (sole as Record<string, unknown>) : undefined
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Read a candidate's vocabulary declaration.
 *
 * The digest fields come off the STRUCTURE member, because that is where the producer writes them
 * (`cyto_zarr.Table.categorical` puts them on the member entry beside `levels_digest`/`n_levels`/
 * `ordered`). The preview and the semantic `kind` come off `meta`, because that is where
 * `colsummary.summarize_column`'s dict is stamped. Neither is guessed from the other.
 */
export function vocabDeclarationOf(row: ArtifactRow): VocabDeclaration {
  const member = soleMember(row.structure) ?? {}
  const meta = (row.meta ?? {}) as Record<string, unknown>
  const preview = Array.isArray(meta.categories)
    ? meta.categories.filter((c): c is string => typeof c === 'string')
    : undefined
  return {
    ...(str(meta.kind) ? { kind: str(meta.kind) } : {}),
    ...(str(member.vocab_digest) ? { digest: str(member.vocab_digest) } : {}),
    ...(str(member.vocab_sketch) ? { sketch: str(member.vocab_sketch) } : {}),
    ...(typeof member.ordered === 'boolean' ? { ordered: member.ordered } : {}),
    ...(num(member.n_levels) ?? num(meta.n_categories)) !== undefined
      ? { nLevels: num(member.n_levels) ?? num(meta.n_categories) }
      : {},
    ...(preview ? { preview } : {}),
    ...(num(meta.min) !== undefined ? { min: num(meta.min) } : {}),
    ...(num(meta.max) !== undefined ? { max: num(meta.max) } : {}),
  }
}

/** The sketch's level hashes, as a set of hex strings. `undefined` when it cannot be decoded —
 *  which is refused rather than treated as an empty set, because an empty set is a SUBSET of
 *  everything and would fuse every pair it touched. */
function sketchLevels(sketch: string): Set<string> | undefined {
  let raw: string
  try {
    raw = atob(sketch)
  } catch {
    return undefined
  }
  // 8 bytes per level (`VOCAB_SKETCH_HASH_BYTES`). A length that is not a multiple is a sketch
  // this reader does not understand, and guessing at the remainder would invent a level.
  if (raw.length === 0 || raw.length % 8 !== 0) return undefined
  const out = new Set<string>()
  for (let at = 0; at < raw.length; at += 8) {
    let hex = ''
    for (let i = 0; i < 8; i++) hex += raw.charCodeAt(at + i).toString(16).padStart(2, '0')
    out.add(hex)
  }
  return out
}

const isSubset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const x of a) if (!b.has(x)) return false
  return true
}

/**
 * Do two same-named columns' vocabularies reconcile?
 *
 * The order of the arms is the order of the evidence's strength, and each one is a REFUSAL
 * before it is a decision.
 */
export function reconcileVocabularies(a: VocabDeclaration, b: VocabDeclaration): VocabCheck {
  // ── CONTINUOUS (Q11) ────────────────────────────────────────────────────────────────────
  //
  // A continuous column has no vocabulary, so there is nothing for the check above to test. The
  // ruling: fuse when BOTH declare `kind: continuous`, and put each dataset's declared RANGE on
  // the ITEM-10 line — a visibly divergent range is the only tell of divergent meaning available
  // without a body read, so it is surfaced and the reader judges.
  if (a.kind === 'continuous' || b.kind === 'continuous') {
    if (a.kind === 'continuous' && b.kind === 'continuous') {
      return { verdict: 'reconciled', evidence: 'continuous', because: 'both declare a continuous shape' }
    }
    return {
      verdict: 'mismatched',
      evidence: 'none',
      because: 'one side declares a continuous shape and the other does not',
    }
  }
  // A column declaring neither recognised kind does not fuse. There is no check to apply and no
  // basis for one, and fusing on the name alone is fusing on the thing the schema says is display.
  if (a.kind !== 'categorical' || b.kind !== 'categorical') {
    return { verdict: 'undecidable', evidence: 'none', because: 'neither side declares a shape this check can read' }
  }
  // ── ORDERED (Q14) — always undecidable, even when the digests agree ──────────────────────
  //
  // The digest is a SET hash and cannot see order. Two ordered categoricals agreeing as sets and
  // differing in sequence are indistinguishable under it, and fusing them produces a legend whose
  // ORDER is one dataset's and whose VALUES are both — which passes every other check here.
  if (a.ordered === true || b.ordered === true) {
    return {
      verdict: 'undecidable',
      evidence: 'none',
      because: 'a side declares an ORDERED vocabulary, and a set digest cannot compare sequences',
    }
  }
  // ── THE CONSISTENCY RULE, READ SIDE ─────────────────────────────────────────────────────
  const half = (d: VocabDeclaration): boolean => (d.digest === undefined) !== (d.sketch === undefined)
  if (half(a) || half(b)) {
    return {
      verdict: 'undecidable',
      evidence: 'none',
      because: 'a side declares a vocabulary digest without its sketch (or the reverse), which the writer cannot produce',
    }
  }
  if (a.digest !== undefined && b.digest !== undefined) {
    if (a.digest === b.digest) {
      return { verdict: 'reconciled', evidence: 'digest', because: 'the vocabularies are identical' }
    }
    const la = sketchLevels(a.sketch as string)
    const lb = sketchLevels(b.sketch as string)
    if (!la || !lb) {
      return { verdict: 'undecidable', evidence: 'none', because: 'a vocabulary sketch could not be read' }
    }
    if (isSubset(la, lb) || isSubset(lb, la)) {
      return { verdict: 'reconciled', evidence: 'sketch', because: 'one vocabulary is contained in the other' }
    }
    return { verdict: 'mismatched', evidence: 'sketch', because: 'the vocabularies conflict' }
  }
  if (a.digest !== undefined || b.digest !== undefined) {
    // One side predates ITEM-34. Its levels are simply not comparable at this strength, and the
    // survivor is NOT usable as a partial answer.
    return {
      verdict: 'undecidable',
      evidence: 'none',
      because: 'only one side declares a vocabulary digest',
    }
  }
  // ── THE PRE-ITEM-34 FALLBACK: the capped preview ────────────────────────────────────────
  //
  // Usable ONLY when both previews are COMPLETE. `high_cardinality` is defined as
  // `len(categories) < n_categories`, so a truncated preview cannot answer either way — and a
  // comparison over two truncations that happened to agree is the confident merge on an
  // unanswered question that clause 3 above forbids.
  const complete = (d: VocabDeclaration): readonly string[] | undefined =>
    d.preview !== undefined && d.nLevels !== undefined && d.preview.length === d.nLevels
      ? d.preview
      : undefined
  const pa = complete(a)
  const pb = complete(b)
  if (!pa || !pb) {
    return {
      verdict: 'undecidable',
      evidence: 'none',
      because: 'the declared level previews are capped, so they cannot answer whether the vocabularies agree',
    }
  }
  const sa = new Set(pa)
  const sb = new Set(pb)
  if (isSubset(sa, sb) || isSubset(sb, sa)) {
    return { verdict: 'reconciled', evidence: 'preview', because: 'the declared levels agree' }
  }
  return { verdict: 'mismatched', evidence: 'preview', because: 'the declared levels conflict' }
}
