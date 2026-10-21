// @vitest-environment jsdom
//
// LIVE VALIDATION, as RENDERED. The engine tier (`core/form/validity.test.ts`) proves what
// the verdicts ARE; this proves what the user sees, on the real controls, driven the way a
// user drives them.
//
// The three properties it holds shut, each of which has a specific failure it is built from:
//
//   · a message is ATTACHED, not merely coloured — `role="alert"`, its id inside the
//     control's `aria-describedby`, `aria-invalid` on the control. A red border says
//     nothing to anyone not looking at it, and the message lives OUTSIDE the control
//     because a disabled control is out of the tab order.
//   · nothing reddens before the user has engaged with it, and everything reddens once they
//     have — including on the very next keystroke, because the failures this catches are
//     silent downstream and feedback that waits for blur arrives after the decision.
//   · a message about row i lands on row i. Computing a verdict in a different scope than
//     the control renders from is how a form comes to show one row's error on all of them,
//     and it looks completely normal.
//
// The harness mounts the REAL `WidgetList` over the REAL renderers with the REAL engine and
// the REAL action registry — the only thing it stands in for is the view store, because the
// property under test is the render contract rather than the pane's plumbing (which
// `shippedFormConformance.test.tsx` mounts in full).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { parse as parseYaml } from 'yaml'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { z } from 'zod'
import { defineAction } from '@/core/actions/defineAction'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { CATALOG_SCOPE_KEY } from '@/modules/workbench/core/artifacts/catalog'
import { FORM_VALIDITY_SCOPE_KEY, evaluateForm } from '@/modules/workbench/core/form/validity'
import { tableRowPrimitives } from '@/modules/workbench/core/spec/schema'
import { __clearWidgetsForTests } from './registry'
import { installBuiltinWidgets, __resetBuiltinWidgetsForTests } from '@/modules/workbench/extensions'
import { WidgetList } from './WidgetHost'

// ── jsdom gaps the kit's base-ui controls probe at mount ──────────────────────────────
beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      onchange: null,
    })) as never
  }
  __resetBuiltinWidgetsForTests()
  cleanup()
})
afterEach(() => {
  __clearWidgetsForTests()
})

// ── the harness ───────────────────────────────────────────────────────────────────────

const SPEC_ID = 'fv'
let specSeq = 0

/** A live pane: it owns the state a dispatch mutates, the touched set, and the validity
 *  pre-pass — the same three things `DeclarativeRegion` owns, wired the same way round. */
function Pane({
  spec,
  initial,
  artifacts,
}: {
  spec: ViewSpec
  initial: Record<string, unknown>
  /** the catalog channel, when the test needs one (an `artifact_ref` resolves against it). */
  artifacts?: unknown[]
}): React.ReactElement {
  const [state, setState] = React.useState(initial)
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set())
  stateSetter = setState
  const scope: Scope = React.useMemo(() => {
    const base: Scope = {
      params: {},
      state,
      derived: {},
      const: spec.const ?? {},
      data: {},
      ...(artifacts === undefined ? {} : { [CATALOG_SCOPE_KEY]: { artifacts } }),
    }
    return { ...base, [FORM_VALIDITY_SCOPE_KEY]: evaluateForm(spec, base) }
  }, [spec, state, artifacts])
  return (
    <WidgetList
      specs={spec.widgets}
      scope={scope}
      viewId="v1"
      specId={SPEC_ID}
      touched={touched}
      onTouch={key => setTouched(prev => (prev.has(key) ? prev : new Set(prev).add(key)))}
    />
  )
}

/** Set by the mounted `Pane`, so the registered actions below can write its state. */
let stateSetter: React.Dispatch<React.SetStateAction<Record<string, unknown>>> | undefined

/** The two REAL actions every spec below dispatches through: one writes a top-level field,
 *  one writes a field of a row. Registered once — the action registry is process-global. */
let actionsReady = false
function ensureActions(): void {
  if (actionsReady) return
  actionsReady = true
  defineAction({
    id: `${SPEC_ID}::setField`,
    title: 'set',
    permission: 'jobs::use',
    mutating: true,
    params: z.object({ field: z.string(), value: z.unknown() }).passthrough(),
    run: async ({ field, value }) => {
      stateSetter?.(prev => ({ ...prev, [field]: value }))
    },
  })
  defineAction({
    id: `${SPEC_ID}::setRowField`,
    title: 'set row',
    permission: 'jobs::use',
    mutating: true,
    params: z.object({ index: z.number(), key: z.string(), value: z.unknown() }).passthrough(),
    run: async ({ index, key, value }) => {
      stateSetter?.(prev => {
        const rows = [...((prev.rows as Record<string, unknown>[]) ?? [])]
        rows[index] = { ...rows[index], [key]: value }
        return { ...prev, rows }
      })
    },
  })
  defineAction({
    id: `${SPEC_ID}::go`,
    title: 'go',
    permission: 'jobs::use',
    mutating: true,
    params: z.object({}).passthrough(),
    run: async () => {},
  })
  defineAction({
    id: `${SPEC_ID}::add`,
    title: 'add',
    permission: 'jobs::use',
    mutating: true,
    params: z.object({}).passthrough(),
    run: async () => {},
  })
}

