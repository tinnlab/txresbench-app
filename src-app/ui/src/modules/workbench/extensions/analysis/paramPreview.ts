// Param→outcome LIVE preview (ITEM-65) — an honest, pre-submit hint of what a param
// will do, shown as the user tweaks it (before committing a run).
//
// HONESTY CONTRACT (the crux of this item): we NEVER fabricate an outcome number the
// front end can't actually compute cheaply.
//   • ESTIMATE (a real number) — only for a param the processor DECLARES to be a cap on
//     an input axis (`capsAxis`), whose outcome is then a pure function of already-known
//     data: kept ≈ min(cap, resident length of that axis). This is exact + free (no
//     compute, no blob read).
//
// E4/E5 (DOMAIN_AUDIT): the cap classification used to be a REGEX TABLE matching a
// processor's param NAMES against single-cell vocabulary (`max_cells`, `n_top_genes`,
// `subsample`, …), with the user-visible labels "cells kept" / "features kept", and the
// resident sizes were typed as `{inputCells, inputFeatures}` — the two-axis assumption
// encoded as a TYPE and propagated to every consumer. Both are gone: which params are
// caps, of which axis, and what that axis is CALLED are the processor's to declare. The
// table matched no shipping param anyway (the single number field in the tree,
// cellranger's `expected_cells`, does not match either pattern), so nothing that worked
// stopped working — but a processor that wants the estimate can now ask for it, and an
// image processor no longer risks being told how many "cells" it kept.
//   • DEFERRED ("computes on run") — everything else: a clustering `resolution`
//     →group-count needs the actual clustering compute; a `threshold`→rows-kept needs
//     the per-row column data (and the ITEM-47 client `summarize` evaluator, not yet
//     available). We show a "computes on run" affordance, optionally with a QUALITATIVE
//     direction arrow taken VERBATIM from the field's own `doc` ("higher = finer
//     clusters" ⇒ ↑) — a hint, never a fabricated figure.
//
// Pure — `ParamOutcomePreview` renders from this; the unit test drives it directly.

import type { ParamField } from '@/modules/workbench/core'

/** The resident (already-loaded / cheaply-known) length of each INPUT AXIS, keyed by the
 *  axis NAME a field's `capsAxis` refers to. A cap field is only estimated when its axis
 *  is present here; an unknown axis DEFERS rather than guessing. Nothing in the type names
 *  an axis (E5). */
export type ResidentInput = Record<string, number | undefined>

/** One DECLARED axis contribution: the axis LABEL an input artifact's datatype declares at
 *  one dim position, with that position's declared length. */
export interface AxisContribution {
  axis: string
  length: number
}

/**
 * Fold declared (axis label, length) contributions into a `ResidentInput` WITHOUT ever
 * combining two axes arithmetically (INV-3).
 *
 * This replaced `resident[axis] = Math.max(resident[axis] ?? 0, length)`. `max` over a
 * label-keyed map is name-as-identity plus a FABRICATION: two contributions that disagree
 * on a label's length are, by that disagreement, two DIFFERENT axes (identity determines
 * cardinality, so one axis cannot have two), and the max is a figure belonging to neither
 * — the exact defect `derive_axes` documents removing server-side ("nothing is ever folded
 * arithmetically; every reported length is some single artifact's own declared n").
 *
 * So: contributions that AGREE report their (single) length; contributions that DISAGREE
 * report `undefined`, which `previewParamOutcomes` reads as "no known length" and DEFERS
 * ("computes on run") instead of estimating against an invented one. The label is kept as
 * a PRESENT key with an undefined value, so a refusal is distinguishable from an axis
 * nothing ever mentioned.
 *
 * Length disagreement is the identity signal actually available here, and the only one:
 * an `ArtifactRow` carries no axis `content_hash`, and a datatype's `axes[]` are
 * DECLARATIONS (labels, written before any artifact exists). It PROVES distinctness
 * without being able to prove sameness — which is the right way round, because the
 * failure being closed is the fabricated number, and two same-label axes that share a
 * length fabricate nothing (that length is correct for either).
 *
 * The project CATALOG is deliberately not consulted, even though it does carry identity:
 * a label that names two axes there says nothing about the SELECTED INPUT's axis, so
 * refusing on catalog-level ambiguity would drop a correct estimate for the input the user
 * actually picked.
 */
