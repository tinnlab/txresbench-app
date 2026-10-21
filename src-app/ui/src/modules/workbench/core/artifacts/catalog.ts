// The artifact-CATALOG shapes CORE itself reads, plus the render-scope CHANNEL core
// publishes them on (ITEM-7/ITEM-8).
//
// ## Why these live in `core/` and not with the capability that serves them
//
// `extensions/data/contract.ts` is the published surface of the `data` capability, and the
// VS Code `extension.exports` rule that governs it — the TYPES live with the extension
// that publishes them — is right for everything ABOUT that capability: its methods, its
// query shapes, its host binding. It is wrong for the artifact ROW, because core's own
// engine names it: `core/runtime/axisSource.ts` filters rows into an `artifact_ref`
// widget's candidate list, `core/render/` renders them, and `core/shell/` reads them.
//
// A type core's engine cannot compile without is not an extension's to own. Keeping it
// behind the extensions barrel pointed the layer arrow backwards (`core → extensions`,
// the one edge INV-3 forbids outright) for four engine modules at once, and the fact that
// each import was type-only did not change the direction — it only made the wrong
// direction invisible at runtime.
//
// So core declares them and `extensions/data/contract.ts` RE-EXPORTS both, which keeps the
// capability's published surface complete (a consumer still reads one contract file) while
// the dependency runs the legal way round: the extension imports core.
//
// ## The narrow port
//
// `ArtifactCatalogSource` is the ONE method core calls on the capability it resolves by id.
// INV-6 says core routes on the id string and must not name a capability's whole surface;
// declaring the slice it actually uses honours that while still type-checking the call.
// `DataApi extends ArtifactCatalogSource` on the publishing side turns "these two agree"
// from a convention into a compile-time fact — if the publisher's catalog read ever
// changed shape, the extension stops compiling instead of core silently reading undefined.
//
// ## The channel, and why the RENDERER is not here
//
// `CATALOG_SCOPE_KEY` / `CatalogScope` / `readCatalogScope` are the render-scope channel:
// `core/render/DeclarativeRegion` publishes the rows on it once per catalog epoch and the
// `artifact_ref` control reads them back inside its OWN scope. Core owns the channel
// because core publishes it, and it is declared in this React-free module so the PUBLIC
// core barrel can carry it — that barrel is loaded by `node --test`, which strips types
// from `.ts` and cannot parse `.tsx` at all, so any JSX module reachable from
// `core/index.ts` takes the whole node suite down with `ERR_UNKNOWN_FILE_EXTENSION`.
//
// The control that CONSUMES the channel is presentation, so it lives with the other eleven
// widget renderers in `extensions/widgets/renderers.tsx` and reaches all of this through
// the barrel. That is the layering the ratchet asks for in both directions: the contract
// (row, channel, resolver) is core's, the pixels are the extension's.

import type { DatatypeLattice } from '@/modules/workbench/core/datatypes/lattice'
import type { Scope } from '@/modules/workbench/core/runtime/expr'

/** One catalog row (mirrors P1 `ListedArtifact` — `Artifact` + the derived source
 *  dataset). */
