// Tier-1..3 params-schema TYPES (ITEM-16). P5 DEFINES the JSON-schema
// vocabulary a contribution declares; **P6 owns the `SchemaForm` renderer** (A3)
// — this file is types + pure discriminators only, no React.
//
// The vocabulary covers the observed ~90% of legacy params (71 Select / 23
// InputNumber / 12 Input / 8 Switch): number(min/max/step) · enum · boolean ·
// string · array, plus the artifact-ref field (Tier-2) and the host-widget slot
// (Tier-3), conditional `when`, templated defaults, and `repeat-per`.
//
// REMOVED — the MULTI-STEP (wizard) schema and the Tier-4 CODE-FORM escape hatch.
// `steps?: StepSpec[]`, `StepSpec`, `ParamsFormRef`, the `ParamsDeclaration` union
// and their discriminators/helpers (`isSteppedSchema` · `reachableSteps` ·
// `stepValid` · `isCodeForm` · `flattenFields` · `projectParamsForMcp`) were deleted
// as UNREACHABLE: see the restoration note at the head of
// `extensions/widgets/form/SchemaForm.tsx` for what a future author would have to put
// back. A schema is now exactly `{ fields }`, so every helper below takes
// `ParamsSchema` directly and there is no declaration union left to discriminate.

import type { DatatypeLattice } from '../datatypes/lattice.ts'
import type { TypeSelector } from '../datatypes/types.ts'
import type { WhenClause, WhenContext } from '../datatypes/when.ts'
import { evaluateWhen } from '../datatypes/when.ts'
import type { DataDrivenDefaultResolver } from './defaults.ts'
import type { ValueRef } from '../columns/ref.ts'

/** Shared field metadata (the `doc` is the SAME string the LLM reads, §0.4.2). */
interface FieldBase {
  id: string
  title?: string
  doc?: string
  required?: boolean
  /** conditional visibility — a sub-clause over the sibling field values / project state. */
  when?: WhenClause
  /** repeat this sub-field once per selected artifact of the named artifact-ref field. */
  repeatPer?: string
}

/** ITEM-37 — a field's option set as a function of the CURRENT form values (dependent
 *  options). Additive: a field WITHOUT a resolver keeps its static `options`/`accepts`
 *  (back-compat). The resolver is FE-runtime-only and non-serializable; the static
 *  `options`/`accepts` is what any non-FE reader sees. (It used to say "the MCP projection
 *  strips the function" — there IS no form projection any more: it went with the stepped /
 *  code-form shapes, and the contribution catalog projects `appliesTo`, not a form.) */
export type OptionsResolver = (values: Record<string, unknown>) => string[] | Promise<string[]>
export type AcceptsResolver = (values: Record<string, unknown>) => TypeSelector | Promise<TypeSelector>

export interface NumberField extends FieldBase {
  type: 'number'
  min?: number
  max?: number
  step?: number
  default?: number
  /** ITEM-64 — a data-driven default RESOLVER: when present, the FE prefills this field
   *  from a `DataSummary` of the selected input (e.g. a MAD-based QC threshold); `default`
   *  remains the static fallback. FE-runtime-only and non-serializable, like ITEM-37's
   *  `optionsResolver`. */
  defaultResolver?: DataDrivenDefaultResolver
  /** ITEM-64 — the columns the host summarizes (into the `DataSummary` keyed by `key`)
   *  so the `defaultResolver` can read them. JSON-serializable, but only the FE reads it. */
  summaryColumns?: Array<{ key: string; ref: ValueRef }>
  /**
   * E4/E5 (DOMAIN_AUDIT) — this number is a CAP on an input AXIS, named here by the
   * processor. The live param preview then estimates the outcome exactly:
   * `min(value, resident length of <capsAxis>)`, labelled `<capsAxis> kept`.
   *
   * It exists because the preview used to GUESS which params were caps by matching their
   * ids against two regex tables of single-cell vocabulary (`max_cells`, `n_top_genes`, …)
   * and then labelled the outcome "cells kept" / "features kept" — i.e. the workbench
   * inferring a processor's semantics from its spelling, and naming a biological axis on
   * behalf of every processor. Whether a param is a cap, and of what, is the processor's
   * to state. A field that does not state it gets the honest DEFERRED preview.
   *
   * JSON-serializable (survives the MCP projection); only the FE reads it.
   */
  capsAxis?: string
}

export interface EnumField extends FieldBase {
  type: 'enum'
  /** the STATIC option set (also the JSON-serializable superset the MCP tool schema
   *  advertises when `optionsResolver` is present). */
  options: string[]
  /** ITEM-37 — dependent options: when present, the live picker re-resolves the option
   *  set from the current form values; `options` remains the static MCP fallback. */
  optionsResolver?: OptionsResolver
  default?: string
}

export interface BooleanField extends FieldBase {
  type: 'boolean'
  default?: boolean
}

export interface StringField extends FieldBase {
  type: 'string'
  /** templated default, e.g. `"Run {name}"` (interpolated from sibling values). */
  default?: string
  multiline?: boolean
}

