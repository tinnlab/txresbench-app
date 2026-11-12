// The five Tier-1 scalar field renderers (ITEM-54) — one component per `field.type`,
// each registered into the open field-renderer registry. This REPLACES the former
// monolithic `ScalarField` `switch(field.type)`: the dispatch now lives in the registry
// (keyed by type), and each control is an independently-registrable renderer, so an
// extension can override a single scalar type or add a new one. Each renderer takes the
// shared `FieldRendererProps` and narrows on its own discriminant (defensive: a
// mismatched type renders nothing rather than throwing — the registry only ever routes
// the matching type here).

import { Input, InputNumber, MultiSelect, Select, Slider, Switch, Textarea } from '@txresbench/kit'
import type {
  ArrayField as ArrayFieldT,
  BooleanField as BooleanFieldT,
  EnumField as EnumFieldT,
  NumberField as NumberFieldT,
  StringField as StringFieldT,
} from '@/modules/workbench/core'
import { FieldFrame } from './FieldFrame'
import type { FieldRendererProps } from './registry'
import { useEnumOptions } from '@/modules/workbench/extensions/widgets/form/useDependentOptions'

/**
 * Interpolate a templated default like `"Cluster {embedding}"` from sibling field
 * values. Display-only (used when the field has no explicit value yet) — the literal
 * typed string is what flows out through `onChange`; keep it simple (no nesting/escapes).
 */
function applyTemplate(str: string, values: Record<string, unknown>): string {
  return str.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = values[key]
    return v == null ? '' : String(v)
  })
}

/** number → InputNumber, plus a Slider when BOTH bounds are known (a slider needs a range). */
export function NumberFieldRenderer({ field, value, onChange }: FieldRendererProps) {
  if (field.type !== 'number') return null
  const f = field as NumberFieldT
  const controlId = `schemaform-ctl-${f.id}`
  const testid = `schemaform-field-${f.id}`
  const name = f.title ?? f.id
  const current = typeof value === 'number' ? value : f.default
  const hasRange = f.min !== undefined && f.max !== undefined
  const sliderVal = typeof current === 'number' ? current : (f.min ?? 0)
  const numberInput = (
    <InputNumber
      id={controlId}
      className={hasRange ? 'w-24' : undefined}
      value={current ?? null}
      min={f.min}
      max={f.max}
      step={f.step}
      onChange={n => onChange(n)}
      data-testid={testid}
    />
  )
  return (
    <FieldFrame field={f} htmlFor={controlId}>
      {hasRange ? (
        <div className="flex items-center gap-3">
          <Slider
            className="flex-1"
            min={f.min}
            max={f.max}
            step={f.step}
            value={[sliderVal]}
            onValueChange={v => onChange(typeof v === 'number' ? v : v[0])}
            aria-label={name}
            data-testid={`${testid}-slider`}
          />
          {numberInput}
        </div>
      ) : (
        numberInput
      )}
    </FieldFrame>
  )
}

/** enum → Select. Resolves dependent options (ITEM-37) from the live siblings before
 *  render; a non-resolver enum uses its static `options` synchronously (back-compat). */
export function EnumFieldRenderer({ field, value, values, onChange }: FieldRendererProps) {
  const isEnum = field.type === 'enum'
  const f = field as EnumFieldT
  const rawDefault = isEnum ? (f.default ?? undefined) : undefined
  // The DISPLAYED value is the explicit value, else the field's default. Pass THIS (not the
  // raw `value`) to the clear logic so a displayed default that falls outside a freshly-
  // resolved dependent option set is handled, not only an explicit selection.
  const displayed = typeof value === 'string' ? value : rawDefault
  // Hooks run unconditionally (a renderer for a single type); a non-enum route (never
  // taken via the registry) passes inert inputs so the hook order stays stable.
  const { options } = useEnumOptions({
    staticOptions: isEnum ? f.options : [],
    resolver: isEnum ? f.optionsResolver : undefined,
    values,
    current: displayed,
    onClear: () => onChange(undefined),
  })
  if (!isEnum) return null
  const controlId = `schemaform-ctl-${f.id}`
  const testid = `schemaform-field-${f.id}`
  // Never show a value the picker can't offer: a resolved dependent set may exclude the
  // displayed default → render it as unselected (the placeholder) rather than an orphaned,
  // un-clearable selection.
  const selected = displayed && options.includes(displayed) ? displayed : undefined
  return (
    <FieldFrame field={f} htmlFor={controlId}>
      <Select
        id={controlId}
        options={options.map(o => ({ label: o, value: o }))}
        value={selected}
        onChange={v => onChange(v)}
        placeholder="Select…"
        allowClear
        clearLabel="Clear selection"
        data-testid={testid}
      />
    </FieldFrame>
  )
}

/** boolean → Switch. */
export function BooleanFieldRenderer({ field, value, onChange }: FieldRendererProps) {
  if (field.type !== 'boolean') return null
  const f = field as BooleanFieldT
  const controlId = `schemaform-ctl-${f.id}`
  const testid = `schemaform-field-${f.id}`
  const name = f.title ?? f.id
  const current = typeof value === 'boolean' ? value : (f.default ?? false)
  return (
    <FieldFrame field={f} htmlFor={controlId}>
      <Switch
        id={controlId}
        checked={current}
        onCheckedChange={c => onChange(c)}
        aria-label={name}
        data-testid={testid}
      />
    </FieldFrame>
  )
}

/** string → Input / Textarea (with templated-default interpolation from siblings). */
export function StringFieldRenderer({ field, value, values, onChange }: FieldRendererProps) {
  if (field.type !== 'string') return null
  const f = field as StringFieldT
  const controlId = `schemaform-ctl-${f.id}`
  const testid = `schemaform-field-${f.id}`
  const current = typeof value === 'string' ? value : applyTemplate(f.default ?? '', values)
  return (
    <FieldFrame field={f} htmlFor={controlId}>
      {f.multiline ? (
        <Textarea id={controlId} value={current} onChange={e => onChange(e.target.value)} data-testid={testid} />
      ) : (
        <Input id={controlId} value={current} onChange={e => onChange(e.target.value)} data-testid={testid} />
      )}
    </FieldFrame>
  )
}

/** array → MultiSelect (enum items) or a comma editor (non-enum items). */
export function ArrayFieldRenderer({ field, value, onChange }: FieldRendererProps) {
  if (field.type !== 'array') return null
  const f = field as ArrayFieldT
  const controlId = `schemaform-ctl-${f.id}`
  const testid = `schemaform-field-${f.id}`
  const name = f.title ?? f.id
  const items = f.items
  const arr = Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string')
    : Array.isArray(f.default)
      ? f.default.filter((x): x is string => typeof x === 'string')
      : []
  return (
    <FieldFrame field={f} htmlFor={controlId}>
      {items.type === 'enum' ? (
        <MultiSelect
          id={controlId}
          options={items.options.map(o => ({ label: o, value: o }))}
          value={arr}
          onChange={v => onChange(v)}
          placeholder="Select…"
          searchPlaceholder="Search…"
          emptyText="No options"
          removeLabel={l => `Remove ${l}`}
          aria-label={name}
          data-testid={testid}
        />
      ) : (
        <Input
          id={controlId}
          value={arr.join(', ')}
          onChange={e =>
            onChange(
              e.target.value
                .split(',')
                .map(s => s.trim())
                .filter(Boolean),
            )
          }
          placeholder="comma, separated, values"
          data-testid={testid}
        />
      )}
    </FieldFrame>
  )
}