export interface ArtifactRow {
  id: string
  project_id: string
  datatype: string
  /** Producer-declared: HOW TO DECODE this artifact's bytes (`Artifact.structure`).
   *  Required — the column is `NOT NULL` with no default (ITEM-5), and every read path
   *  dispatches on it (ITEM-25). Carried through the capability so a consumer never has
   *  to re-fetch the row just to learn how to read it.
   *
   *  ITEM-7 removed `storage_layout` and `shape` from this row. Both restated, more
   *  weakly, what `structure` states exactly: `storage_layout` was one enum string where
   *  a multi-member artifact needs several, and `shape` was a free-form blob three
   *  producers filled with three incompatible shapes. `structure` + `declaredDims()`
   *  (`@/core/workstore`) replace them. */
  structure: unknown
  /** Producer-declared display metadata, carried VERBATIM (the same `meta` the wire row
   *  holds). Core reads exactly FOUR things out of it. The first three are DISPLAY facts,
   *  never joined on and never dispatched on; the fourth is neither, and is spelled out
   *  below as the exception it is:
   *
   *  · `meta.name` — the producer's display NAME for the artifact, to LABEL a picker
   *    option (`core/runtime/axisSource.ts::candidateLabel`). Without it a picker cannot
   *    name what it is offering: a single-column store's sole member is written under the
   *    constant path `values`, so labelling by member name gave every metadata column on
   *    an axis the identical label "values" — six real candidates rendered as six copies
   *    of one string, told apart only by an id hash. The name the producer chose was being
   *    dropped at the wire→row boundary.
   *  · `meta.categories` — the producer's own capped EXCERPT of the column's distinct
   *    values (`_helpers/colsummary.py`, bounded at 50 entries AND 1 KiB), which exists so
   *    a consumer can show what a column contains without downloading it. It is what lets
   *    a chosen column show its own values with no request at all
   *    (`core/artifacts/valuePreview.ts::declaredValuePreview`).
   *  · `meta.n_categories` — the TRUE distinct count that stays honest when the excerpt
   *    above is capped (same module, `declaredDistinctCount`).
   *
   *  ── THE FOURTH READ, AND WHY IT BREAKS THE SENTENCE ABOVE ─────────────────────────
   *
   *  · `meta.component_columns` — the producer's declaration that this artifact's
   *    components are ALSO emitted as that many 1-D sibling columns, named. It IS
   *    DISPATCHED ON (`core/runtime/axisSource.ts::declaredComponentCount` narrows a
   *    picker's candidates by it, so it decides what a user is offered) and it IS JOINED
   *    ON (`extensions/data/workbenchDataSource.ts::catalog()` matches each declared name
   *    against the `meta.name` of the artifacts sharing this row's `source_dataset_id`,
   *    and emits the resolved ids as `CatalogEntry.components`). Both are exactly what the
   *    three reads above are careful NOT to do, so this is stated as an exception rather
   *    than folded into the rule.
   *
   *    It has to live in `meta` because `structure` DOES NOT SURVIVE A NARROWING. The
   *    server re-mints `structure` for every gathered artifact
   *    (`src-app/server/src/modules/workstore/virtual_dataset.rs:1688-1705` →
   *    `gathered_structure`): one `values` column of `shape: [n_kept]`, `arrays: []`,
   *    always — while `meta` is copied VERBATIM (`:1714`). So on a narrowed row set `meta`
   *    is the ONLY channel a producer's shape declaration still exists in, and a fact
   *    declared in `structure` instead would be silently gone at precisely the moment it
   *    is needed. The join key is a NAME rather than an id for the reason DEC-8 records:
   *    this row carries no `output_id`, and a producer cannot know an artifact id (it is
   *    minted at ingest), so a name within one dataset is the only address available. That
   *    join FAILS CLOSED on any count but exactly one — see the resolver.
   *
   *  Note `meta.kind` is NOT read, deliberately: it is a SEMANTIC classification and it
   *  disagrees with the stored ENCODING in `structure` on real data (a bool column is
   *  `categorical` there and `numeric` here). Everything that dispatches reads the
   *  encoding. */
  meta?: unknown
  /**
   * The artifact's CONTENT IDENTITY, minted at ingest over the bytes (`Artifact.content_hash`).
   *
   * Carried because it is what an AXIS is identified by (INV-3): `AxisSummary.content_hash`
   * IS the content hash of the key artifact that is the axis, so resolving an anchored row
   * space to the artifact that defines it — and thence to the key sequence every aligned
   * artifact declares (ITEM-15/ITEM-17) — is a join on this field and on nothing else.
   * Joining on `AxisSummary.name` instead is what INV-1 forbids: the label is documented
   * "never a key" and two row spaces legitimately share one.
   *
   * Optional because it was absent from this row type until the join needed it, and a row
   * hand-built by a test legitimately has no identity of its own. A join keyed on it treats
   * absence as "no match", never as a wildcard.
   */
  content_hash?: string
  /**
   * Bytes in the object store (`Artifact.stored_bytes`) — EXACT for an artifact that owns a
   * single blob, and 0 for a gathered one, which owns none.
   *
   * Carried for ONE reader (#159): a pyramidal raster is opened over byte RANGES, and a range
   * reader must know where the object ends before it can address its last block — an unclamped
   * block-aligned read past the end is a 416, and a 416 is completely silent from a rendered
   * picture. Every other size question on this row is answered by `logical_bytes`, which is the
   * DISPLAY size; this is the storage one and must never be shown as "Size".
   *
   * Optional for the same reason `content_hash` above is: it was absent from this row type until
   * a reader needed it, and a hand-built test row legitimately has none. A consumer that reaches
   * a range reader without it refuses by name rather than reading from offset 0 of nothing.
   */
  stored_bytes?: number
  created_at: string
  /**
   * The dataset this artifact is STORED IN (`Artifact.dataset_id`) — its tenancy scope, not
   * its lineage. Null for a project-scoped artifact; exactly one of `project_id`/`dataset_id`
   * is set on a live artifact (ITEM-23).
   *
   * Distinct from {@link source_dataset_ids} below, and the two must not be confused: that
   * one is PROVENANCE-DERIVED (which datasets this artifact was computed FROM, a lineage
   * walk) and is absent from the project OVERVIEW row; this one is the artifact's own column
   * and rides every read of it. `sourceDataset.ts`'s header records that the two pickers key
   * on the lineage while the artifacts pane keys on this scope, and that the difference is
   * argued rather than accidental.
   *
   * ITEM-13 gives it a second reader: it is the scope a layout's declared component columns
   * are resolved in (`extensions/data/workbenchDataSource.ts::catalog()`). Materialising a
   * narrowed row set inserts every gathered artifact under the new dataset's id
   * (`src-app/server/src/modules/workstore/virtual_dataset.rs:1725`), so equality on this
   * field says "these came out of the same narrowing" — which a shared lineage does not.
   */
  dataset_id?: string | null
  /** ITEM-22 — EVERY dataset this artifact derives from (provenance-derived, not a
   *  denormalized column), in declared-input order. An artifact produced by INTEGRATING
   *  two datasets carries two entries; empty when the lineage resolves to no dataset.
   *  This is the authoritative field — the singular pair below only speaks when the set
   *  has exactly one member. Optional because the project OVERVIEW row cannot carry it. */
  source_dataset_ids?: readonly string[] | null
  /** ITEM-22 — display names for {@link source_dataset_ids}. A deleted dataset contributes
   *  no name, so this may be SHORTER than the id list: never pair them by index. */
  source_dataset_names?: readonly string[] | null
  /** ITEM-22 — the dataset this artifact derives from, **only when there is exactly one**.
   *  Null means "not one dataset": either none, or SEVERAL. It used to report the
   *  first-declared source of a multi-source artifact, which is a confident wrong answer
   *  decided by edge order — a consumer that must say something about a multi-source
   *  artifact reads {@link source_dataset_ids} and states its own disposition. */
  source_dataset_id?: string | null
  /** ITEM-22 — the single source dataset's display name, under the same exactly-one rule
   *  as {@link source_dataset_id}; null when unknown or when there is not exactly one. */
  source_dataset_name?: string | null
  /**
   * WHO PRODUCED THIS ARTIFACT — the ANALYSIS id the producing run recorded
   * (`ListedArtifact.generator_id`, provenance-derived server-side, like the two fields
   * above); null when nothing produced it (an import / upload) or when its run recorded
   * no provenance.
   *
   * It is the ONLY thing on a row that tells one producer from another. Two metadata
   * columns of the same name, on the same axis, written by two different analyses are
   * otherwise indistinguishable here: `datatype`, `structure` and `meta` all describe the
   * COLUMN (`{axis, dtype, kind, n, name, …}`), and every producer that writes a column
   * of that shape writes the same declaration. So a form asking "is this name taken by
   * SOMEONE ELSE?" — as opposed to "is this name taken?" — had no field to ask it of, and
   * had to refuse both cases alike.
   *
   * NOT a key, and dispatched on for nothing beyond that equality: it is compared against
   * the analysis ids a view's own `run_processor` names, and a null (unattributable) row
   * is never read as any particular producer.
   */
  generator_id?: string | null
}

