// The INTEGRATION BINDING PLAN — the dataset × column grid the `integration analysis` compute
// reads, resolved from the CATALOG and nothing else.
//
// ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────────────────
//
// Stage 1's slot rework made the compute's inputs a GRID whose extent is data:
//
//     entity:<dataset_index>:<column>   an entity-axis identifier column   — slot FAMILY
//     level:<dataset_index>:<column>    a categorical to fuse on the level axis          — slot FAMILY
//     rows                              one level-axis index per dataset      — literal slot
//
// `run_processor.inputs_from` can BIND that shape — `pair-filter.yaml:762-766` ships the
// grammar (`for_each` + a `{…}`-interpolated slot + an `artifact` ref) — but a binding needs
// the ARTIFACT ID of each pair, and the view has no way to name one. `compatible_columns`
// answers "which columns could mean the same thing" and deliberately returns only
// `{name, kind, compatibility, levels, note}`: no artifact id, no dataset index. And `data:`
// sources are a CLOSED dispatch table, so there is no yaml-level workaround.
//
// So this resolver returns the whole binding plan at once. It is the missing half of the
// rework, not a convenience.
//
// ── INV-11: CATALOG-ONLY, AND STRUCTURALLY SO ───────────────────────────────────────────
//
// Same guarantee, and the same way of making it, as `resolveCompatibleColumns` beside it:
// this function takes `readonly ArtifactRow[]` and has NO read function in scope. It cannot
// open a column body because there is nothing here to call — the guarantee is structural
// rather than promised, and its slice reader issues exactly one `artifacts.query({})`.
//
// That matters more here than for the offer filter: this plan names EVERY identifier column
// of EVERY selected dataset, so a body-reading version would open dozens of stores merely
// because the pane was opened — the affordance the product tree already refused in writing.
//
// ── THE AXIS NAMES ARE REQUIRED ARGUMENTS, AND CARRY NO DEFAULT ─────────────────────────
//
// Both axes are declared by the VIEW and this module ships no fallback for either. That is a
// correction, not a precaution: an earlier version of this file carried two named constants
// holding the axis names of ONE domain, in `workbench/core`, where the app must carry zero of
// the domain lattice — that lattice is DATA (a package manifest), and a core module holding a
// copy of two of its entries is the leak the guard exists to catch. It was caught by the
// guard, on this module, and the constants are gone rather than baselined.
//
// A missing or empty axis argument therefore resolves to NOTHING — never to a guess. A guessed
// axis silently matches no artifact (`siblingsOnAxis` filters on
// `declaredAxes(structure).includes(axis)`), which renders as "these datasets share nothing"
// and is the blank-surface failure this entity has already paid for once: the shipped form
// asked for an axis no producer declares, and every fixture in the three suites covering it
// declared the same invented name, so the tests agreed with the view while both disagreed with
// every producer. Refusing to default is what stops that recurring silently.
//
// Which axis is which is the VIEW's statement about its own domain: one axis carries the
// identifiers being joined on, the other carries the row index and the categoricals to fuse.

import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { columnNameForMember, declaredAxes, isAxisArtifact, siblingsOnAxis, tableColumns } from './axisSource'
import { sourceDatasetIds } from '@/core/workstore/sourceDataset'

/** The `data.<slice>.source` value that selects this resolver. */
export const INTEGRATION_GRID_SOURCE = 'integration_grid'

export interface IntegrationGridArgs {
  /** `$`-ref to the datasets being integrated. The picker is an `artifact_ref`, so this
   *  resolves to a list of ARTIFACT ids — which is NOT what `params.dataset_ids` may carry.
   *  See {@link IntegrationGrid.datasetIds}. */
  of?: string
  /** `$`-ref to the column names the user chose to fuse. Absent ⇒ no `level:` bindings. */
  levels?: string
  /** The axis carrying the identifiers being joined on. REQUIRED — no default (see header). */
  entity_axis?: string
  /** The axis carrying the row index and the categoricals to fuse. REQUIRED — no default. */
  level_axis?: string
}

