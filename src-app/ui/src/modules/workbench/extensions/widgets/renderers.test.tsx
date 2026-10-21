// @vitest-environment jsdom
//
// TEST-30 (ITEM-22) — a declared options binding keeps its GROUP STRUCTURE.
//
// kit's `Select` has rendered headed runs all along (`SelectOptionGroup`), and filters them
// honestly: `filterRuns` drops a run whose every option went, heading and all, and keeps a whole
// run whose HEADING matched. What was missing was any way for a DECLARATIVE options binding to
// say a heading exists — `toOptions` normalized every entry to `{value,label,description}` and
// dropped the grouping. So the `── Groups ── / ── Values ──` split had exactly two possible
// spellings: this one, or two adjacent `select` widgets, which is two states and an unanswerable
// "which one is in force".
//
// Three propositions, and the third is the one that makes the change ADDITIVE rather than a
// rewrite of the hottest file in the repo: an UNGROUPED list must render exactly as it did.

import * as React from 'react'
import { describe, it, expect, afterEach, beforeAll, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { z } from 'zod'
import { defineAction } from '@/core/actions/defineAction'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { installWidgets, __resetInstallWidgetsForTests } from './installWidgets'
import { WidgetList } from '@/modules/workbench/core/render/WidgetHost'
import {
  pickerGroupHeadings,
  pickerOptionNodes,
  pickerOptions,
  typeInPicker,
} from '@/modules/workbench/core/__testutil__/pickerDriver'
import type { Scope } from '@/modules/workbench/core/runtime/expr'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
  else if (typeof globalThis.CSS.escape !== 'function') {
    ;(globalThis.CSS as { escape: (v: string) => string }).escape = (v: string) => v
  }
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = (
      globalThis as { PointerEvent?: unknown }
    ).PointerEvent
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false
      },
      onchange: null,
    })) as never
  }
  Element.prototype.scrollIntoView ??= function scrollIntoView(): void {}
})

beforeEach(() => {
  cleanup()
  __resetInstallWidgetsForTests()
  installWidgets()
})
afterEach(cleanup)

// The fixture is deliberately vocabulary-free: the renderer never reads a heading or an option
// name for meaning, so naming one after a domain concept would assert something core does not do.
const GROUPED = [
  {
    label: 'First run',
    options: [
      { value: 'a1', label: 'alpha one', description: '8 members' },
      { value: 'a2', label: 'alpha two' },
    ],
  },
  { label: 'Second run', options: [{ value: 'b1', label: 'beta one' }] },
]

const FLAT = [
  { value: 'a1', label: 'alpha one', description: '8 members' },
  { value: 'a2', label: 'alpha two' },
  { value: 'b1', label: 'beta one' },
]

const spec = {
  id: 'pick',
  kind: 'select',
  label: 'Pick',
  options: '$const.opts',
  value: '$state.pick',
} as unknown as WidgetSpec

function mount(opts: unknown, state: Record<string, unknown> = {}): void {
  const scope: Scope = {
    params: {},
    state: { pick: null, ...state },
    derived: {},
    const: { opts },
    data: {},
  }
  render(<WidgetList specs={[spec]} scope={scope} viewId="v" specId="t/spec" />)
}

const control = (): HTMLElement => screen.getByTestId('widget-pick')

