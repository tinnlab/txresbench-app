// The VALUE-PREVIEW port core resolves out of the `data` capability, the render-scope
// channel it publishes it on, and the two DECLARATION readers that answer without any
// port at all.
//
// ## What this is for
//
// A picker offers artifacts by NAME, and on a real dataset the names do not say which is
// which. Two candidates on one axis — an identifier column and a label column — read as
// two strings a user cannot tell apart, and picking wrong is SILENT: the run matches its
// patterns against identifiers, finds nothing, and reports zero rather than failing. That
// is the defect the `artifact_ref` control exists to remove, reached through a control
// that looks correct. Three of the column's own values make the distinction obvious with
// no schema knowledge, and the system already holds them.
//
// ## THREE sources, in cost order — and the cheapest is free
//
// The read is dispatched on the producer's DECLARED ENCODING
// (`@/core/workstore`'s `previewableColumn`), never on a semantic term: `kind` on a table
// member names an ENCODING (`string` = inline utf8, `categorical` = dictionary-encoded),
// and both hold text.
//
//   1. `meta.categories` on the CATALOG ROW — ZERO requests. This is
//      `_helpers/colsummary.py`'s compact per-column summary, which exists, in its own
//      words, "so viz reads a column's legend ... WITHOUT downloading the column values".
//      It is bounded at the producer by BOTH a count (50) and a byte budget (1 KiB), and
//      it rides the row every picker already holds. See {@link declaredValuePreview}.
//   2. `attributes.cyto.levels` on a dictionary-encoded member — ONE metadata request, no
//      data array. Reached through the port.
//   3. the first chunk of an inline-utf8 member — one bounded byte-range read. Also the
//      port.
//
// Source 1 is NOT in the design note this implements, and it is not an optimization: on
// the box this was built against, 0 of 138 artifact rows still have their bytes in the
// object store, so sources 2 and 3 both 404 and the ONLY reachable preview is the one that
// rides the row. A design that reads only the data plane degrades (correctly, per DEC-4)
// to showing nothing at all there.
//
// ## Why a PORT rather than a direct read
//
// Core routes on a capability id and nothing else (INV-6), so the preview arrives the same
// way the catalog does: `DeclarativeRegion` resolves the `data` capability once and hands
// the narrow read down the render scope. A host that publishes no data plane — a bare unit
// mount, a gallery fake — simply has no preview, and the control renders exactly as it did
// before. That is DEC-4's degradation made structural rather than remembered.

import type { Scope } from '@/modules/workbench/core/runtime/expr'

/**
 * A short EXCERPT of one column's values, and WHICH declaration answered.
 *
 * `source` is not decoration. The three are different KINDS of excerpt, and a surface that
 * rendered any of them as "the first N values" would assert an ordering two of them do not
 * have:
 *
 *   `declared` — the producer's own capped preview of the column's DISTINCT values
 *                (`meta.categories`). A vocabulary excerpt.
 *   `levels`   — the declared level set of a dictionary-encoded column, in dictionary
 *                order. Also a vocabulary excerpt; it includes levels the data never uses.
 *   `rows`     — literally the first N stored values, in row order.
 *
 * The rendering therefore says `e.g.` for all three and never implies position (DEC-2).
 */
export interface ValuePreview {
  values: string[]
  source: 'declared' | 'levels' | 'rows'
}

/** What the port is asked for. `structure` rides along because the CALLER already holds it
 *  (it is on the catalog row — see `ArtifactRow.structure`), so a preview costs no
 *  control-plane re-fetch just to learn how to decode. */
export interface ValuePreviewRequest {
  artifactId: string
  /** the producer's decode contract, verbatim off the row. */
  structure: unknown
  /** which member to excerpt; omitted ⇒ the artifact's sole text-valued member. */
  member?: string
  /** at most this many values. */
  limit: number
}

/**
 * The value-excerpt READ core resolves out of the broker — the narrow port, not the
 * capability.
 *
 * Declared separately from {@link ArtifactCatalogSource} rather than folded into it,
 * because the two are separately ABSENT: a host can serve a catalog and no data plane, and
 * a preview that a host cannot answer must leave the control exactly as it was. Merging
 * them would make the whole catalog read fail to type-check on such a host, which is the
 * opposite of the degradation DEC-4 asks for.
 *
 * `undefined` means the artifact declares nothing previewable — a determinate answer read
 * off the producer's own words. A read that FAILS rejects, and the caller stays silent
 * (DEC-4); the two are kept distinguishable so a future surface may choose to say so.
 */