export function buildResidentInput(contributions: Iterable<AxisContribution>): ResidentInput {
  const lengthsByAxis = new Map<string, Set<number>>()
  for (const { axis, length } of contributions) {
    if (!axis) continue
    const lengths = lengthsByAxis.get(axis) ?? new Set<number>()
    lengths.add(length)
    lengthsByAxis.set(axis, lengths)
  }
  const resident: ResidentInput = {}
  for (const [axis, lengths] of lengthsByAxis) {
    const [only] = lengths
    resident[axis] = lengths.size === 1 ? only : undefined
  }
  return resident
}

/** What the run panel knows about its currently-selected artifact-ref inputs. Both lookups
 *  are INJECTED so the resident-axis derivation stays pure (and testable) rather than
 *  reaching for the datatype registry and the structure decoder itself. */
export interface ArtifactRefSelection<Row> {
  /** the analysis's single-value artifact-ref fields, in declaration order. */
  fields: { id: string }[]
  /** the current param values (a field's value is the selected row's id). */
  params: Record<string, unknown>
  /** the rows the picker resolved for each field id. */
  rowsByField: Record<string, Row[] | undefined>
  /** the axis LABELS a datatype declares, by dim POSITION. */
  axesOf: (datatype: string) => { name: string }[]
  /** the DECLARED dim lengths of one row. */
  dimsOf: (row: Row) => number[]
}

/**
 * The resident input axis lengths for the currently-selected single-value artifact-ref
 * inputs — the run panel's whole `residentInput` derivation, lifted out of the component so
 * the INV-3 fold is under test at the site that performs it (a `Math.max` reintroduced here
 * fails, where a test of `buildResidentInput` alone would not have seen it).
 */
export function residentInputForSelection<Row extends { id: string; datatype: string }>(
  sel: ArtifactRefSelection<Row>,
): ResidentInput {
  const contributions: AxisContribution[] = []
  for (const f of sel.fields) {
    const selected = sel.params[f.id]
    if (typeof selected !== 'string') continue
    const row = sel.rowsByField[f.id]?.find(r => r.id === selected)
    if (!row) continue
    const axes = sel.axesOf(row.datatype)
    sel.dimsOf(row).forEach((length, i) => {
      const axis = axes[i]?.name
      if (!axis) return
      contributions.push({ axis, length })
    })
  }
  return buildResidentInput(contributions)
}

export type OutcomePreview =
  | { field: string; metric: string; kind: 'estimate'; value: number; note: string }
  | { field: string; metric: string; kind: 'deferred'; reason: string; direction?: 'up' | 'down' }

/** A monotone direction hinted by the field's OWN doc string (the author's words, not
 *  our invention). Returns undefined when the doc states no comparative relationship. */
export function directionFromDoc(doc: string | undefined): 'up' | 'down' | undefined {
  if (!doc) return undefined
  const d = doc.toLowerCase()
  if (/\b(higher|more|finer|increase|increasing|larger)\b/.test(d)) return 'up'
  if (/\b(lower|fewer|coarser|decrease|decreasing|smaller)\b/.test(d)) return 'down'
  return undefined
}

function numeric(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Preview the outcome of each numeric param under the current values. Only NUMBER
 *  fields carry an outcome hint (enums/booleans/strings/artifact-refs/widgets have no
 *  cheap scalar outcome). A field that DECLARES `capsAxis`, whose axis has a known
 *  resident length, ESTIMATEs a kept count; every other number field DEFERS with an
 *  optional doc-derived direction. */
export function previewParamOutcomes(
  fields: ParamField[],
  params: Record<string, unknown>,
  resident: ResidentInput = {},
): OutcomePreview[] {
  const out: OutcomePreview[] = []
  for (const field of fields) {
    if (field.type !== 'number') continue
    const value = numeric(params[field.id])
    if (value === undefined) continue

    // The DECLARED cap axis (`capsAxis`) + a known resident length for it is the only
    // thing that earns a real number. Everything else defers.
    const axis = field.capsAxis
    const available = axis ? resident[axis] : undefined
    if (axis && available !== undefined) {
      out.push({
        field: field.id,
        metric: `${axis} kept`,
        kind: 'estimate',
        value: Math.min(value, available),
        note: `≈ min(${value.toLocaleString()}, ${available.toLocaleString()} in)`,
      })
      continue
    }
    out.push({
      field: field.id,
      metric: field.id,
      kind: 'deferred',
      reason: 'computes on run',
      direction: directionFromDoc(field.doc),
    })
  }
  return out
}