describe('toOptions carries GROUP structure through to the kit (ITEM-22)', () => {
  it('a declared group renders its HEADING, over its own options', async () => {
    mount(GROUPED)
    expect(await pickerGroupHeadings(control())).toEqual(['First run', 'Second run'])
    // Every option still reaches the list — a heading is added, nothing is filtered by it.
    expect(await pickerOptions(control())).toEqual(['a1', 'a2', 'b1'])
  })

  it('`description` still rides through, inside a group', async () => {
    // The kind qualifier and the level counts the design wants on each row are `description`,
    // which already worked flat. Grouping must not have been bought by dropping it.
    mount(GROUPED)
    const rows = await pickerOptionNodes(control())
    expect(rows[0].textContent).toBe('alpha one8 members')
    expect(rows[0].querySelector('[data-slot="option-lines"]')).not.toBeNull()
  })

  it('an UNGROUPED options list renders byte-identically to before — no heading at all', async () => {
    mount(FLAT)
    expect(await pickerGroupHeadings(control())).toEqual([])
    expect(await pickerOptions(control())).toEqual(['a1', 'a2', 'b1'])
    const rows = await pickerOptionNodes(control())
    expect(rows.map(r => r.textContent)).toEqual(['alpha one8 members', 'alpha two', 'beta one'])
  })

  it('SEARCH keeps the headings honest — a run with no hits is dropped heading and all', async () => {
    // This is kit's `filterRuns`, and it is the property ITEM-55 rides on: once the structure
    // SURVIVES, "groups survive search" is free rather than a second thing to build. Asserted
    // here because "free" is a claim about behaviour, not about code.
    // The search affordance appears only past kit's own threshold, so the fixture has to be big
    // enough to cross it — a smaller one would exercise the filter not at all and still pass.
    const big = [
      { label: 'First run', options: Array.from({ length: 10 }, (_, i) => ({ value: `a${i}`, label: `alpha ${i}` })) },
      { label: 'Second run', options: Array.from({ length: 10 }, (_, i) => ({ value: `b${i}`, label: `beta ${i}` })) },
    ]
    mount(big)
    await typeInPicker(control(), 'beta')
    expect(await pickerGroupHeadings(control())).toEqual(['Second run'])
    expect((await pickerOptions(control())).every(v => v.startsWith('b'))).toBe(true)
  })

  it('a group whose every option is gated OUT is dropped, heading and all', async () => {
    // The same rule one layer earlier, for `when`. A heading standing over nothing claims a
    // group has members it does not — which inverts what the heading was added to say.
    mount([
      { label: 'Gone', options: [{ value: 'x', label: 'x', when: 'false' }] },
      { label: 'Kept', options: [{ value: 'y', label: 'y' }] },
    ])
    expect(await pickerGroupHeadings(control())).toEqual(['Kept'])
    expect(await pickerOptions(control())).toEqual(['y'])
  })

  it('an option list MIXING bare options and groups keeps both, in declaration order', async () => {
    // Bare entries collapse into one anonymous run exactly as kit's own `optionRuns` does, so a
    // binding that grows a group later does not have to re-shape the entries beside it.
    mount([{ value: 'lead', label: 'lead' }, ...GROUPED])
    expect(await pickerGroupHeadings(control())).toEqual(['First run', 'Second run'])
    expect(await pickerOptions(control())).toEqual(['lead', 'a1', 'a2', 'b1'])
  })

  it('a BOUND value the declared groups do not contain still renders, and joins no group', async () => {
    // A retired option must not vanish from the screen while the run still receives it — the
    // existing prepend rule. It leads as an anonymous run rather than being filed under a
    // heading, because it is not a member of any group the data declared.
    mount(GROUPED, { pick: 'retired-id' })
    expect(await pickerOptions(control())).toEqual(['retired-id', 'a1', 'a2', 'b1'])
    expect(await pickerGroupHeadings(control())).toEqual(['First run', 'Second run'])
  })
})

