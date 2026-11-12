// Boot-time registration of the built-in field renderers (ITEM-54). Kept separate from
// `registry.tsx` so that seam stays import-light (framework-free → node-unit-testable);
// this file wires the real `@txresbench/kit`-backed renderers + the artifact-ref / widget
// adapters and registers each through the open field-renderer registry. Called once for
// its side-effect at module load by `SchemaForm.tsx` (idempotent). Mirrors
// `result/builtinRenderers.ts`.

import type { FieldRendererProps } from './registry'
import { registerFieldRenderer } from './registry'
import {
  NumberFieldRenderer,
  EnumFieldRenderer,
  BooleanFieldRenderer,
  StringFieldRenderer,
  ArrayFieldRenderer,
} from './ScalarRenderers'
import { ArtifactRefField } from './ArtifactRefField'
import { WidgetField } from './WidgetField'

/** Tier-2 adapter: narrow the union + delegate to the artifact-ref picker. */
function ArtifactRefFieldRenderer({ field, value, values, onChange, origin }: FieldRendererProps) {
  if (field.type !== 'artifact-ref') return null
  // ITEM-15 — the artifact-ref control is the one that can hold an AUTO-bound value, so
  // it is the one that has to say so; the origin rides the same dispatch as the value.
  return <ArtifactRefField field={field} value={value} values={values} onChange={onChange} origin={origin} />
}

/** Tier-3 adapter: narrow the union + delegate to the widget slot (which itself resolves
 *  the ITEM-53 widget-name seam — the two registries compose here). */
function WidgetFieldRenderer({ field, value, onChange }: FieldRendererProps) {
  if (field.type !== 'widget') return null
  return <WidgetField field={field} value={value} onChange={onChange} />
}

let done = false

/** Register the built-in `field.type` → renderer set: the 5 scalar controls + the
 *  artifact-ref picker + the host-widget slot (idempotent; last-wins per the registry). */
export function registerBuiltinFieldRenderers(): void {
  if (done) return
  done = true
  registerFieldRenderer('number', NumberFieldRenderer)
  registerFieldRenderer('enum', EnumFieldRenderer)
  registerFieldRenderer('boolean', BooleanFieldRenderer)
  registerFieldRenderer('string', StringFieldRenderer)
  registerFieldRenderer('array', ArrayFieldRenderer)
  registerFieldRenderer('artifact-ref', ArtifactRefFieldRenderer)
  registerFieldRenderer('widget', WidgetFieldRenderer)
}