export interface ArrayField extends FieldBase {
  type: 'array'
  items: ScalarField
  default?: unknown[]
}

/** Tier-2 — an artifact-ref input → an auto-populated, type-filtered picker.
 *  `accepts` does double duty: it gates availability AND generates the picker. */
export interface ArtifactRefField extends FieldBase {
  type: 'artifact-ref'
  /** the STATIC accept selector (also the JSON-serializable fallback the MCP tool schema
   *  advertises when `acceptsResolver` is present). */
  accepts: TypeSelector
  /** ITEM-37 — dependent accept: when present, the live picker re-resolves the accept
   *  selector from the current form values (e.g. a second ref narrowed by the first);
   *  `accepts` remains the static MCP fallback. */
  acceptsResolver?: AcceptsResolver
  multiple?: boolean
}

/** Tier-3 — a host-provided rich widget, referenced by registered NAME (the widget
 *  vocabulary is contributed, never enumerated here). */
export interface WidgetField extends FieldBase {
  type: 'widget'
  widget: string
  /** opaque per-widget config forwarded to the host widget. */
  config?: Record<string, unknown>
}

export type ScalarField = NumberField | EnumField | BooleanField | StringField | ArrayField
export type ParamField = ScalarField | ArtifactRefField | WidgetField

/**
 * The declarative params schema — an ORDERED FLAT field list, and nothing else.
 * (It once carried an optional `steps` wizard grouping; that is gone, see the header.)
 */
export interface ParamsSchema {
  fields: ParamField[]
}

// --- pure discriminators (renderer-agnostic; used by the host) ---

export function isArtifactRefField(f: ParamField): f is ArtifactRefField {
  return f.type === 'artifact-ref'
}
export function isWidgetField(f: ParamField): f is WidgetField {
  return f.type === 'widget'
}
export function isScalarField(f: ParamField): f is ScalarField {
  return f.type === 'number' || f.type === 'enum' || f.type === 'boolean' || f.type === 'string' || f.type === 'array'
}

/** The artifact-ref fields of a params schema — the availability inputs (§4.3). */
export function artifactRefFields(schema: ParamsSchema): ArtifactRefField[] {
  return schema.fields.filter(isArtifactRefField)
}

// ─── ITEM-36 conditional visibility (pure, unit-testable) ───

/** The datatype half of a `WhenContext` (no `values`) — what the callers
 *  below layer the current form `values` onto. */
export type GatingContext = Pick<WhenContext, 'producedTypeIds'>

/** Is ONE field visible for the current values + project state? A field with no
 *  `when` is always visible; otherwise its `when` is evaluated with the form values
 *  threaded in (ITEM-36). */
export function isFieldVisible(
  field: ParamField,
  values: Record<string, unknown>,
  ctx: GatingContext,
  lattice: DatatypeLattice,
): boolean {
  if (field.when === undefined) return true
  return evaluateWhen(field.when, { ...ctx, values }, lattice)
}

/** Every field CURRENTLY visible: declared on the schema and passing its own `when`.
 *  The set validation + param-pruning operate on. */
export function visibleFields(
  schema: ParamsSchema,
  values: Record<string, unknown>,
  ctx: GatingContext,
  lattice: DatatypeLattice,
): ParamField[] {
  return schema.fields.filter(f => isFieldVisible(f, values, ctx, lattice))
}

/** Does a field have a non-empty value? (a `false` boolean counts as filled; a blank
 *  string / empty array / nullish does not). Drives required-field step validation. */
export function isFieldFilled(field: ParamField, values: Record<string, unknown>): boolean {
  const v = values[field.id]
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

/**
 * The submitted params for the current values — with any DECLARED-but-HIDDEN field's
 * key removed (ITEM-36: no stale hidden-value leak). Only declared field keys that are
 * currently hidden are stripped; every other key (incl. non-field keys) passes through
 * unchanged, so a flat non-conditional form is byte-identical to `values`.
 */
export function pruneHiddenParams(
  schema: ParamsSchema,
  values: Record<string, unknown>,
  ctx: GatingContext,
  lattice: DatatypeLattice,
): Record<string, unknown> {
  const declaredIds = new Set(schema.fields.map(f => f.id))
  const visibleIds = new Set(visibleFields(schema, values, ctx, lattice).map(f => f.id))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    if (declaredIds.has(k) && !visibleIds.has(k)) continue // declared + hidden ⇒ drop
    out[k] = v
  }
  return out
}

// REMOVED — `projectParamsForMcp` + its private `stripFieldResolvers` helper (the
// ITEM-37 MCP static projection). It was written against the `ParamsDeclaration`
// union: it returned `null` for a code-form and FLATTENED a stepped schema, so both of
// its jobs disappeared with those two shapes. It also had no production caller —
// `core/mcp/metadata.ts` imported it and never called it, and its own header records
// why: "`params` is gone from the manifest … what an agent needs to CALL an analysis is
// its input slots + their type constraints, which `appliesTo` carries directly — no
// projection". The catalog projects `appliesTo`; nothing projects a form.