/** One BINDING of the grid — everything a `<family>:<index>:<column>` slot needs.
 *
 *  Named for what it produces (exactly one `inputs_from` binding) rather than for its position
 *  in a grid. The earlier name said "pair", which collides with a domain noun this module must
 *  not carry — and "binding" is the more accurate word regardless, not merely the vaguer one. */
export interface GridBinding {
  /** The dataset's index into {@link IntegrationGrid.datasetIds}. */
  index: number
  /** The column's declared name, verbatim — the slot carries it after the second `:`. */
  column: string
  /** The artifact to mount. */
  artifact: string
}

/** Why one dataset cannot take part. Rendered; never silently dropped. */
export interface BlockedDataset {
  dataset: string
  reason: string
}

export interface IntegrationGrid {
  /** Did the `of` reference resolve at all? Distinguishes "nothing chosen" from "chosen and
   *  unusable" — both are empty and they need different sentences. */
  anchored: boolean
  datasets: number
  /**
   * The grid's dataset dimension, in the order the indices refer to.
   *
   * This IS `params.dataset_ids`, and it holds **DATASET ids, not artifact ids.**
   *
   * ── THE DISTINCTION IS A DATA-SAFETY GATE, NOT BOOKKEEPING ────────────────────────────
   *
   * An earlier version relayed the picker's values straight through. The picker is an
   * `artifact_ref`, so those are ARTIFACT ids — and this file said both things at once
   * ("a LIST of artifact ids" on the argument, "This IS `params.dataset_ids`" here), which is
   * how it survived review inside one file.
   *
   * The consequence is downstream and severe. The creator records these as
   * `metadata.alignment.source_dataset_ids`; `detach_guard.rs` parses each as a UUID and
   * compares it against the **datasets** table id, consulting its name fallback only when the
   * string is NOT a UUID. An artifact id IS a well-formed UUID, so the fallback is skipped and
   * the comparison can never succeed — **ITEM-40's refusal is silently inert on every real
   * run**, and a user detaches a source out from under an integrated dataset whose data does
   * not exist without it.
   *
   * Nothing caught it because every check was self-consistent: both sides of the cross-check
   * carried artifact ids (the creator's own comment calls that "a TAUTOLOGY, not a
   * cross-check"), and the end-to-end test built `dataset_ids` from real `POST /datasets`
   * responses — the harness feeding the correct shape the UI never produced.
   */
  datasetIds: string[]
  /**
   * `dataset id → that dataset's row-index artifact's `content_hash``. **This IS
   * `params.dataset_content_hashes`.**
   *
   * ── IT IS A MAP, AND THAT IS LOAD-BEARING ─────────────────────────────────────────────
   *
   * The compute cross-checks the positional `rows` relay against this, and the check only has
   * force because this side is KEYED BY DATASET while the other is positional. The producer's
   * own docstring records that an earlier, parallel-list version **passed a reversed relay** —
   * reversing the ids while the hashes stayed put left every (wire hash, params hash) pair
   * still matching, because both sides were relayed and neither was tied to a dataset. A
   * positional convenience here re-opens a hole that has already been closed once.
   */
  contentHashes: Record<string, string>
  /**
   * The row-index artifact ids, **positionally aligned with `datasetIds`**. This IS the
   * literal `rows` slot's value.
   */
  rows: string[]
  entityBindings: GridBinding[]
  levelBindings: GridBinding[]
  /** Datasets excluded from the plan, with the reason. */
  blocked: BlockedDataset[]
  /**
   * `blocked.length`, in the PAYLOAD.
   *
   * Carried as a number for the same reason `CompatibleColumns` carries `datasets`/`count`:
   * a view's `when` grammar compares scalars, and the several states a form must tell apart
   * (nothing chosen / one chosen / chosen-but-a-source-is-unusable) all have to be gateable
   * separately. Deriving it in the view would mean a length test the grammar does not have.
   */
  blockedCount: number
  /**
   * Is this plan launchable? True only when there are ≥2 usable datasets, every one of them
   * has a row index AND at least one identifier column, and nothing is blocked.
   *
   * A PARTIAL plan must never launch. The entity axis is an INTERSECTION, so dropping a source
   * makes the result LARGER and every count would describe a join nobody requested — the
   * compute refuses this too, and a form that submits it turns a stateable refusal into a job
   * that fails minutes later.
   */
  ready: boolean
}

