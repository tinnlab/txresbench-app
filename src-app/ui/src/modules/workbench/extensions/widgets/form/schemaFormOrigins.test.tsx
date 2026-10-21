// @vitest-environment jsdom
//
// TEST-19 (ITEM-15) — the FALLBACK form shows how a binding was chosen.
//
// ── What this asserts, and what it deliberately does not ────────────────────────────
//
// Not "the form renders an artifact-ref control": that was true before this change and
// proves nothing about it. The property here is the DISTINCTION. The SAME field, holding
// the SAME artifact id, is rendered twice — once listed in `origins` as `auto`, once as
// `user` — and the two renders must differ. If the mark were dropped, or defaulted, or
// keyed off the value instead of off the origin, the two would be identical and this file
// goes red on its first assertion.
//
// The third case is the back-compat leg: a form given NO `origins` prop must render what
// it rendered before the prop existed — no mark, no wrapper, no attribute. An absent
// origin is absent (INV-4); it is not quietly `user`.
//
// Assertions read the RENDERED DOM (and the mark's ACCESSIBLE TEXT, present without any
// hover or focus — R8 does not count a marker a reader has to uncover). The copy comes
// from the shipped `BINDING_ORIGIN_COPY`, never re-typed here: a hand-copied twin passes
// while the user reads something else.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { identityLattice } from '@/modules/workbench/core/datatypes/lattice'
import { createCapabilityBroker } from '@/modules/workbench/core/capabilities/broker'
import type { ParamsSchema } from '@/modules/workbench/core'
import { ORIGIN_AUTO, ORIGIN_USER } from '@/modules/workbench/core/runtime/bindingOrigin'

/** Two candidates, so the picker paints its control rather than its (Router-dependent)
 *  empty state. Neutral datatypes — lattice roots, not domain ids. */
const ROWS = [
  { id: 'art-1', project_id: 'p1', datatype: 'matrix', structure: {}, created_at: '2026-08-01T00:00:00Z' },
  { id: 'art-2', project_id: 'p1', datatype: 'matrix', structure: {}, created_at: '2026-08-01T00:00:00Z' },
]

const broker = createCapabilityBroker()
broker.publish('data', '1.0.0', {
  catalog: async () => ({ project_id: 'p1', axes: [], artifacts: ROWS }),
  artifacts: { query: async () => ROWS },
} as never)

vi.mock('@/modules/workbench/core/shell/WorkbenchContext', () => ({
  useWorkbench: () => ({
    api: { capabilities: broker, ui: { notify: vi.fn() } },
    projectId: 'p1',
    producedTypeIds: [],
    lattice: identityLattice,
  }),
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
const { BINDING_ORIGIN_COPY } = await import('@/modules/workbench/core')

/** ONE artifact-ref field — the shape `fallbackParamsFor` synthesizes for a slot. */
const SCHEMA: ParamsSchema = {
  fields: [{ id: 'frame', type: 'artifact-ref', title: 'frame', accepts: { subtypes_of: 'matrix' }, required: true }],
} as ParamsSchema

/** The SAME value in every case — so nothing below can be passing on the value. */
const VALUE = { frame: 'art-1' }

const mark = (): HTMLElement | null => screen.queryByTestId('schemaform-field-frame-origin-mark')
const wrapper = (): Element | null => document.querySelector('[data-binding-origin]')

describe('TEST-19: the fallback form marks an AUTO-bound artifact-ref (ITEM-15)', () => {
  it('renders the mark, visibly, for a field listed as auto', async () => {
    render(<SchemaForm params={SCHEMA} value={VALUE} onChange={() => {}} origins={{ frame: ORIGIN_AUTO }} />)
    await screen.findByTestId('schemaform-field-frame')

    const badge = mark()
    expect(badge).toBeTruthy()
    // The SHIPPED string, and it is ordinary flow text — not a `title`, not a tooltip.
    expect(badge!.textContent).toContain(BINDING_ORIGIN_COPY.autoBound)
    expect(badge!.getAttribute('title')).toBeNull()
    // …and the fact is readable off the DOM by anything downstream, not only by a human.
    expect(wrapper()?.getAttribute('data-binding-origin')).toBe('auto')
  })

  it('renders NO mark for the SAME field holding the SAME value, listed as user', async () => {
    // THE assertion of this file. The only difference between this render and the one
    // above is the origin, so a mark that survived here would be keyed off something
    // other than how the binding was chosen.
    render(<SchemaForm params={SCHEMA} value={VALUE} onChange={() => {}} origins={{ frame: ORIGIN_USER }} />)
    await screen.findByTestId('schemaform-field-frame')

    expect(mark()).toBeNull()
    expect(wrapper()).toBeNull()
    // NON-VACUITY — the control really is on screen, so "no mark" is not "no render".
    expect(screen.getByTestId('schemaform-field-frame')).toBeTruthy()
  })

  it('a form given NO `origins` renders as it did before the prop existed', async () => {
    render(<SchemaForm params={SCHEMA} value={VALUE} onChange={() => {}} />)
    await screen.findByTestId('schemaform-field-frame')

    expect(mark()).toBeNull()
    expect(wrapper()).toBeNull()
    // Absence is absence: an unknown origin must not be rendered as a reviewed one, and
    // must not be rendered as an unreviewed one either.
    expect(document.body.textContent).not.toContain(BINDING_ORIGIN_COPY.autoBound)
    expect(screen.getByTestId('schemaform-fieldrow-frame')).toBeTruthy()
  })
})
