// TEST-516 (ITEM-54) — the OPEN field-renderer registry that replaces the
// `ScalarField`/`SchemaForm` hardcoded `switch`/if-chain. VITEST style (the gate),
// node env, no DOM. `@txresbench/kit` is neutralized so the real built-in renderers import
// under the node runner (mirrors `host/workbenchDataSource.test.ts`). We assert the
// registry contract: a renderer resolves per `field.type`, a registered CUSTOM type
// resolves, an UNKNOWN type yields the visible `UnknownFieldFallback` (not a crash, not
// a silent null), and `registerBuiltinFieldRenderers` wires the built-in set.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@txresbench/kit', () => {
  const Stub = () => null
  return {
    Input: Stub,
    InputNumber: Stub,
    MultiSelect: Stub,
    Select: Stub,
    Slider: Stub,
    Switch: Stub,
    Textarea: Stub,
    Button: Stub,
    Empty: Stub,
    Combobox: Stub,
    Spin: Stub,
    Spinner: Stub,
    Alert: Stub,
    Tag: Stub,
    ScrollArea: Stub,
    message: { info: () => {}, success: () => {}, error: () => {} },
  }
})

import type { ParamField } from '@/modules/workbench/core'
import {
  registerFieldRenderer,
  getFieldRenderer,
  resolveFieldRenderer,
  registeredFieldTypes,
  UnknownFieldFallback,
  __resetFieldRegistry,
  type FieldRenderer,
  type FieldRendererProps,
} from './registry'
import { registerBuiltinFieldRenderers } from './builtinFieldRenderers'

const props = (field: ParamField): FieldRendererProps => ({ field, value: undefined, values: {}, onChange: () => {} })

beforeEach(() => __resetFieldRegistry())

describe('field-renderer registry seam', () => {
  it('resolves the registered renderer for a field type', () => {
    const NumberR: FieldRenderer = () => null
    expect(getFieldRenderer('number')).toBeUndefined()
    registerFieldRenderer('number', NumberR)
    expect(getFieldRenderer('number')).toBe(NumberR)
    expect(resolveFieldRenderer('number')).toBe(NumberR)
  })

  it('supports a registered CUSTOM (extension) field type', () => {
    const Custom: FieldRenderer = () => null
    registerFieldRenderer('color-swatch', Custom)
    expect(resolveFieldRenderer('color-swatch')).toBe(Custom)
    expect(registeredFieldTypes()).toContain('color-swatch')
  })

  it('resolves an UNKNOWN type to the visible UnknownFieldFallback (no crash, not null)', () => {
    expect(getFieldRenderer('mystery')).toBeUndefined()
    expect(resolveFieldRenderer('mystery')).toBe(UnknownFieldFallback)
    // The fallback RENDERS a visible note (a real element, not the old silent `null`).
    const el = UnknownFieldFallback(props({ id: 'foo', type: 'mystery' } as unknown as ParamField)) as {
      type: unknown
      props: Record<string, unknown>
    }
    expect(el).toBeTruthy()
    expect(el.type).toBe('div')
    expect(el.props['data-testid']).toBe('schemaform-field-foo')
  })

  it('registerBuiltinFieldRenderers wires the 5 scalar controls + artifact-ref + widget', () => {
    registerBuiltinFieldRenderers()
    for (const type of ['number', 'enum', 'boolean', 'string', 'array', 'artifact-ref', 'widget']) {
      expect(typeof getFieldRenderer(type)).toBe('function')
      expect(resolveFieldRenderer(type)).not.toBe(UnknownFieldFallback)
    }
    // and an unregistered type still falls back (the built-ins don't shadow the fallback).
    expect(resolveFieldRenderer('not-a-real-type')).toBe(UnknownFieldFallback)
  })
})