const NOTHING: IntegrationGrid = {
  anchored: false,
  datasets: 0,
  datasetIds: [],
  contentHashes: {},
  rows: [],
  entityBindings: [],
  levelBindings: [],
  blocked: [],
  blockedCount: 0,
  ready: false,
}

/**
 * The level-axis INDEX of a dataset: the artifact whose producer declared `meta.is_axis_index`.
 *
 * The `content_hash` requirement is not incidental. That hash is the whole cross-check — an
 * artifact without one cannot key `dataset_content_hashes`, so a row index missing it is not a
 * usable binding and must be reported as blocking rather than mounted with an empty hash. The
 * predicate is the same one `coordinateAxis.ts:66` derives, and it is a producer DECLARATION:
 * an artifact that does not carry it is not an axis index, whatever it is named.
 */
function rowIndexOf(artifacts: readonly ArtifactRow[], datasetId: string, axis: string): ArtifactRow | undefined {
  const onAxis = siblingsOnAxis(artifacts, datasetId, axis).filter(
    r => (r.meta as { is_axis_index?: unknown } | undefined)?.is_axis_index === true,
  )
  // AMBIGUITY REFUSES. Two declared indices on one axis is not a thing this can pick between,
  // and picking the first would silently choose which row order the whole integration is in.
  if (onAxis.length !== 1) return undefined
  const only = onAxis[0]
  if (typeof only.content_hash !== 'string' || only.content_hash === '') return undefined
  return only
}

/**
 * The single-column artifacts a dataset carries on one axis, as `name → artifact id`.
 *
 * A name carried TWICE by one dataset is dropped from the map and reported, never silently
 * resolved to the first: which artifact a `entity:<i>:<name>` slot refers to would be a coin
 * flip, and the slot name has no room to say which one was meant.
 */
function columnsOnAxis(
  artifacts: readonly ArtifactRow[],
  datasetId: string,
  axis: string,
): { byName: Map<string, string>; contested: Set<string> } {
  const byName = new Map<string, string>()
  const contested = new Set<string>()
  for (const row of siblingsOnAxis(artifacts, datasetId, axis)) {
    // An axis is not a column ON itself: mounting the index as an identifier column would
    // offer the row identifiers as something to join on, which is one distinct value per row.
    if (isAxisArtifact(row.structure)) continue
    if ((row.meta as { is_axis_index?: unknown } | undefined)?.is_axis_index === true) continue
    if (!declaredAxes(row.structure).includes(axis)) continue
    const members = tableColumns(row.structure)
    const name = columnNameForMember(row, members[0] ?? {}, members.length)
    if (!name) continue
    if (byName.has(name)) {
      contested.add(name)
      byName.delete(name)
      continue
    }
    if (contested.has(name)) continue
    byName.set(name, row.id)
  }
  return { byName, contested }
}

/**
 * Resolve the binding plan.
 *
 * PURE over catalog rows — no port, no read function in scope (INV-11, structurally).
 *
 * `datasetIds` arrives already resolved from the view's `of` reference, in the user's chosen
 * order; duplicates collapse. That order becomes the grid's dataset dimension and every
 * `index` refers to it, so the view MUST relay `datasetIds` back rather than re-deriving it.
 */