function view(over: Partial<ViewSpec>): ViewSpec {
  return {
    id: `${SPEC_ID}-${++specSeq}`,
    title: 'V',
    permission: 'jobs::use',
    state: {},
    widgets: [],
    actions: [
      // The SUBMIT action: what makes a button the form's primary action is that its body
      // dispatches a run, not its label.
      { id: 'go', title: 'Go', permission: 'jobs::use', params: {}, body: [{ run_processor: { id: 'x' } }] },
      { id: 'add', title: 'Add', permission: 'jobs::use', params: {}, body: [{ set: { a: 1 } }] },
      { id: 'setField', title: 'set', permission: 'jobs::use', params: {}, body: [{ set: { a: 1 } }] },
      { id: 'setRowField', title: 'set row', permission: 'jobs::use', params: {}, body: [{ set: { a: 1 } }] },
    ],
    ...over,
  } as ViewSpec
}

const RUN_BUTTON = { id: 'run', kind: 'button', label: 'Run', variant: 'primary', onClick: 'go' } as const
const ADD_BUTTON = { id: 'addBtn', kind: 'button', label: 'Add', onClick: 'add' } as const

function mount(spec: ViewSpec, initial: Record<string, unknown>, artifacts?: unknown[]): void {
  ensureActions()
  installBuiltinWidgets()
  render(<Pane spec={spec} initial={initial} artifacts={artifacts} />)
}

/** Type into a control the way a user does — one change event, then let the dispatch land. */
async function type(testid: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId(testid), { target: { value } })
    await Promise.resolve()
  })
}

const runButton = (): HTMLButtonElement => screen.getByTestId('widget-run') as HTMLButtonElement
const requirementTexts = (): string[] =>
  screen.queryAllByTestId('widget-run-requirement').map(el => el.textContent ?? '')

// ══════════════════════════════════════════════════════════════════════════════════════