/**
 * The catalog READ core resolves out of the broker — the narrow port, not the capability.
 *
 * Deliberately ONE method with a STRUCTURAL return: core needs the project's rows and
 * nothing else, so widening this to the publisher's full catalog type would re-create the
 * backwards edge this module exists to remove. A publisher whose `catalog()` returns more
 * (it does — axes ride along) satisfies it unchanged.
 */
export interface ArtifactCatalogSource {
  catalog(): Promise<{ artifacts: ArtifactRow[] }>
  /**
   * The project's artifact rows WITH their provenance — the read every input picker
   * resolves against.
   *
   * It is a SECOND method rather than a reuse of `catalog()` because the two are served by
   * two different endpoints carrying two different row types, and only one of them can
   * answer the question a dependent control asks. `catalog()` is the project OVERVIEW: its
   * rows are the bare artifact record, with no `source_dataset_id` — the field is
   * PROVENANCE-DERIVED (a lineage walk), not a column, so the overview cannot carry it.
   *
   * That mattered exactly once, and it was invisible: `siblingsOnAxis` scopes candidates by
   * `source_dataset_id` and returns NOTHING when it is absent, so every axis-scoped source
   * in every shipped view resolved to zero against the real backend: every dependent
   * picker offered nothing, and the criteria builder that reads an axis' columns had none.
   * Every unit fixture in the tree hand-wrote the field, so nothing went red; the
   * type let it through because a nullable field is legal to omit. `core/render/
   * shippedFormConformance.test.tsx` is the tier that now holds this shut, by driving its
   * catalog through the real wire→row mapper from a fixture typed as the wire type.
   */
  artifacts: {
    query(selector: ArtifactRowQuery): Promise<ArtifactRow[]>
  }
}