// ── TEST-39 (ITEM-29c) — a refusal that states its CAUSE ─────────────────────────────
//
// `unavailableReason` shipped as a kit `Button` prop and had no declarative spelling: a view
// could only say `disabledWhen`, which carries no reason string. So a declaratively refused
// control was indistinguishable from a broken one — and ITEM-39's per-row `▶` ("4,102 levels is
// too many to colour by") was not expressible at all.
//
// The reason IS the gate. There is no second boolean to keep in step with it, so a control
// cannot be refused without saying why — which is the property being asserted, in both
// directions.
describe('a declarative control states WHY it refuses (ITEM-29c)', () => {
  const buttonSpec = (over: Record<string, unknown> = {}): WidgetSpec =>
    ({ id: 'go', kind: 'button', label: 'Plot', onClick: 'act', ...over }) as unknown as WidgetSpec

  function mountButton(over: Record<string, unknown>, state: Record<string, unknown> = {}): void {
    const scope: Scope = { params: {}, state, derived: {}, const: {}, data: {} }
    render(<WidgetList specs={[buttonSpec(over)]} scope={scope} viewId="v" specId="t/spec" />)
  }

  it('the declared reason reaches the user, and the control is aria-disabled — not natively', () => {
    // Natively disabled would drop the tooltip, which is the string that is the whole point.
    mountButton({ unavailableReason: '$state.why' }, { why: '4,102 levels — too many to colour' })
    const btn = screen.getByTestId('widget-go')
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    expect(btn.hasAttribute('disabled')).toBe(false)
    // Reachable without hovering: kit hangs an sr-only node off `aria-describedby`.
    const describedBy = btn.getAttribute('aria-describedby') ?? ''
    const reasonText = describedBy
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent ?? '')
      .join(' ')
    expect(reasonText).toContain('4,102 levels — too many to colour')
  })

  it('the NAME is untouched — the reason says why it refused, the name says which refused', () => {
    mountButton({ unavailableReason: '$state.why' }, { why: 'nope' })
    expect(screen.getByTestId('widget-go').textContent).toContain('Plot')
  })

  it('a refused control does not DISPATCH — with the un-refused case as the positive control', async () => {
    // Driven through the REAL action registry. Without the positive half this would pass just as
    // happily if clicking never dispatched at all, which is the shape of a test that cannot fail.
    const calls: Array<Record<string, unknown>> = []
    const localId = `plot${Date.now()}`
    defineAction({
      id: `t/spec::${localId}`,
      title: localId,
      permission: 'jobs::use',
      mutating: true,
      params: z.object({}).passthrough(),
      run: async (params: Record<string, unknown>) => {
        calls.push(params)
      },
    })

    mountButton({ onClick: localId, unavailableReason: '$state.why' }, { why: 'nope' })
    fireEvent.click(screen.getByTestId('widget-go'))
    await new Promise(r => setTimeout(r, 0))
    expect(calls, 'a refused control dispatches nothing').toHaveLength(0)

    cleanup()
    mountButton({ onClick: localId, unavailableReason: '$state.why' }, { why: null })
    fireEvent.click(screen.getByTestId('widget-go'))
    await waitFor(() => expect(calls, 'the SAME control, unrefused, does dispatch').toHaveLength(1))
  })

  it('a reason resolving to NOTHING is not a refusal — absence and "" both mean ordinary', () => {
    // The negative control. Without it the gate could be "the key is present", which would
    // refuse every control whose reason expression is merely not applicable right now.
    for (const why of [null, '', '   ']) {
      cleanup()
      mountButton({ unavailableReason: '$state.why' }, { why })
      const btn = screen.getByTestId('widget-go')
      expect(btn.getAttribute('aria-disabled'), `why=${JSON.stringify(why)}`).not.toBe('true')
    }
    cleanup()
    mountButton({})
    expect(screen.getByTestId('widget-go').getAttribute('aria-disabled')).not.toBe('true')
  })
})

// ── TEST-41 / ITEM-30 + ITEM-43 — a control NAMES ITS SUBJECT, not its verb ───────────────────
//
// *"The name must name the ROW, not the verb: `aria-label="Plot a column"`, never `"Plot"` —
// forty rows called "Plot" is forty identical accessible names."* A per-row action already
// composed its name from the row; a STANDALONE button had no way to say it at all, because its
// label was rendered verbatim — so the bare-frame ▶ ("Plot <that>", where a projection is a value the user
// just chose) was not expressible.
describe('a button label names its SUBJECT (ITEM-30 / ITEM-43)', () => {
  const labelled = (label: string): WidgetSpec =>
    ({ id: 'go', kind: 'button', label, onClick: 'act' }) as unknown as WidgetSpec

  function mountLabel(label: string, data: Record<string, unknown> = {}): void {
    const scope: Scope = { params: {}, state: {}, derived: {}, const: {}, data }
    render(<WidgetList specs={[labelled(label)]} scope={scope} viewId="v" specId="t/spec" />)
  }

  it('resolves a `{…}` segment against the live scope', () => {
    mountLabel('Plot {$data.frame.coordinate_name}', { frame: { coordinate_name: 'projection one' } })
    expect(screen.getByTestId('widget-go').textContent).toContain('Plot projection one')
  })

  it('leaves a plain label byte-identical — every shipped label is untouched', () => {
    mountLabel('Run')
    expect(screen.getByTestId('widget-go').textContent).toContain('Run')
  })

  it('an unresolved segment reads as nothing, not as the raw expression', () => {
    // Half a name is better than a name with `$data.frame…` in it: the control is still named
    // by its verb, and no internal path is shown to the user.
    mountLabel('Plot {$data.frame.coordinate_name}')
    expect(screen.getByTestId('widget-go').textContent).not.toContain('$data')
  })
})