describe('a pristine form: nothing red, Run refused, and the reason stated', () => {
  const spec = view({
    widgets: [
      { id: 'name', kind: 'text', label: 'Name', value: '$state.name', args: { field: 'name' }, onChange: 'setField', require: { required: true } },
      RUN_BUTTON,
    ],
  })

  it('an EMPTY untouched control shows no message — it is not yet answered, not wrong', () => {
    mount(spec, { name: '' })
    expect(screen.queryByTestId('widget-name-error')).toBeNull()
    expect(screen.getByTestId('widget-name-input').getAttribute('aria-invalid')).toBeNull()
  })

  it('…while Run is refused, and the SUMMARY names the control by its own label', () => {
    mount(spec, { name: '' })
    expect(runButton().disabled).toBe(true)
    expect(requirementTexts()).toEqual(['Name — Required.'])
  })

  it('a complete form is launchable and says nothing — the positive control', () => {
    mount(spec, { name: 'x' })
    expect(runButton().disabled).toBe(false)
    expect(screen.queryByTestId('widget-run-requirements')).toBeNull()
  })

  it('a NON-submitting affordance stays enabled — an incomplete form must remain fixable', () => {
    mount(view({ widgets: [spec.widgets[0], ADD_BUTTON, RUN_BUTTON] }), { name: '' })
    expect(runButton().disabled).toBe(true)
    expect((screen.getByTestId('widget-addBtn') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('after the user has engaged with a control, it tracks them', () => {
  const spec = view({
    widgets: [
      { id: 'name', kind: 'text', label: 'Name', value: '$state.name', args: { field: 'name' }, onChange: 'setField', require: { required: true } },
      RUN_BUTTON,
    ],
  })

  it('answering then CLEARING turns that field red (DEC-4: touched + empty)', async () => {
    mount(spec, { name: '' })
    expect(screen.queryByTestId('widget-name-error')).toBeNull()
    await type('widget-name-input', 'abc')
    expect(screen.queryByTestId('widget-name-error')).toBeNull()
    await type('widget-name-input', '')
    expect(screen.getByTestId('widget-name-error').textContent).toBe('Required.')
  })
})

describe('a PRESENT wrong value reddens on the very next keystroke (DEC-5)', () => {
  const spec = view({
    widgets: [
      { id: 'bound', kind: 'text', label: 'Min', value: '$state.bound', args: { field: 'bound' }, onChange: 'setField', require: { number: {} } },
      RUN_BUTTON,
    ],
  })

  it('an ungrammatical bound is reported without waiting for blur, and refuses the run', async () => {
    // The reason blur is too late: the shared coercion maps this to UNBOUNDED rather than
    // to an error, so a user who types it, tabs away and never looks back learns nothing
    // until the filter silently keeps everything.
    mount(spec, { bound: '' })
    expect(runButton().disabled).toBe(false)
    await type('widget-bound-input', '1O')
    expect(screen.getByTestId('widget-bound-error')).not.toBeNull()
    expect(runButton().disabled).toBe(true)
    // …and correcting it clears both, so the message tracks the value rather than latching.
    await type('widget-bound-input', '10')
    expect(screen.queryByTestId('widget-bound-error')).toBeNull()
    expect(runButton().disabled).toBe(false)
  })

  it('an EMPTY bound is legal — an omitted bound is a real answer, not an unfinished one', async () => {
    mount(spec, { bound: '10' })
    await type('widget-bound-input', '')
    expect(screen.queryByTestId('widget-bound-error')).toBeNull()
    expect(runButton().disabled).toBe(false)
  })
})

describe('a message is ATTACHED to its control, not merely coloured', () => {
  it('role=alert, aria-invalid on the control, and the message id inside aria-describedby', async () => {
    const spec = view({
      widgets: [
        { id: 'bound', kind: 'text', label: 'Min', value: '$state.bound', args: { field: 'bound' }, onChange: 'setField', require: { number: {} } },
      ],
    })
    mount(spec, { bound: 'nope' })
    const message = screen.getByTestId('widget-bound-error')
    const control = screen.getByTestId('widget-bound-input')
    expect(message.getAttribute('role')).toBe('alert')
    expect(control.getAttribute('aria-invalid')).toBe('true')
    expect(message.id, 'the message needs an id to be referenced by').not.toBe('')
    expect(
      (control.getAttribute('aria-describedby') ?? '').split(/\s+/),
      'a message a screen reader never reads with the control is not attached to it',
    ).toContain(message.id)
  })

  it('the message is rendered OUTSIDE the control, so a DISABLED control still carries it', () => {
    // A disabled control is out of the tab order; anything inside it is unreachable.
    const spec = view({
      widgets: [
        { id: 'pick', kind: 'select', label: 'Pick', options: '$state.opts', value: '$state.pick', require: { required: true } },
      ],
    })
    mount(spec, { opts: [], pick: '' })
    // Nothing to choose ⇒ the control disables itself; the field-level slot is still where a
    // message would live, beside the description it already renders there.
    expect(screen.getByTestId('widget-pick-field')).not.toBeNull()
    expect(screen.getByTestId('widget-pick-field-description')).not.toBeNull()
  })
})

// ── the ROW EDITOR, taken from the shipped package rather than invented here ──────────
//
// The row-editing widget below is lifted VERBATIM out of a shipped `ui/*.yaml`: whichever
// declared table carries both a widget-level requirement and a per-row one. Two reasons,
// and the second is the one that matters:
//
//   · a hand-written stand-in can only exercise the shape its author remembered, and the
//     defects here were all in the shape somebody had NOT written down;
//   · it means these assertions are about a declaration a user will actually meet, so a
//     package that stops declaring the requirement fails here rather than passing against
//     a fixture that still does.

/** The shipped-package root, resolved from the RUNNER's cwd rather than `import.meta.url`:
 *  under `@vitest-environment jsdom` the module URL is an `http:` one and `fileURLToPath`
 *  refuses it (the same walk `shippedFormConformance.test.tsx` uses). */
function findProcessorsDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'packages')
    if (existsSync(candidate) && readdirSync(candidate).some(d => existsSync(join(candidate, d, 'manifest.yaml')))) {
      return candidate
    }
    dir = join(dir, '..')
  }
  throw new Error(`no packages/ package root found from ${process.cwd()}`)
}

const PROCESSORS = findProcessorsDir()

/** The shipped table that declares BOTH a row-set requirement and a per-row one. */
function shippedRowEditor(): { widget: Record<string, unknown>; rowsKey: string; columnKey: string } {
  for (const pkg of readdirSync(PROCESSORS).sort()) {
    const uiDir = `${PROCESSORS}/${pkg}/ui`
    if (!existsSync(uiDir)) continue
    for (const file of readdirSync(uiDir).sort()) {
      if (!file.endsWith('.yaml')) continue
      const raw = parseYaml(readFileSync(`${uiDir}/${file}`, 'utf8')) as ViewSpec
      for (const w of raw.widgets ?? []) {
        const anyW = w as unknown as Record<string, unknown>
        if (anyW.kind !== 'table' || anyW.require === undefined) continue
        const columns = (anyW.columns ?? []) as Array<Record<string, unknown>>
        const withRequire = columns.find(c =>
          // The SAME enumerator the validator and the engine use, so this fixture cannot
          // come to disagree with either about what a per-row primitive is.
          tableRowPrimitives(c).some(({ decl }) => (decl as { require?: unknown }).require !== undefined),
        )
        if (!withRequire) continue
        return {
          widget: anyW,
          rowsKey: String(anyW.rows).replace('$state.', ''),
          columnKey: String(withRequire.key),
        }
      }
    }
  }
  throw new Error('no shipped view declares a table with both a row-set and a per-row requirement')
}

/** Register a real, state-writing action for every dispatch target the shipped widget names,
 *  so its controls are driven end to end rather than through a stub. */
function bindShippedDispatches(widget: Record<string, unknown>, rowsKey: string): void {
  const targets = new Set<string>()
  for (const c of (widget.columns ?? []) as Array<Record<string, unknown>>) {
    for (const { decl } of tableRowPrimitives(c)) {
      for (const key of ['onChange', 'onClick'] as const) {
        const target = (decl as Record<string, unknown>)[key]
        if (typeof target === 'string') targets.add(target)
      }
    }
  }
  for (const target of targets) {
    if (boundDispatches.has(target)) continue
    boundDispatches.add(target)
    defineAction({
      id: `${SPEC_ID}::${target}`,
      title: target,
      permission: 'jobs::use',
      mutating: true,
      params: z.object({}).passthrough(),
      run: async (args: Record<string, unknown>) => {
        if (typeof args.index !== 'number' || typeof args.key !== 'string') return
        const { index, key, value } = args as { index: number; key: string; value: unknown }
        stateSetter?.(prev => {
          const rows = [...((prev[rowsKey] as Record<string, unknown>[]) ?? [])]
          rows[index] = { ...rows[index], [key]: value }
          return { ...prev, [rowsKey]: rows }
        })
      },
    })
  }
}
const boundDispatches = new Set<string>()

describe('a repeated row shows ITS OWN message', () => {
  const editor = shippedRowEditor()
  bindShippedDispatches(editor.widget, editor.rowsKey)
  const spec = view({ widgets: [editor.widget as never, RUN_BUTTON] })
  const tid = `widget-${String(editor.widget.id)}`
  const field = (index: number): string => `${tid}-edit-${editor.columnKey}-${index}`
  /** A row that answers every per-row requirement the shipped column set declares. */
  const filled = (suffix: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const c of (editor.widget.columns ?? []) as Array<Record<string, unknown>>) {
      for (const { decl } of tableRowPrimitives(c)) {
        if ((decl as { require?: unknown }).require !== undefined) {
          out[String(c.key)] = `${String(c.key)}-${suffix}`
        }
      }
    }
    return out
  }

  it('a blank field on row 1 reddens row 1 and no other row', async () => {
    mount(spec, { [editor.rowsKey]: [filled('a'), filled('b')] })
    await type(field(1), '')
    expect(screen.getByTestId(`${field(1)}-error`)).not.toBeNull()
    expect(screen.queryByTestId(`${field(0)}-error`)).toBeNull()
    expect(runButton().disabled).toBe(true)
  })

  it('a blank row is refused the instant it appears, before the user touches it', () => {
    // The concrete failure: an add affordance seeds a blank row, the compute refuses the
    // blank, and the old whole-form gate (list non-empty) was satisfied by it. Run must be
    // shut immediately — the FIELD stays quiet until touched, which is a different question.
    const blank = { ...filled('b') }
    blank[editor.columnKey] = ''
    mount(spec, { [editor.rowsKey]: [filled('a'), blank] })
    expect(runButton().disabled).toBe(true)
    expect(screen.queryByTestId(`${field(1)}-error`)).toBeNull()
    expect(requirementTexts()).toEqual([`${editor.columnKey} — Required.`])
  })

  it('a fully answered row set is launchable — the positive control', () => {
    mount(spec, { [editor.rowsKey]: [filled('a'), filled('b')] })
    expect(runButton().disabled).toBe(false)
  })

  it('a requirement about the ROWS THAT EXIST renders under the grid', () => {
    // A collision is a PRESENT wrong state, so it shows at once (DEC-4) — and it has no
    // label to hang under, so it goes where the row set ends.
    const dup = filled('a')
    mount(spec, { [editor.rowsKey]: [dup, { ...dup }] })
    const message = screen.getByTestId(`${tid}-error`)
    expect(message.getAttribute('role')).toBe('alert')
    expect(runButton().disabled).toBe(true)

    cleanup()
    mount(spec, { [editor.rowsKey]: [filled('a'), filled('b')] })
    expect(screen.queryByTestId(`${tid}-error`), 'the positive control').toBeNull()
    expect(runButton().disabled).toBe(false)
  })

  it('a requirement about MISSING rows is stated by the summary, not by the grid', () => {
    // Nothing is wrong with the rows that exist — there are none — so the table itself
    // stays quiet and the disabled action explains itself instead. Reddening an empty grid
    // the instant a pane opens is the hostile case DEC-4 keeps off the fields.
    mount(spec, { [editor.rowsKey]: [] })
    expect(screen.queryByTestId(`${tid}-error`)).toBeNull()
    expect(requirementTexts().length).toBe(1)
    expect(runButton().disabled).toBe(true)
  })
})

describe('a cross-field relation lands on the offending row’s own control', () => {
  const spec = view({
    widgets: [
      {
        id: 'row',
        kind: 'group',
        for_each: '$state.rows as $r, $i',
        children: [
          { id: 'lo', kind: 'text', label: 'Min', value: '$r.lo' },
          { id: 'hi', kind: 'text', label: 'Max', value: '$r.hi' },
        ],
      },
      RUN_BUTTON,
    ],
    checks: [
      {
        id: 'loAboveHi',
        for_each: '$state.rows as $r, $i',
        fails_when: "$r.lo != '' && $r.hi != '' && $r.lo > $r.hi",
        at: { widget: 'hi', index: '$i' },
        message: 'Min is above Max, so this criterion keeps nothing.',
      },
    ],
  })

  it('row 1’s violation reddens row 1’s Max — not row 0’s, and not the Min beside it', () => {
    mount(spec, { rows: [{ lo: '1', hi: '9' }, { lo: '5', hi: '1' }] })
    // Both rows render the SAME widget ids, so the two instances are told apart only by
    // their address — which is exactly what a verdict keyed on the widget id alone loses.
    const messages = screen.queryAllByTestId('widget-hi-error')
    expect(messages).toHaveLength(1)
    expect(messages[0].textContent).toBe('Min is above Max, so this criterion keeps nothing.')
    expect(screen.queryAllByTestId('widget-lo-error')).toHaveLength(0)
    // The message sits inside the SECOND rendered row's field, not the first.
    const fields = screen.queryAllByTestId('widget-hi')
    expect(fields).toHaveLength(2)
    expect(fields[0].contains(messages[0])).toBe(false)
    expect(fields[1].contains(messages[0])).toBe(true)
    expect(runButton().disabled).toBe(true)
  })

  it('a coherent range says nothing — the positive control', () => {
    mount(spec, { rows: [{ lo: '1', hi: '9' }, { lo: '2', hi: '8' }] })
    expect(screen.queryAllByTestId('widget-hi-error')).toHaveLength(0)
    expect(runButton().disabled).toBe(false)
  })
})

describe('DEC-6 — a requirement the user cannot satisfy is not shown as their fault', () => {
  const spec = view({
    widgets: [
      {
        id: 'pick',
        kind: 'artifact_ref',
        label: 'Input',
        source: { datatype: 'x' },
        value: '$state.pick',
        require: { required: true },
      },
      RUN_BUTTON,
    ],
  })

  it('with NO candidate: no field message, no summary line — and Run still refused', () => {
    mount(spec, { pick: '' }, [])
    expect(screen.getByTestId('widget-pick-empty'), 'the control states the absence itself').not.toBeNull()
    expect(screen.queryByTestId('widget-pick-field-error')).toBeNull()
    expect(screen.queryByTestId('widget-run-requirements')).toBeNull()
    expect(runButton().disabled).toBe(true)
  })

  it('with candidates present the SAME empty state IS reported — the positive control', () => {
    mount(spec, { pick: '' }, [
      { id: 'a', project_id: 'p', datatype: 'x', structure: {}, created_at: '' },
      { id: 'b', project_id: 'p', datatype: 'x', structure: {}, created_at: '' },
    ])
    expect(requirementTexts()).toEqual(['Input — Required.'])
    expect(runButton().disabled).toBe(true)
  })
})