export interface ArtifactValuePreviewSource {
  previewValues(request: ValuePreviewRequest): Promise<ValuePreview | undefined>
}

/** The scope channel `DeclarativeRegion` publishes the resolved preview port on — an
 *  INTERNAL key like `catalog`/`caps`, deliberately not a `$`-ref namespace (a view may not
 *  ask for a column's values; a control decides to preview what the user chose). */
export const VALUE_PREVIEW_SCOPE_KEY = 'valuePreview'

/** Read the channel off a render scope, degrading to NO port rather than throwing when the
 *  host published none. The shape check is structural on purpose: a scope is
 *  `unknown`-valued by construction, and a control that trusted the key blindly would
 *  `TypeError` at the moment a user made a selection — turning an absent aid into a broken
 *  form, which is the one thing DEC-4 forbids. */
export function readValuePreviewScope(scope: Scope): ArtifactValuePreviewSource | undefined {
  const p = scope[VALUE_PREVIEW_SCOPE_KEY]
  if (p && typeof p === 'object' && typeof (p as ArtifactValuePreviewSource).previewValues === 'function') {
    return p as ArtifactValuePreviewSource
  }
  return undefined
}

// ── the declarations that answer with NO request ────────────────────────────────────
//
// Both read the CATALOG ROW the picker already holds. They are pure and synchronous, which
// is the point: a value already in hand must not become an async round trip that paints
// nothing and then flips.

/** The two row fields these read, named structurally so this module states no dependency
 *  on the wider row type (it is handed one by the control that holds it). */
interface PreviewableRow {
  meta?: unknown
  structure?: unknown
}

function metaOf(row: PreviewableRow | undefined): Record<string, unknown> | undefined {
  const meta = row?.meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  return meta as Record<string, unknown>
}

/**
 * The producer's OWN capped preview of a column's distinct values (`meta.categories`), or
 * `undefined` when it declared none.
 *
 * `textEncoded` is the caller's ENCODING verdict (`previewableColumn(row.structure) !==
 * undefined`), passed in rather than recomputed here so this module carries no dependency
 * on the stored-structure vocabulary — and so ONE rule decides what may be previewed
 * across all three sources.
 *
 * That gate is load-bearing and it is where two vocabularies collide. `meta.kind` is a
 * SEMANTIC classification (`colsummary`'s `categorical`/`continuous`), and it calls a bool
 * column categorical and hands it `categories: [false]`; `structure.columns[].kind` is the
 * stored ENCODING, and it calls the same column `numeric`. The ENCODING governs, for two
 * reasons: DEC-3 says a numeric column gets no value preview, and a rule that differed
 * between sources would make the preview appear or vanish depending on which one happened
 * to answer — a surface that is confidently inconsistent about the same column.
 *
 * Values are stringified (a bool/int level set arrives as bools/numbers) and empties are
 * dropped to `undefined`: an empty preview is not a preview, and rendering `e.g.` with
 * nothing after it is worse than rendering nothing.
 */
export function declaredValuePreview(
  row: PreviewableRow | undefined,
  textEncoded: boolean,
  limit: number,
): ValuePreview | undefined {
  if (!textEncoded || limit <= 0) return undefined
  const categories = metaOf(row)?.categories
  if (!Array.isArray(categories) || categories.length === 0) return undefined
  const values = categories.slice(0, limit).map(v => String(v))
  return { values, source: 'declared' }
}

/**
 * How many DISTINCT values the producer declared for this column, or `undefined` when it
 * declared none.
 *
 * DEC-5: shown because it is FREE — both spellings ride the row already — and never as a
 * substitute for the values. It separates an annotation-like column (a handful of levels)
 * from an identifier-like one (tens of thousands), and it CANNOT separate two
 * identifier-like columns from each other, which is the confusion that caused the defect.
 * So a surface shows it beside an excerpt and never instead of one.
 *
 * `meta.n_categories` first: it is the TRUE distinct count `colsummary` keeps precisely
 * because its own preview is capped, and it is present for inline-utf8 columns too, where
 * there is no level set to count. `n_levels` on the member is the dictionary-encoded
 * column's own declaration and the fallback.
 */
export function declaredDistinctCount(
  row: PreviewableRow | undefined,
  member: { n_levels?: number } | undefined,
): number | undefined {
  const declared = metaOf(row)?.n_categories
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) return Math.trunc(declared)
  const levels = member?.n_levels
  return typeof levels === 'number' && Number.isFinite(levels) && levels > 0 ? Math.trunc(levels) : undefined
}
