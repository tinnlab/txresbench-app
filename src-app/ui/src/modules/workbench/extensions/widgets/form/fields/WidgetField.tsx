import { useMemo } from 'react'
import type { WidgetField as WidgetFieldT } from '@/modules/workbench/core'
import { resolveWidget } from '@/modules/workbench/extensions/widgets/form/widgets/registry'
import { FieldFrame } from './FieldFrame'

/**
 * Tier-3 — a host-provided rich widget slot. Resolves `field.widget` through the OPEN
 * widget seam (ITEM-53) and renders it bound to `value`. `resolveWidget` never returns
 * undefined — an unregistered/not-yet-wired widget id degrades to a labeled stub
 * placeholder (never a crash). Memoized on the widget id so an unknown-kind stub isn't
 * re-created (remounted) on every render.
 */
export function WidgetField({
  field,
  value,
  onChange,
}: {
  field: WidgetFieldT
  value: unknown
  onChange: (v: unknown) => void
}) {
  const Widget = useMemo(() => resolveWidget(field.widget), [field.widget])
  const controlId = `schemaform-ctl-${field.id}`
  const testid = `schemaform-field-${field.id}`
  return (
    <FieldFrame field={field} htmlFor={controlId}>
      <Widget value={value} onChange={onChange} config={field.config} data-testid={testid} />
    </FieldFrame>
  )
}
