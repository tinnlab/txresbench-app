// @vitest-environment jsdom
//
// THE FLAT FORM IS NOW THE ONLY FORM — SO ITS ONE BEHAVIOUR HAS TO BE ASSERTED.
//
// `SchemaForm` had exactly one component test, `steppedRefusal.test.tsx`, and every line of it
// was about the WIZARD (Next/Back, the last-step Run, the three causes behind one disabled
// boolean). That wizard was deleted as unreachable and the test went with it, which left the
// surviving renderer — the flat field list — with no mounted coverage at all.
//
// What survived the deletion is small and load-bearing: render the declared fields IN ORDER,
// and render nothing for a field whose `when` is unmet. The second half is the interesting one,
// because it is half of a PAIR: `pruneHiddenParams` strips a hidden field's value on submit
// (TEST-408, `core/datatypes/when.test.ts`) on the assumption that the control was never
// on screen for the user to set. If this component rendered a hidden field anyway, a user would
// fill in a control whose value is silently discarded at Run — and the unit test would still
// pass, because it never mounts anything. A mutation removing the `isFieldVisible` guard here
// survived the entire suite before this file existed.
//
// Assertions read the RENDERED DOM, not props.

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { identityLattice } from '@/modules/workbench/core/datatypes/lattice'
import type { ParamsSchema } from '@/modules/workbench/core'

vi.mock('@/modules/workbench/core/shell/WorkbenchContext', () => ({
  useWorkbench: () => ({ producedTypeIds: [], lattice: identityLattice }),
}))

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  globalThis.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false
    },
  })) as never
  ;(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

afterEach(cleanup)

const { SchemaForm } = await import('./SchemaForm')

/** `mode` is always on screen; `tuning` only in advanced mode. */
const SCHEMA: ParamsSchema = {
  fields: [
    { id: 'mode', type: 'enum', title: 'Mode', options: ['basic', 'advanced'] },
    { id: 'tuning', type: 'number', title: 'Tuning knob', when: { field: 'mode', eq: 'advanced' } },
    { id: 'note', type: 'string', title: 'Note' },
  ],
}

const mount = (value: Record<string, unknown>): void => {
  render(<SchemaForm params={SCHEMA} value={value} onChange={() => {}} data-testid="sf" />)
}

/** The visible field TITLES, in the order they appear in the DOM. */
const shownTitles = (): string[] =>
  [...document.querySelectorAll('label, [data-slot="label"]')]
    .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)

describe('the flat SchemaForm', () => {
  it('renders every declared field, in declaration order', () => {
    mount({ mode: 'advanced' })
    const titles = shownTitles()
    expect(titles).toContain('Mode')
    expect(titles).toContain('Tuning knob')
    expect(titles).toContain('Note')
    expect(titles.indexOf('Mode')).toBeLessThan(titles.indexOf('Tuning knob'))
    expect(titles.indexOf('Tuning knob')).toBeLessThan(titles.indexOf('Note'))
  })

  it('renders NOTHING for a field whose `when` is unmet — the control a run would discard', () => {
    mount({ mode: 'basic', tuning: 99 })
    const titles = shownTitles()
    expect(titles).toContain('Mode')
    expect(titles).toContain('Note')
    expect(
      titles,
      'a hidden field is pruned from the submitted params, so putting it on screen invites a ' +
        'user to set a value that is silently thrown away',
    ).not.toContain('Tuning knob')
  })

  it('renders no submit of its own — Run belongs to the host', () => {
    mount({ mode: 'advanced' })
    expect(document.querySelectorAll('button[type="submit"]').length).toBe(0)
    expect(document.querySelector('[data-testid="schemaform-step-submit"]')).toBe(null)
    expect(document.querySelector('[data-testid="schemaform-step-next"]')).toBe(null)
  })
})