export function resolveIntegrationGrid(
  artifacts: readonly ArtifactRow[],
  args: IntegrationGridArgs,
  datasetIds: readonly string[],
  levelColumns: readonly string[],
): IntegrationGrid {
  const entityAxis = typeof args.entity_axis === 'string' ? args.entity_axis : ''
  const levelAxis = typeof args.level_axis === 'string' ? args.level_axis : ''
  // Undeclared REFUSES rather than defaulting — see the header.
  if (entityAxis === '' || levelAxis === '') return NOTHING
  const artifactIds = [...new Set(datasetIds.filter(id => typeof id === 'string' && id !== ''))]
  if (artifactIds.length === 0) return NOTHING

  const wanted = new Set(levelColumns.filter(c => typeof c === 'string' && c !== ''))

  const kept: string[] = []
  const contentHashes: Record<string, string> = {}
  const rows: string[] = []
  const entityBindings: GridBinding[] = []
  const levelBindings: GridBinding[] = []
  const blocked: BlockedDataset[] = []

  // TWO PASSES, because an index is only meaningful once the kept set is known. Assigning
  // indices in the first pass and then dropping a dataset would leave a hole in the dataset
  // dimension while every count still agreed — the silent mis-attribution the slot families
  // exist to prevent.
  // ── ARTIFACT → DATASET, and DEDUPED BY DATASET ──────────────────────────────────────
  //
  // The picker yields artifacts; `params.dataset_ids` must carry DATASET ids (see the field
  // doc). Deduping AFTER the mapping is what makes "integrate a dataset with itself"
  // unreachable: two modalities of one dataset are two artifacts and ONE dataset, so they
  // collapse here and the plan falls below the two-dataset floor instead of joining a dataset
  // against itself at 100% match with every cross-check agreeing.
  const seenDataset = new Set<string>()
  const ids: string[] = []
  const anchorOf = new Map<string, string>()
  for (const artifactId of artifactIds) {
    const row = artifacts.find(a => a.id === artifactId)
    const owners = row ? sourceDatasetIds(row) : []
    if (owners.length !== 1) {
      // AMBIGUITY REFUSES. An artifact belonging to several datasets (an already-integrated
      // one) has no single dataset id to relay, and picking the first would record a lineage
      // the detach gate would then enforce against the wrong dataset.
      blocked.push({
        dataset: artifactId,
        reason:
          owners.length === 0
            ? 'This artifact is not attributed to a dataset, so it cannot be recorded as a source.'
            : 'This artifact belongs to several datasets, so which one is being integrated is ambiguous.',
      })
      continue
    }
    const datasetId = owners[0]
    if (seenDataset.has(datasetId)) {
      blocked.push({
        dataset: datasetId,
        reason: 'Chosen twice — two artifacts of one dataset. A dataset cannot be integrated with itself.',
      })
      continue
    }
    seenDataset.add(datasetId)
    ids.push(datasetId)
    anchorOf.set(datasetId, artifactId)
  }

  const usable: Array<{ id: string; index: ArtifactRow; entity: Map<string, string>; level: Map<string, string> }> = []
  for (const datasetId of ids) {
    const anchor = anchorOf.get(datasetId) as string
    const index = rowIndexOf(artifacts, anchor, levelAxis)
    if (!index) {
      blocked.push({
        dataset: datasetId,
        reason:
          `No row index on the "${levelAxis}" axis, or more than one, or one without a content hash. ` +
          'The integration needs exactly one identified row order per dataset to join on.',
      })
      continue
    }
    const entity = columnsOnAxis(artifacts, anchor, entityAxis)
    if (entity.byName.size === 0) {
      blocked.push({
        dataset: datasetId,
        reason:
          `No identifier column on the "${entityAxis}" axis. Every dataset must contribute at ` +
          'least the column being joined on.',
      })
      continue
    }
    const level = columnsOnAxis(artifacts, anchor, levelAxis)
    usable.push({ id: datasetId, index, entity: entity.byName, level: level.byName })
  }

  for (const [index, d] of usable.entries()) {
    kept.push(d.id)
    contentHashes[d.id] = d.index.content_hash as string
    rows.push(d.index.id)
    // SORTED BY COLUMN NAME so the emitted plan is deterministic — but the sort is over the
    // NAME and the pairing is through the map, so it can never re-associate a column with a
    // different artifact however the catalog happened to be ordered.
    for (const column of [...d.entity.keys()].sort()) {
      entityBindings.push({ index, column, artifact: d.entity.get(column) as string })
    }
    for (const column of [...d.level.keys()].sort()) {
      // Only what the USER declared (INV-1). The catalog bounds the offer; it never selects.
      if (!wanted.has(column)) continue
      levelBindings.push({ index, column, artifact: d.level.get(column) as string })
    }
  }

  return {
    anchored: true,
    datasets: artifactIds.length,
    datasetIds: kept,
    contentHashes,
    rows,
    entityBindings,
    levelBindings,
    blocked,
    blockedCount: blocked.length,
    ready: blocked.length === 0 && kept.length >= 2,
  }
}