/** The narrow selector core passes to {@link ArtifactCatalogSource.artifacts.query}. Core
 *  asks for EVERYTHING (`{}`) and each widget filters by its own declared `source`
 *  (INV-2); the fields exist so the port structurally matches the publisher's wider one. */
export interface ArtifactRowQuery {
  type?: string
  subtypesOf?: string
  capability?: string
}

/** The scope channel `DeclarativeRegion` publishes the project's artifact rows on — an
 *  INTERNAL key like `caps`, deliberately not a `$`-ref namespace (a view may not query
 *  the catalog directly; it declares a `source` and the engine resolves it). */
export const CATALOG_SCOPE_KEY = 'catalog'

/** What the catalog channel carries: the project's rows, plus the lattice a source's
 *  `subtypes_of` / `excludes` / `capabilities` constraints are evaluated against. Absent
 *  on a bare mount ⇒ no candidates (and the negative constraints fail closed). */
export interface CatalogScope {
  artifacts: readonly ArtifactRow[]
  lattice?: DatatypeLattice
}

/** Read the channel off a render scope, degrading to an EMPTY catalog rather than throwing
 *  when the host published nothing (a bare unit mount). The shape check is deliberately
 *  structural: a scope is `unknown`-valued by construction, and a control that trusted the
 *  key blindly would hand a non-array to the resolver. */
export function readCatalogScope(scope: Scope): CatalogScope {
  const c = scope[CATALOG_SCOPE_KEY]
  if (c && typeof c === 'object' && Array.isArray((c as CatalogScope).artifacts)) return c as CatalogScope
  return { artifacts: [] }
}
