// The OPEN field-renderer registry (ITEM-54). Replaces the form's three hardcoded
// dispatch points (`SchemaForm.GatedField`'s artifact-ref/widget/scalar if-chain +
// `ScalarField`'s `switch(field.type)`) with a single id→renderer map keyed by
// `field.type`, mirroring the component-seam pattern used by `ViewHost`
// (`registerViewComponent` / `BUILTIN_COMPONENTS` + unresolved-note fallback) and
// `artifactRegistry`. `SchemaForm` looks a renderer up by `field.type`; an
// unknown/unregistered type resolves to a VISIBLE fallback (never a crash, never a
// silent `return null`). Extensions can register NEW field types through the same seam.
//
// Import-light: this module holds only the seam + the framework-free fallback (React
// types + one tiny element), so it stays node-unit-testable; the concrete built-in
// renderers register at boot via `builtinFieldRenderers.ts`.

import type { ComponentType } from 'react'
import type { BindingOrigin, ParamField } from '@/modules/workbench/core'

/** The props every field renderer receives from `SchemaForm.GatedField`. `field` is the
 *  broad `ParamField` union (a renderer narrows on its own `field.type`); `value` is the
 *  field's own value; `values` is the whole params record (siblings — a string field
 *  interpolates a templated default, an enum resolves dependent options); `onChange`
 *  writes this field's value back. */
export interface FieldRendererProps {
  field: ParamField
  value: unknown
  values: Record<string, unknown>
  onChange: (v: unknown) => void
  /**
   * How this field's value was CHOSEN (ITEM-15), when the host tracks that. A renderer
   * that displays a binding must display its origin (INV-2), so it is handed down the
   * SAME channel as the value rather than looked up out of band.
   *
   * OPTIONAL, and absent means unknown — a host that tracks no origins (every host but
   * the run panel today) renders exactly what it rendered before this existed, and a
   * renderer that ignores the prop is unaffected.
   */
  origin?: BindingOrigin
}

export type FieldRenderer = ComponentType<FieldRendererProps>

// The open `field.type` → renderer seam (a plain module singleton, per `artifactRegistry`).
const RENDERERS: Record<string, FieldRenderer> = {}

/** Register (or replace) the renderer for a `field.type`. Called at boot by
 *  `registerBuiltinFieldRenderers`; extensions call it to add a NEW field type. */
export function registerFieldRenderer(type: string, renderer: FieldRenderer): void {
  RENDERERS[type] = renderer
}

/** Raw seam lookup — the registered renderer, or `undefined` when unregistered. */
export function getFieldRenderer(type: string): FieldRenderer | undefined {
  return RENDERERS[type]
}

/**
 * Resolve the renderer for a field type: the registered renderer, or the VISIBLE
 * `UnknownFieldFallback` for an unregistered type — never `undefined`, never a throw
 * (à la `ViewHost`'s unresolved note; distinct from the old silent `default: return
 * null`). This is what lets an extension-declared / unknown field type render a clear
 * placeholder instead of crashing the form.
 */
export function resolveFieldRenderer(type: string): FieldRenderer {
  return RENDERERS[type] ?? UnknownFieldFallback
}

/** The registered field types (introspection / the e2e window seam), id-sorted. */
export function registeredFieldTypes(): string[] {
  return Object.keys(RENDERERS).sort()
}

/** Test-only: clear the seam (test / HMR isolation). */
export function __resetFieldRegistry(): void {
  for (const k of Object.keys(RENDERERS)) delete RENDERERS[k]
}

/** The visible fallback for an unregistered field `type` (ITEM-54). A self-contained,
 *  accessible dashed note — mirrors the shell's "Unknown widget" placeholder + the
 *  `ViewHost` unresolved note — so an unknown/typo'd/extension-declared-but-unregistered
 *  field type is surfaced, never silently dropped or crashed. */
export function UnknownFieldFallback({ field }: FieldRendererProps) {
  return (
    <div
      className="rounded-md border border-dashed border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
      data-testid={`schemaform-field-${field.id}`}
    >
      Unsupported field type “{field.type}”
    </div>
  )
}

// Merge the field-type accessor onto the shared read-only form window seam (the widget
// registry installs `widgets`; this adds `fieldTypes`). Kept in sync with
// `widgets/registry.ts`.
if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __workbenchFormRegistry?: { widgets?: () => string[]; fieldTypes?: () => string[] }
  }
  w.__workbenchFormRegistry = { ...(w.__workbenchFormRegistry ?? {}), fieldTypes: registeredFieldTypes }
}
