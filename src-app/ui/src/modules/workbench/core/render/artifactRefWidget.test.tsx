// @vitest-environment jsdom
//
// TEST-16 (ITEM-7, INV-2/INV-4) — the `artifact_ref` control.
//
// The behaviour it replaces threw `found ${options.length}` at LAUNCH whenever the
// candidate count was not exactly 1, and showed the user nothing either way. So the three
// cardinalities are the test: none, one, many — each has to produce a DIFFERENT, legible
// surface, and the one-candidate case has to actually SELECT (a summary that displays a
// value the run does not receive is the same invisible resolution under a new name).
//
// The candidate set comes from the widget's own `source` (INV-2). The catalog is handed in
// on the render scope, exactly as `DeclarativeRegion` supplies it.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react'
import { z } from 'zod'
import { defineAction } from '@/core/actions/defineAction'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { ArtifactRow } from '@/modules/workbench/extensions/data/contract'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { CATALOG_SCOPE_KEY } from '@/modules/workbench/core/artifacts/catalog'
import {
  choosePicker,
  openPicker,
  pickerGroupHeadings,
  pickerOptionNodes,
  pickerOptions,
  pickerSearchInput,
  typeInPicker,
} from '@/modules/workbench/core/__testutil__/pickerDriver'
import { __clearWidgetsForTests, registerWidget } from './registry'
import {
  ArtifactRefRenderer,
  ARTIFACT_REF_COPY,
  ARTIFACT_REF_RADIO_MAX,
  autoBindVerdict,
  expandSelectionArtifacts,
} from './ArtifactRefWidget'
import {
  resolveArtifactRefSource,
  type ArtifactRefCandidate,
} from '@/modules/workbench/core/runtime/axisSource'
import { WidgetList } from './WidgetHost'

// jsdom gaps the kit's base-ui controls probe at mount / on activation.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = (
      globalThis as { PointerEvent?: unknown }
    ).PointerEvent
  }
  // jsdom implements no layout, so it ships no `scrollIntoView`. The `multiple` arm's option
  // list scrolls its active row into view the moment it OPENS — so without this the very act
  // of opening that list throws inside the control and the widget's error boundary replaces
  // it, which reads exactly like "the picker is broken" rather than like a missing DOM stub.
  // (The single arm never needed it, which is why it is only being added now.)
  Element.prototype.scrollIntoView ??= function scrollIntoView(): void {}
})

/** The single picker's trigger. */
const picker = (): HTMLElement => screen.getByTestId('widget-cols-select')

/** What the control DISPLAYS as chosen — the artifact ids its own selected renderings name.
 *  One for the single arm's closed trigger, one per tag for the `multiple` arm. */
const displayedIds = (root: HTMLElement = picker()): string[] =>
  [...root.querySelectorAll('[data-artifact-id]')].map(el => el.getAttribute('data-artifact-id') ?? '')

/** What a user READS off one selected rendering: its artifact name and its dataset, in order. */
const displayedText = (el: Element | null): string => (el?.textContent ?? '').trim()

function row(id: string, over: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id,
    project_id: 'p1',
    datatype: 'demo/column',
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'cols', columns: [{ name: id, kind: 'string' }] },
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds-a',
    ...over,
  }
}

const MATRIX = row('m1', {
  datatype: 'demo/matrix',
  structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: ['rows', 'cols'], shape: [10, 20] },
})

function scopeWith(artifacts: ArtifactRow[], state: Record<string, unknown> = {}): Scope {
  return {
    params: {},
    state,
    derived: {},
    const: {},
    data: {},
    [CATALOG_SCOPE_KEY]: { artifacts },
  }
}

/** Mount ONE `artifact_ref` through the real `WidgetList` → `WidgetHost` → registry path,
 *  so `for_each`/`when`/dispatch are the production ones. */
function mount(spec: WidgetSpec, scope: Scope) {
  registerWidget('artifact_ref', ArtifactRefRenderer)
  return render(<WidgetList specs={[spec]} scope={scope} viewId="v1" specId="s1" />)
}

/** Register the REAL action a widget's `onChange` names (`WidgetHost` namespaces it as
 *  `<specId>::<localId>`) and capture what it is called with. Watching the action itself
 *  — rather than a console line — is what makes "the run receives the shown value"
 *  assertable instead of inferred. */
let actionSeq = 0
function captureAction(): {
  id: string
  calls: Array<Record<string, unknown>>
  /** The CTX each dispatch ran over — where the binding origin rides (it is deliberately not
   *  a declared param, so a package cannot collide with its name). Captured beside the params
   *  so "the run was told how this was chosen" is assertable rather than inferred, exactly as
   *  `calls` makes "the run receives the shown value" assertable. */
  ctxs: Array<Record<string, unknown> | undefined>
} {
  // The action registry is process-global and has no reset seam, so each test mints its
  // own id rather than fighting a duplicate registration.
  const localId = `setRef${++actionSeq}`
  const calls: Array<Record<string, unknown>> = []
  const ctxs: Array<Record<string, unknown> | undefined> = []
  defineAction({
    id: `s1::${localId}`,
    title: localId,
    permission: 'jobs::use',
    mutating: true,
    params: z.object({}).passthrough(),
    run: async (params: Record<string, unknown>, ctx?: unknown) => {
      calls.push(params)
      ctxs.push(ctx as Record<string, unknown> | undefined)
    },
  })
  return { id: localId, calls, ctxs }
}

beforeEach(() => {
  __clearWidgetsForTests()
  cleanup()
})
afterEach(() => {
  __clearWidgetsForTests()
})

describe('artifact_ref — 0 candidates', () => {
  it('renders an EXPLICIT empty state, not a blank or disabled listbox', () => {
    mount({ id: 'cols', kind: 'artifact_ref', label: 'Column names', source: { datatype: 'nothing' } }, scopeWith([]))
    const empty = screen.getByTestId('widget-cols-empty')
    expect(empty.textContent).toContain(ARTIFACT_REF_COPY.emptyTitle)
    // A listbox with nothing in it is the illegible control this replaces.
    expect(screen.queryByTestId('widget-cols-select')).toBeNull()
  })

  it('a DEPENDENT (axis-scoped) source names the control above it, not "import a dataset"', () => {
    // Two different absences with two different next actions. Telling a user to import a
    // dataset when the real blocker is the picker above it sends them somewhere useless.
    mount(
      {
        id: 'cols',
        kind: 'artifact_ref',
        label: 'Column names',
        source: { axis: 'cols', of: '$state.matrix' },
      },
      scopeWith([MATRIX, row('col_name')], {}),
    )
    const field = screen.getByTestId('widget-cols-field')
    expect(field.textContent).toContain(ARTIFACT_REF_COPY.emptyDependent)
    expect(field.textContent).not.toContain(ARTIFACT_REF_COPY.emptyDescription)
  })
})

// TEST-89 (ITEM-29b) — the sole-candidate arm, REWRITTEN.
//
// Two specs in this block used to assert the pre-selection UNCONDITIONALLY, and they were
// right about the shipped behaviour and wrong about the rule: R2/INV-3 says a resolver may
// never take the only candidate merely because it is the only one, and that auto-binding, when
// wanted, is a DECLARED affordance "so the form shows what it bound". Under DEC-15 the
// declaration is opt-IN — absence is OFF.
//
// So they are REWRITTEN rather than joined by a new declaration-gated pair. Adding one beside
// them would have left the suite asserting both propositions at once, and a suite that holds a
// rule and its negation certifies whichever one someone reads first.
// [feedback_tests_that_certify_bugs]
describe('artifact_ref — 1 candidate, auto-bind DECLARED', () => {
  const specFor = (onChange: string): WidgetSpec => ({
    id: 'cols',
    kind: 'artifact_ref',
    label: 'Column names',
    source: { axis: 'cols', of: '$state.matrix', values: 'string' },
    value: '$state.cols',
    auto_bind_sole_candidate: true,
    onChange,
  })
  const spec = specFor('setCols')

  it('renders a read-only SUMMARY and no listbox', () => {
    mount(spec, scopeWith([MATRIX, row('col_name')], { matrix: 'm1', cols: 'col_name' }))
    const summary = screen.getByTestId('widget-cols-summary')
    expect(summary.getAttribute('data-artifact-id')).toBe('col_name')
    // Named by its column name — and by the DATASET that column belongs to. This is the arm
    // where the user never saw a list, so the summary is the only place the run's actual input
    // is ever stated; "col_name" alone answers "which column" and not "whose".
    expect(summary.textContent).toContain('col_name')
    expect(summary.textContent).toContain('ds-a')
    expect(screen.queryByTestId('widget-cols-select')).toBeNull()
    expect(screen.getByTestId('widget-cols-field').textContent).toContain(ARTIFACT_REF_COPY.soleCandidate)
  })

  it('the visible label is ASSOCIATED with the summary (not a dangling htmlFor)', () => {
    mount(spec, scopeWith([MATRIX, row('col_name')], { matrix: 'm1', cols: 'col_name' }))
    const label = screen.getByText('Column names') as HTMLLabelElement
    const summary = screen.getByTestId('widget-cols-summary')
    expect(label.getAttribute('for')).toBe(summary.getAttribute('id'))
  })

  it('PRE-SELECTS it — a summary showing a value the run would not receive is the old bug', async () => {
    // Unchanged in substance, narrowed in scope: WITH the declaration, the sole candidate must
    // still reach the BINDING, or "what is launched is what was shown" holds only visually and
    // the launch resolves invisibly again. What changed is that this is now the DECLARED case
    // rather than the only case.
    const act = captureAction()
    mount(specFor(act.id), scopeWith([MATRIX, row('col_name')], { matrix: 'm1' }))
    await waitFor(() => expect(act.calls).toHaveLength(1))
    expect(act.calls[0]).toMatchObject({ value: 'col_name', view_id: 'v1' })
  })

  it('does NOT re-emit once the binding already holds the sole candidate', async () => {
    // A control that re-emitted every render would keep writing over any later edit, and
    // would churn the store on every unrelated re-render.
    const act = captureAction()
    const s = specFor(act.id)
    const scope = scopeWith([MATRIX, row('col_name')], { matrix: 'm1', cols: 'col_name' })
    const { rerender } = mount(s, scope)
    rerender(<WidgetList specs={[s]} scope={scope} viewId="v1" specId="s1" />)
    await Promise.resolve()
    expect(act.calls).toEqual([])
  })
})

describe('artifact_ref — 2+ candidates', () => {
  const artifacts = [MATRIX, row('col_name'), row('alt_name')]
  const specFor = (onChange: string): WidgetSpec => ({
    id: 'cols',
    kind: 'artifact_ref',
    label: 'Column names',
    source: { axis: 'cols', of: '$state.matrix', values: 'string' },
    value: '$state.cols',
    onChange,
  })
  const spec = specFor('setCols')

  it('renders a real picker whose options ARE the candidates', async () => {
    mount(spec, scopeWith(artifacts, { matrix: 'm1', cols: 'col_name' }))
    expect((await pickerOptions(picker())).sort()).toEqual(['alt_name', 'col_name'])
    // Neither is ranked or preferred (DEC-8) — both are offered, unfiltered.
    expect(displayedIds()).toEqual(['col_name'])
    expect(screen.queryByTestId('widget-cols-summary')).toBeNull()
  })

  it('an UNBOUND picker says so, instead of silently showing the first candidate', () => {
    // The native control this replaces displayed option 0 while the binding held nothing —
    // a value/UI divergence with no change event. The property is unchanged and stated on
    // what the user reads: the control NAMES no artifact, and says what to do instead.
    mount(spec, scopeWith(artifacts, { matrix: 'm1' }))
    expect(displayedIds()).toEqual([])
    expect(picker().textContent).toContain(ARTIFACT_REF_COPY.placeholder)
  })

  it('selecting emits the ARTIFACT ID through the bound action', async () => {
    const act = captureAction()
    mount(specFor(act.id), scopeWith(artifacts, { matrix: 'm1', cols: 'col_name' }))
    await choosePicker(picker(), 'alt_name')
    await waitFor(() => expect(act.calls).toHaveLength(1))
    // The ID, not the label — the run consumes an artifact reference.
    expect(act.calls[0]).toMatchObject({ value: 'alt_name' })
  })
})

describe('artifact_ref reads its OWN source, never the analysis applicability (INV-2)', () => {
  it('two widgets over the same catalog offer DIFFERENT sets when their sources differ', async () => {
    const artifacts = [MATRIX, row('col_name'), row('metric_a', {
      structure: { encoding: 'zarr_v3', kind: 'table', axis: 'cols', columns: [{ name: 'metric_a', kind: 'numeric' }] },
    })]
    const strings = captureAction()
    const numbers = captureAction()
    registerWidget('artifact_ref', ArtifactRefRenderer)
    render(
      <WidgetList
        specs={[
          // Both DECLARE the auto-bind (ITEM-29b): this spec is about which SOURCE resolves
          // which candidate, and the pre-selection is only the observable it reads that
          // through — so the declaration is scaffolding here, not the subject.
          { id: 'strings', kind: 'artifact_ref', auto_bind_sole_candidate: true, source: { axis: 'cols', of: '$state.m', values: 'string' }, onChange: strings.id },
          { id: 'numbers', kind: 'artifact_ref', auto_bind_sole_candidate: true, source: { axis: 'cols', of: '$state.m', values: 'numeric' }, onChange: numbers.id },
        ]}
        scope={scopeWith(artifacts, { m: 'm1' })}
        viewId="v1"
        specId="s1"
      />,
    )
    // Both are sole-candidate cases, and they resolve to DIFFERENT artifacts — the source
    // is what decides, and nothing about the analysis is consulted.
    //
    // Asserted on what each control PRE-SELECTS, not on what its summary prints. The
    // summary now renders the BOUND value (an unlanded pre-selection reads as "Selecting…",
    // never as a resolved artifact the run will not receive), and this scope is a plain
    // literal with no store behind it, so nothing ever lands. Reading the label here would
    // therefore be asserting exactly the show-without-state divergence the widget was
    // changed to make impossible.
    await waitFor(() => {
      expect(strings.calls).toHaveLength(1)
      expect(numbers.calls).toHaveLength(1)
    })
    expect(strings.calls[0].value).toBe('col_name')
    expect(numbers.calls[0].value).toBe('metric_a')
  })
})

// ── grouping by source dataset (artifact-picker-hierarchy) ──────────────────────────────
//
// The data is a tree — a dataset holds artifacts — and the picker used to flatten it into
// strings, naming the dataset only when two labels COLLIDED and only as a label SUFFIX. Both
// halves were wrong: the dataset was invisible in the common case, and in the collision case it
// sat at the end of the string, which is exactly where tail-truncation removes it. So the one
// substring that distinguished two options was the first thing to disappear.
describe('artifact_ref — candidates are grouped by the dataset they came from', () => {
  // The SAME member name on both, from DIFFERENT datasets — the case that used to render two
  // options a user could not tell apart until the collision suffix was appended.
  const named = (id: string, ds: string, dsName: string): ArtifactRow =>
    row(id, {
      structure: { encoding: 'zarr_v3', kind: 'table', axis: 'cols', columns: [{ name: 'col_name', kind: 'string' }] },
      source_dataset_id: ds,
      source_dataset_name: dsName,
    })
  const twoDatasets = [named('a', 'ds1', 'Batch A'), named('b', 'ds2', 'Batch B')]
  // A PROJECT-WIDE source, deliberately — and this is the whole reason grouping exists.
  //
  // An AXIS-scoped source resolves siblings within the anchor's own dataset (`siblingsOnAxis`),
  // so it can only ever offer candidates from ONE dataset and there is nothing to group. The
  // pickers that span datasets are the project-wide ones — "which count matrices?" — which is
  // exactly where two options rendered as identical strings with no way to tell them apart.
  const spec: WidgetSpec = {
    id: 'cols',
    kind: 'artifact_ref',
    label: 'Column names',
    source: { datatype: 'demo/column' },
    value: '$state.cols',
    onChange: 'setCols',
  } as unknown as WidgetSpec

  it('renders one group per dataset, headed by the dataset', async () => {
    mount(spec, scopeWith(twoDatasets, { cols: 'a' }))
    expect(await pickerGroupHeadings(picker())).toEqual(['Batch A', 'Batch B'])
  })

  it('tells identical labels apart WITHOUT a truncatable suffix', async () => {
    // Both artifacts describe identically (`col_name`). Before, they were disambiguated by
    // appending the dataset to each label; now the label is untouched and the GROUP separates
    // them — so what distinguishes them survives a clipped option.
    mount(spec, scopeWith(twoDatasets, { cols: 'a' }))
    const rows = [...(await pickerOptionNodes(picker()))]
    expect(rows).toHaveLength(2)
    for (const o of rows) {
      expect(o.textContent, 'the dataset is a heading, not a suffix on the option').not.toContain('·')
    }
    expect(await pickerGroupHeadings(picker())).toHaveLength(2)
  })

  it('draws the group heading even when every candidate shares ONE dataset', async () => {
    // REWRITTEN (ledger #8 / #16). This asserted that the heading is omitted at one dataset —
    // an assistant's addition the owner rejected twice, and one that contradicted the grouping
    // module's own rule (grouping is applied always, not on collision). The heading is not a
    // discriminator competing with the labels; it is the answer to whose data this is.
    const oneDataset = [
      row('a', { source_dataset_id: 'ds1', source_dataset_name: 'Only' }),
      row('b', { source_dataset_id: 'ds1', source_dataset_name: 'Only' }),
    ]
    mount(spec, scopeWith(oneDataset, { cols: 'a' }))
    expect(await pickerGroupHeadings(picker())).toEqual(['Only'])
    expect((await pickerOptions(picker())).sort()).toEqual(['a', 'b'])
  })

  // ── the CHOSEN artifact says which dataset it is ────────────────────────────────────
  //
  // The reported defect, in the user's words: "if we have multiple expression, when select any,
  // it will show as expression — the important is the expression of WHAT DATASET."
  //
  // Grouping answered that question only while the list was OPEN. The instant a choice was made
  // the list closed and every arm fell back to the bare artifact name, which is the SAME string
  // for both candidates here — so the form displayed `col_name` and there was no way, anywhere
  // on screen, to tell which of the two the run would receive. The three assertions below are
  // the three places an artifact is displayed as chosen.

  it('the CLOSED single picker names the dataset, not just the artifact', async () => {
    mount(spec, scopeWith(twoDatasets, { cols: 'a' }))
    // What a user reads with the list closed.
    expect(displayedIds()).toEqual(['a'])
    expect(displayedText(picker())).toContain('col_name')
    expect(
      displayedText(picker()),
      'the closed control must answer "which col_name?" — the dataset is the only thing that does',
    ).toContain('Batch A')
    expect(displayedText(picker())).not.toContain('Batch B')
  })

  it('choosing the OTHER dataset’s identically-named artifact reads differently', async () => {
    // The property stated as the user experiences it: two artifacts that share a name must not
    // share a DISPLAY. A control that renders only the label passes every other test in this
    // file and fails this one.
    const act = captureAction()
    mount({ ...(spec as object), onChange: act.id } as unknown as WidgetSpec, scopeWith(twoDatasets, { cols: 'a' }))
    const first = displayedText(picker())
    await choosePicker(picker(), 'b')
    await waitFor(() => expect(act.calls).toHaveLength(1))

    // The store is a plain literal here, so re-mount with what the action would have written —
    // this asserts the DISPLAY of the new binding, not that a re-render happened.
    cleanup()
    mount(spec, scopeWith(twoDatasets, { cols: 'b' }))
    const second = displayedText(picker())
    expect(second).toContain('col_name')
    expect(second).toContain('Batch B')
    expect(second, 'two same-named artifacts from different datasets must not read alike').not.toBe(first)
  })

  it('the DATASET is rendered whole — it is the discriminator, so it is never the part clipped', () => {
    // Truncation is CSS and jsdom has no layout, so what is asserted here is the half that IS
    // decidable and is the half that was wrong before: nothing SHORTENS the dataset on its way
    // to the screen. Two datasets whose names differ only at the END are the case that matters —
    // a display that trimmed either one would render them identically.
    const longA = named('a', 'ds1', 'Second import of the same file — Batch A')
    const longB = named('b', 'ds2', 'Second import of the same file — Batch B')
    mount(spec, scopeWith([longA, longB], { cols: 'b' }))
    const shown = screen.getByTestId('widget-cols-selected-dataset')
    expect(shown.textContent).toBe('Second import of the same file — Batch B')
    expect(shown.textContent).not.toContain('…')
  })

  it('every TAG of a `multiple` picker names its own dataset', async () => {
    // A tag stands alone in the trigger with no heading above it, so it is the arm where the
    // bare label is least legible: two tags reading `col_name` say nothing about a run that
    // consumes both.
    const many: WidgetSpec = { ...(spec as object), multiple: true, value: '$state.many' } as unknown as WidgetSpec
    mount(many, scopeWith(twoDatasets, { many: ['a', 'b'] }))
    expect(displayedIds()).toEqual(['a', 'b'])
    const tags = [...picker().querySelectorAll('[data-testid^="widget-cols-select-tag-"]')].filter(
      el => !(el.getAttribute('data-testid') ?? '').endsWith('-close'),
    )
    expect(tags).toHaveLength(2)
    expect(displayedText(tags[0])).toContain('Batch A')
    expect(displayedText(tags[1])).toContain('Batch B')
    expect(displayedText(tags[0])).not.toBe(displayedText(tags[1]))
  })

  // ── the bound `multiple` trigger is still a TRIGGER ──────────────────────────────────
  //
  // A tag is `max-w-full` and this control's tag renders TWO lines (artifact over dataset), so
  // on a real form the tags cover most of the trigger — the pointer lands on a tag for anything
  // aimed at the middle of the control. The tag used to swallow every gesture (it stopped
  // click/pointerdown/keydown unconditionally, to keep the `×` from opening the list), so the
  // picker became unopenable by clicking it the moment it held one value: only the chevron and
  // whatever padding the tags had not filled still worked.
  //
  // It is asserted HERE, at the widget, because that is the surface it was found on — the
  // e2e journey that CHOOSES a second input clicked the picker, got a focused-but-closed
  // control, and timed out on an option row that was never rendered. The jsdom picker driver
  // could not have caught it: it fires the click ON THE TRIGGER, which is the one place the
  // pointer does not land once a tag is there.
  const boundMulti = (onChange?: string): WidgetSpec =>
    ({
      ...(spec as object),
      multiple: true,
      value: '$state.many',
      ...(onChange ? { onChange } : {}),
    }) as unknown as WidgetSpec

  /** One gesture, as the browser delivers it: press then click, on the node under the pointer. */
  async function pressAndClick(el: HTMLElement): Promise<void> {
    await act(async () => {
      fireEvent.pointerDown(el)
      fireEvent.pointerUp(el)
      fireEvent.click(el)
      await Promise.resolve()
    })
  }

  const tagOf = (value: string): HTMLElement =>
    picker().querySelector<HTMLElement>(`[data-testid="widget-cols-select-tag-${value}"]`) as HTMLElement

  it('clicking a bound TAG opens the list — a tag is part of the control, not a hole in it', async () => {
    mount(boundMulti(), scopeWith(twoDatasets, { many: ['a'] }))
    expect(picker().getAttribute('aria-expanded')).toBe('false')
    await pressAndClick(tagOf('a'))
    expect(
      picker().getAttribute('aria-expanded'),
      'the tag covers the middle of the trigger, so a click on it IS a click on the combobox — ' +
        'a control that stops responding once it holds something is not a smaller working one',
    ).toBe('true')
  })

  it('…while the tag’s REMOVE control removes WITHOUT opening it', async () => {
    // The other half of the same rule, and the reason the blanket guard existed: pressing `×`
    // means "drop this value", and a list opening on top of that is noise. Both halves are
    // asserted because a fix that merely deleted the guard would pass the test above and
    // silently regress this one.
    const act1 = captureAction()
    mount(boundMulti(act1.id), scopeWith(twoDatasets, { many: ['a'] }))
    const close = tagOf('a').querySelector<HTMLElement>('[data-slot="tag-close"]') as HTMLElement
    expect(close, 'the tag renders a remove control').not.toBeNull()
    await pressAndClick(close)
    await waitFor(() => expect(act1.calls).toHaveLength(1))
    expect(act1.calls[0].value, 'removing the only tag emits the empty selection').toEqual([])
    expect(picker().getAttribute('aria-expanded'), 'removing a value must not open the list').toBe(
      'false',
    )
  })

  it('the SOLE-candidate summary names the dataset too', () => {
    // The arm where the user never saw a list at all, so the summary is the ONLY statement of
    // which dataset the run is about to read. It is reachable only WITH the declaration
    // (ITEM-29b) — without it a single candidate is an ordinary picker holding one option, and
    // there is no summary because nothing has been chosen.
    const declared = { ...(spec as object), auto_bind_sole_candidate: true } as unknown as WidgetSpec
    mount(declared, scopeWith([twoDatasets[0]], { cols: 'a' }))
    const summary = screen.getByTestId('widget-cols-summary')
    expect(summary.getAttribute('data-artifact-id')).toBe('a')
    expect(displayedText(summary)).toContain('col_name')
    expect(displayedText(summary)).toContain('Batch A')
  })

  // ── SEARCHING a grouped picker ─────────────────────────────────────────────────────
  //
  // Grouping and search are the same problem answered at two scales, and they have to
  // survive each other. A project with a handful of artifacts reads its groups whole; a
  // project with many needs to type — and the two datasets are still the discriminator
  // while it types, so both the ROWS and the HEADINGS have to behave under a filter:
  //
  //   · a heading whose every row filtered out must GO. A heading standing over nothing
  //     claims a dataset has a match when it has none — the exact opposite of what the
  //     grouping was added to tell the user.
  //   · the DATASET has to be typeable. It is the only thing that tells two identically
  //     named artifacts apart, so a search that reads only the artifact name can narrow a
  //     list of `col_name`s to a list of `col_name`s and answer nothing.

  describe('a picker big enough to need search keeps its dataset headings honest', () => {
    /** Six artifacts per dataset — twelve total, past the search threshold — all named
     *  `col_name` except one per dataset, so the identically-named case is the ordinary one. */
    const bigTwoDatasets: ArtifactRow[] = [
      ...Array.from({ length: 6 }, (_, i) => named(`a${i}`, 'ds1', 'Batch A')),
      ...Array.from({ length: 6 }, (_, i) => named(`b${i}`, 'ds2', 'Batch B')),
    ]

    it('offers search once the candidate list is big enough', async () => {
      mount(spec, scopeWith(bigTwoDatasets, { cols: 'a0' }))
      expect(await pickerSearchInput(picker())).not.toBeNull()
      expect(await pickerGroupHeadings(picker())).toEqual(['Batch A', 'Batch B'])
    })

    it('a heading whose every row filtered out DISAPPEARS — it never stands over nothing', async () => {
      // The defect this pins: a filter applied to the rows but not to the runs leaves the
      // headings drawn, so the user reads "Batch B" and finds nothing under it.
      mount(spec, scopeWith(bigTwoDatasets, { cols: 'a0' }))
      await typeInPicker(picker(), 'a3')
      expect(await pickerOptions(picker())).toEqual(['a3'])
      expect(await pickerGroupHeadings(picker())).toEqual(['Batch A'])
    })

    it('typing the DATASET keeps that dataset’s rows — the discriminator is searchable', async () => {
      // Every row here reads `col_name`, so typing the artifact name narrows nothing. The
      // dataset is the only thing that distinguishes them, and a search that could not reach
      // it would leave the user exactly where the reported defect left them.
      mount(spec, scopeWith(bigTwoDatasets, { cols: 'a0' }))
      await typeInPicker(picker(), 'Batch B')
      expect((await pickerOptions(picker())).sort()).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5'])
      expect(await pickerGroupHeadings(picker())).toEqual(['Batch B'])
    })

    it('a filter that matches nothing says so in the picker’s OWN wording', async () => {
      mount(spec, scopeWith(bigTwoDatasets, { cols: 'a0' }))
      await typeInPicker(picker(), 'no_such_artifact')
      expect(await pickerOptions(picker())).toEqual([])
      expect(await pickerGroupHeadings(picker())).toEqual([])
      const popup = document.querySelector('[data-testid="widget-cols-select-popup"]')
      // The same sentence the `multiple` arm has always shown — one copy, two arms.
      expect(popup?.textContent).toContain(ARTIFACT_REF_COPY.noMatch)
    })

    it('choosing from a filtered grouped list still emits the artifact ID', async () => {
      const act = captureAction()
      mount(
        { ...(spec as object), onChange: act.id } as unknown as WidgetSpec,
        scopeWith(bigTwoDatasets, { cols: 'a0' }),
      )
      await typeInPicker(picker(), 'Batch B')
      await choosePicker(picker(), 'b4')
      await waitFor(() => expect(act.calls).toHaveLength(1))
      expect(act.calls[0]).toMatchObject({ value: 'b4' })
    })
  })
})

// ── TEST-38 + TEST-89 (ITEM-29b) + TEST-A10 (acceptance, INV-10) ──────────────────────
//
// R2/INV-3: "a resolver may never take `[0]` … If exactly one candidate exists and auto-binding
// is wanted, that is a DECLARED affordance so the form shows what it bound." DEC-15 makes the
// declaration opt-IN, so absence is OFF and the invariant is the default rather than the
// exception.
//
// INV-10 is the second rule and it is NOT the same one: "a marked or contested candidate is
// never chosen FOR the user … Sole candidacy is not consent. The pane opens unselected and says
// why." So a DECLARED auto-bind still has to refuse, and still has to speak.
describe('auto_bind_sole_candidate — the DECLARATION (TEST-38 / TEST-89)', () => {
  const undeclared = (onChange: string): WidgetSpec => ({
    id: 'cols',
    kind: 'artifact_ref',
    label: 'Column names',
    source: { axis: 'cols', of: '$state.matrix', values: 'string' },
    value: '$state.cols',
    onChange,
  })

  it('WITHOUT the declaration a sole candidate is OFFERED and NOT bound', async () => {
    // The rewritten half of `:190`. The old spec asserted the pre-selection unconditionally,
    // which is the R2 violation stated as a requirement.
    const act = captureAction()
    mount(undeclared(act.id), scopeWith([MATRIX, row('col_name')], { matrix: 'm1' }))
    // give the effect every chance to fire before concluding it did not
    await new Promise(r => setTimeout(r, 20))
    expect(act.calls, 'nothing may be bound that the user did not choose').toEqual([])
    // and it is a real, operable picker holding its one option — not a dead end
    expect(await pickerOptions(picker())).toEqual(['col_name'])
  })

  it('WITHOUT the declaration the "selected automatically" copy does not render', () => {
    // The rewritten half of `:170`. A control must never claim it made a choice it did not.
    mount(undeclared('setCols'), scopeWith([MATRIX, row('col_name')], { matrix: 'm1' }))
    expect(screen.queryByTestId('widget-cols-summary')).toBeNull()
    expect(screen.getByTestId('widget-cols-field').textContent).not.toContain(
      ARTIFACT_REF_COPY.soleCandidate,
    )
  })

  it('WITH the declaration it binds AND the control says what it bound', async () => {
    const act = captureAction()
    const declared = { ...undeclared(act.id), auto_bind_sole_candidate: true } as WidgetSpec
    mount(declared, scopeWith([MATRIX, row('col_name')], { matrix: 'm1' }))
    await waitFor(() => expect(act.calls).toHaveLength(1))
    expect(act.calls[0]).toMatchObject({ value: 'col_name' })
    expect(screen.getByTestId('widget-cols-field').textContent).toContain(
      ARTIFACT_REF_COPY.soleCandidate,
    )
  })

  it('an explicit `false` is the same as absence — the declaration is opt-IN (DEC-15)', async () => {
    const act = captureAction()
    const off = { ...undeclared(act.id), auto_bind_sole_candidate: false } as WidgetSpec
    mount(off, scopeWith([MATRIX, row('col_name')], { matrix: 'm1' }))
    await new Promise(r => setTimeout(r, 20))
    expect(act.calls).toEqual([])
  })
})

describe('INV-10 — sole candidacy is not consent (TEST-A10)', () => {
  const spec = (over: Record<string, unknown> = {}): { auto_bind_sole_candidate?: boolean } => ({
    auto_bind_sole_candidate: true,
    ...over,
  })
  const cand = (over: Partial<ArtifactRefCandidate> = {}): ArtifactRefCandidate => ({
    id: 'a1',
    label: 'a',
    datatype: 'demo/column',
    ...over,
  })

  it('binds a plain sole candidate', () => {
    expect(autoBindVerdict(spec(), [cand()])).toEqual({ bind: true })
  })

  it('REFUSES a CONTESTED candidate, and says why', () => {
    const v = autoBindVerdict(spec(), [cand({ ambiguous: true })])
    expect(v.bind).toBe(false)
    expect(v.refusedBecause).toBe(ARTIFACT_REF_COPY.refusedAmbiguous)
  })

  it('REFUSES an A3 (alignment-undeclared) candidate, and says why', () => {
    const v = autoBindVerdict(spec(), [cand({ alignmentUnknown: true })])
    expect(v.bind).toBe(false)
    expect(v.refusedBecause).toBe(ARTIFACT_REF_COPY.refusedUnaligned)
  })

  it('`alignmentUnknown: undefined` is NOT A3 — the question was never asked', () => {
    // The A0–A3 states exist only relative to an anchored row space, and every shipped source
    // is a dataset-scoped sibling with no anchor. Treating "never asked" as "unknown" would
    // refuse every auto-bind in the app today and silently unbind three shipping surfaces —
    // exactly what DEC-15's migration exists to prevent.
    expect(autoBindVerdict(spec(), [cand({ alignmentUnknown: undefined })]).bind).toBe(true)
    expect(autoBindVerdict(spec(), [cand({ alignmentUnknown: false })]).bind).toBe(true)
  })

  it('does NOT refuse the residual-ordinal case that ITEM-29d used to mislabel ambiguous', () => {
    // `mintColumnKeys` once reported `ambiguous` for a name whose key merely had to be
    // qualified. Keyed on that, this refusal would have fired on a candidate nobody is
    // fighting over. The propositions are separated (ITEM-29d) and `ambiguous` here means
    // CONTESTED — carried by more than one candidate in this offer.
    expect(autoBindVerdict(spec(), [cand({ ambiguous: false })]).bind).toBe(true)
  })

  it('never binds when there is not exactly one candidate — declared or not', () => {
    expect(autoBindVerdict(spec(), []).bind).toBe(false)
    expect(autoBindVerdict(spec(), [cand(), cand({ id: 'a2' })]).bind).toBe(false)
  })
})

describe('a CONTESTED sole candidate refuses THROUGH the widget, and says so', () => {
  it('two identically-described candidates in one dataset are contested', async () => {
    // `disambiguate` is what discovers this, and it is per-OFFER: whether two things are
    // confusable is a fact about the list they are offered in.
    const twin = (id: string): ArtifactRow =>
      row(id, { meta: { name: 'col_name' }, source_dataset_name: 'Batch A' })
    const cands = resolveArtifactRefSource(
      [MATRIX, twin('t1'), twin('t2')],
      { axis: 'cols', of: '$state.matrix', values: 'string' },
      { state: { matrix: 'm1' } } as unknown as Scope,
    )
    expect(cands.map(c => c.ambiguous)).toEqual([true, true])
    // and a single UNCONTESTED candidate is not marked, which is what keeps the flag meaningful
    const one = resolveArtifactRefSource(
      [MATRIX, row('col_name')],
      { axis: 'cols', of: '$state.matrix', values: 'string' },
      { state: { matrix: 'm1' } } as unknown as Scope,
    )
    expect(one.map(c => c.ambiguous)).toEqual([false])
  })
})

// ── THE RADIO ARM (DEC-10) + A3 MARKED IN THE OFFER (ITEM-19 / DEC-11) ─────────────────
//
// Two blind-audit findings meet here, and both are about a control that answers a question
// only AFTER the decision it should have informed:
//
//   · the owner said *"Row space and Coordinates: RADIO, one active choice each"*, and a
//     dropdown shipped — while the spec file beside it went on asserting *"§ Coordinates IS
//     the radio"*. A closed picker reading one name gives no hint a second frame exists.
//   · the picker marked alignment only on the CHOSEN artifact, so a MIXED offer — one aligned
//     candidate, one undeclared — was indistinguishable up front, which is exactly the case
//     per-candidate marking exists for.

const KEYS_ONE = 'k'.repeat(64)
const KEYS_TWO = 'j'.repeat(64)

/** The key artifact that IS a row space. */
const rowSpaceRow = (id: string, hash: string, digest: string): ArtifactRow =>
  row(id, {
    content_hash: hash,
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'entities', key: 'values', key_sequence_digest: digest },
  })

/** A candidate on that row space — declaring its alignment, or (the A3 case) not. */
const alignedCandidate = (id: string, alignedTo?: string, dataset = 'ds-a'): ArtifactRow =>
  row(id, {
    datatype: 'demo/plottable',
    source_dataset_id: dataset,
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'entities', ...(alignedTo ? { aligned_to: alignedTo } : {}) },
  })

const RADIO_SPEC = (over: Record<string, unknown> = {}): WidgetSpec =>
  ({
    id: 'cols',
    kind: 'artifact_ref',
    label: 'Coordinates',
    control: 'radio',
    source: { aligned_to: '$scope.axis', datatype: 'demo/plottable' },
    ...over,
  }) as WidgetSpec

/** The render scope the row-space-scoped source resolves `$scope.axis` against. */
const anchoredScope = (artifacts: ArtifactRow[], axis: string): Scope =>
  ({ ...scopeWith(artifacts), scope: { axis } }) as unknown as Scope

describe('artifact_ref — `control: radio` (DEC-10)', () => {
  it('renders a RADIO GROUP, not a combobox, and every alternative is visible without a gesture', () => {
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      alignedCandidate('layout-a', KEYS_ONE),
      alignedCandidate('layout-b', KEYS_ONE),
    ]
    mount(RADIO_SPEC(), anchoredScope(catalog, 'hash-one'))
    expect(screen.getByTestId('widget-cols-radio')).toBeTruthy()
    // The failure this replaces: a `Select` whose alternatives cost a click to discover.
    expect(screen.queryByTestId('widget-cols-select')).toBeNull()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
  })

  it('choosing an option dispatches the SAME value the list arm would have', async () => {
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      alignedCandidate('layout-a', KEYS_ONE),
      alignedCandidate('layout-b', KEYS_ONE),
    ]
    const act1 = captureAction()
    mount(RADIO_SPEC({ onChange: act1.id, value: '$state.chosen' }), anchoredScope(catalog, 'hash-one'))
    fireEvent.click(screen.getAllByRole('radio')[1])
    await waitFor(() => expect(act1.calls).toHaveLength(1))
    // The IDENTITY, never the label (INV-1).
    expect(act1.calls[0].value).toBe('layout-b')
  })

  // ── `auto_select_first` — THE OPENING SELECTION (ledger #24) ────────────────────────────
  //
  // *"Always select the first … please"*, of the thing this control offers. It reverses the rule
  // `auto_bind_sole_candidate` encodes, and the reversal is narrow and declared: this is a RADIO,
  // the selection is visible, it is marked `auto`, and it is one click from any other. What the
  // old rule bought was a pane that lists the project's coordinate sets and then scopes nothing
  // until a gesture with exactly one sensible answer.
  it('selects the FIRST candidate on open, and marks the binding as automatic', async () => {
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      alignedCandidate('layout-a', KEYS_ONE),
      alignedCandidate('layout-b', KEYS_ONE),
    ]
    const act = captureAction()
    mount(
      RADIO_SPEC({ auto_select_first: true, onChange: act.id, value: '$state.chosen' }),
      anchoredScope(catalog, 'hash-one'),
    )
    await waitFor(() => expect(act.calls).toHaveLength(1))
    expect(act.calls[0].value).toBe('layout-a')
    // The MARK. It is the same origin the sole-candidate bind reports, so a downstream reader
    // cannot tell one automatic binding from another by accident — and "the app chose this" is
    // recorded rather than inferred.
    expect(act.ctxs[0]?.__bindingOrigin).toBe('auto')
  })

  it('does NOT fire when something is already selected — it never overrides a choice', async () => {
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      alignedCandidate('layout-a', KEYS_ONE),
      alignedCandidate('layout-b', KEYS_ONE),
    ]
    const act = captureAction()
    const scope = anchoredScope(catalog, 'hash-one') as unknown as Record<string, unknown>
    mount(RADIO_SPEC({ auto_select_first: true, onChange: act.id, value: '$state.chosen' }), {
      ...scope,
      state: { ...((scope.state as Record<string, unknown>) ?? {}), chosen: 'layout-b' },
    } as unknown as Scope)
    await new Promise(r => setTimeout(r, 20))
    expect(act.calls).toHaveLength(0)
  })

  it('is OPT-IN — a picker that does not declare it still opens unselected', async () => {
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      alignedCandidate('layout-a', KEYS_ONE),
      alignedCandidate('layout-b', KEYS_ONE),
    ]
    const act = captureAction()
    mount(RADIO_SPEC({ onChange: act.id, value: '$state.chosen' }), anchoredScope(catalog, 'hash-one'))
    await new Promise(r => setTimeout(r, 20))
    expect(act.calls).toHaveLength(0)
  })

  // ── `row_action` — THE ▶ ON EVERY ROW (ledger #27) ──────────────────────────────────────
  //
  // *"each … should have that button"*, replacing one wide button at the foot of the
  // card — which the mockup never described and which could only ever draw the ONE set that
  // happened to be selected.
  it('draws an emit control on EVERY option, named for the option', () => {
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      alignedCandidate('layout-a', KEYS_ONE),
      alignedCandidate('layout-b', KEYS_ONE),
    ]
    mount(
      RADIO_SPEC({ row_action: { label: 'Plot', icon: 'plot', onClick: 'noop' } }),
      anchoredScope(catalog, 'hash-one'),
    )
    expect(screen.getByTestId('widget-cols-emit-layout-a')).toBeTruthy()
    expect(screen.getByTestId('widget-cols-emit-layout-b')).toBeTruthy()
    // Named for the SUBJECT, never for the verb — ten rows called "Plot" is ten identical
    // accessible names (ITEM-30).
    const names = screen
      .getAllByRole('button')
      .map(b => b.getAttribute('aria-label'))
      .filter((n): n is string => n != null && n.startsWith('Plot '))
    expect(new Set(names).size).toBe(names.length)
  })

  it('a press emits THAT row — with its identity, its name and its dataset', async () => {
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      inDataset('layout-a', 'ds-a', 'Batch A'),
      inDataset('layout-b', 'ds-a', 'Batch A'),
    ]
    const act = captureAction()
    mount(
      RADIO_SPEC({
        row_action: {
          label: 'Plot',
          icon: 'plot',
          onClick: act.id,
          args: { artifact: '$option.id', coordinate_name: '$option.label', row_space: '$option.dataset' },
        },
      }),
      anchoredScope(catalog, 'hash-one'),
    )
    fireEvent.click(screen.getByTestId('widget-cols-emit-layout-b'))
    await waitFor(() => expect(act.calls).toHaveLength(1))
    expect(act.calls[0].artifact).toBe('layout-b')
    expect(act.calls[0].row_space).toBe('Batch A')
  })

  it('pressing it does NOT move the selection — choosing and drawing are two acts', async () => {
    // The property that makes a row a choice AND a verb at once. kit renders an option's content
    // inside the `<label>` that activates the choice, so without the renderer's suppression this
    // press would silently reframe the pane — and reframing scopes every other section.
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      alignedCandidate('layout-a', KEYS_ONE),
      alignedCandidate('layout-b', KEYS_ONE),
    ]
    const chose = captureAction()
    const emit = captureAction()
    mount(
      RADIO_SPEC({
        onChange: chose.id,
        value: '$state.chosen',
        row_action: { label: 'Plot', icon: 'plot', onClick: emit.id, args: { artifact: '$option.id' } },
      }),
      anchoredScope(catalog, 'hash-one'),
    )
    fireEvent.click(screen.getByTestId('widget-cols-emit-layout-b'))
    await waitFor(() => expect(emit.calls).toHaveLength(1))
    expect(chose.calls, 'the emit press changed the chosen coordinate set').toHaveLength(0)
  })

  it('a declared refusal disables the press and states it', () => {
    const catalog = [rowSpaceRow('axis-one', 'hash-one', KEYS_ONE), alignedCandidate('layout-a', KEYS_ONE)]
    mount(
      RADIO_SPEC({
        row_action: { label: 'Plot', icon: 'plot', onClick: 'noop', unavailableReason: '$state.why' },
      }),
      { ...(anchoredScope(catalog, 'hash-one') as unknown as Record<string, unknown>), state: { why: 'no frame yet' } } as unknown as Scope,
    )
    const button = screen.getByTestId('widget-cols-emit-layout-a')
    expect(button.getAttribute('aria-disabled') ?? button.getAttribute('disabled')).toBeTruthy()
  })

  it('above the DECLARED threshold it falls back to the list — and SAYS it did', () => {
    const catalog: ArtifactRow[] = [rowSpaceRow('axis-one', 'hash-one', KEYS_ONE)]
    for (let i = 0; i <= ARTIFACT_REF_RADIO_MAX; i++) catalog.push(alignedCandidate(`c${i}`, KEYS_ONE, `ds-${i}`))
    mount(RADIO_SPEC(), anchoredScope(catalog, 'hash-one'))
    expect(screen.queryByTestId('widget-cols-radio')).toBeNull()
    expect(screen.getByTestId('widget-cols-select')).toBeTruthy()
    // A SILENT substitution is how a shipped control drifts from its stated design without
    // anyone noticing, which is the whole finding this pair of tests exists for.
    expect(screen.getByTestId('widget-cols-field').textContent).toContain('too many to list side by side')
  })
})

// ── THE RADIO ARM GROUPS BY SOURCE DATASET ──────────────────────────────────────────────
//
// The list arm has always grouped (`runtime/candidateGroups.ts`); the radio arm rendered one
// flat `RadioGroup` and printed the dataset UNDER every option, which on the commonest project
// in the app spends the distinguishing slot on one constant. It now takes the SAME verdict
// (`shouldShowGroups`) and draws one group per dataset with a heading — and, exactly where the
// heading appears, stops repeating the dataset per row.
//
// One `RadioGroup` per group is an implementation the tests have to hold to account for, because
// single-choice-across-groups is no longer given by the primitive: it holds by construction (one
// value string selects an option in exactly one group), and "by construction" is a claim.

/** The SAME candidate with NO source dataset — what an artifact produced by the project itself
 *  (rather than imported with a dataset) looks like. It forms its own group, so this is the
 *  third offer SHAPE the control has to stay addressable across. */
const projectProduced = (id: string): ArtifactRow =>
  row(id, {
    datatype: 'demo/plottable',
    source_dataset_id: null,
    source_dataset_name: null,
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'entities', aligned_to: KEYS_ONE },
  })

/** A candidate carrying a NAMED source dataset, so the group heading is a name and not an id. */
const inDataset = (id: string, datasetId: string, datasetName: string): ArtifactRow =>
  row(id, {
    datatype: 'demo/plottable',
    source_dataset_id: datasetId,
    source_dataset_name: datasetName,
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'entities', aligned_to: KEYS_ONE },
  })

describe('the radio arm groups its candidates under their source dataset', () => {
  it('MORE THAN ONE dataset ⇒ one group per dataset, each with a visible heading naming it', () => {
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      inDataset('a1', 'ds-a', 'Batch A'),
      inDataset('a2', 'ds-a', 'Batch A'),
      inDataset('b1', 'ds-b', 'Batch B'),
    ]
    mount(RADIO_SPEC(), anchoredScope(catalog, 'hash-one'))
    expect(screen.getByTestId('widget-cols-group-0').textContent).toBe('Batch A')
    expect(screen.getByTestId('widget-cols-group-1').textContent).toBe('Batch B')
    // Two groups, split the way the data is — not one group of three, and not three of one.
    expect(screen.getByTestId('widget-cols-radio-group-0').querySelectorAll('[role="radio"]')).toHaveLength(2)
    expect(screen.getByTestId('widget-cols-radio-group-1').querySelectorAll('[role="radio"]')).toHaveLength(1)
    // …and the CONTROL is still addressable by its own name, which is the invariant below.
    expect(screen.getByTestId('widget-cols-radio')).toBeTruthy()
  })

  it('the dataset is NOT repeated on every option under its own heading', () => {
    // The defect the grouping exists to remove: the heading already says it, so printing it per
    // row spends the one slot meant to distinguish the options on a constant.
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      inDataset('a1', 'ds-a', 'Batch A'),
      inDataset('b1', 'ds-b', 'Batch B'),
    ]
    mount(RADIO_SPEC(), anchoredScope(catalog, 'hash-one'))
    const optionText = [...document.querySelectorAll('[data-artifact-id]')].map(el => el.textContent ?? '')
    expect(optionText).toHaveLength(2)
    expect(optionText.join(' | ')).not.toContain('Batch A')
    expect(optionText.join(' | ')).not.toContain('Batch B')
  })

  it('ONE dataset ⇒ ONE radio group AND its heading (ledger #8 / #16)', () => {
    // REWRITTEN: this asserted `queryByTestId('widget-cols-group-0')` was NULL. The owner's
    // objection is that the heading was MISSING (*"why there are no header for Datasets?"*),
    // and the suppression that produced it was never asked for.
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      inDataset('a1', 'ds-a', 'Batch A'),
      inDataset('a2', 'ds-a', 'Batch A'),
    ]
    mount(RADIO_SPEC(), anchoredScope(catalog, 'hash-one'))
    expect(screen.getByTestId('widget-cols-radio')).toBeTruthy()
    expect(screen.getByTestId('widget-cols-group-0').textContent).toBe('Batch A')
    expect(screen.getByTestId('widget-cols-radio-group-0')).toBeTruthy()
  })

  // ── THE ADDRESSING INVARIANT, pinned as an INVARIANT and not as markup ───────────────
  //
  // This is the defect that reached the e2e tier: `${id}-radio` was the testid of the single
  // `RadioGroup`, so the moment the offer split per dataset the CONTROL'S ADDRESS MOVED — three
  // specs failed on it resolving to two elements, and a caller could not address the control
  // without knowing the shape of the data it happened to be rendering.
  //
  // A test pinning "there is a div with this testid" would have gone green against any future
  // shape that moved it again. So what is asserted is the PROPERTY a caller depends on, across
  // BOTH shapes, from one loop: exactly one element answers to the control's name, it is the
  // thing that contains the options, and every option is reachable through it. Add a third
  // shape later and it either satisfies this or it is a breaking change to every caller.
  it('THE INVARIANT — the control answers to ONE address BY EVERY MEANS, whatever shape it takes', () => {
    // What the control is CALLED, taken from the spec the shapes are mounted with rather than
    // retyped — a literal here could drift from the declaration and the test would still pass.
    const CONTROL_NAME = (RADIO_SPEC() as { aria_label?: string; label?: string }).aria_label
      ?? (RADIO_SPEC() as { label?: string }).label
      ?? 'artifact'
    const SHAPES = {
      'one dataset': [inDataset('a1', 'ds-a', 'Batch A'), inDataset('a2', 'ds-a', 'Batch A')],
      'two datasets': [inDataset('a1', 'ds-a', 'Batch A'), inDataset('b1', 'ds-b', 'Batch B')],
      'a dataset and a project-produced artifact': [inDataset('a1', 'ds-a', 'Batch A'), projectProduced('p1')],
    } as const

    for (const [shape, rows] of Object.entries(SHAPES)) {
      cleanup()
      const catalog = [rowSpaceRow('axis-one', 'hash-one', KEYS_ONE), ...rows]
      mount(RADIO_SPEC(), anchoredScope(catalog, 'hash-one'))

      // 1. EXACTLY ONE element answers to the control's name. Not zero (the address vanished),
      //    not two (the address became ambiguous — the literal e2e failure).
      const addressed = screen.getAllByTestId('widget-cols-radio')
      expect(addressed, `${shape}: the control's address is not unique`).toHaveLength(1)

      // 2. It CONTAINS the options — an address that resolves to the wrong node is no better
      //    than one that resolves to none.
      const options = addressed[0].querySelectorAll('[role="radio"]')
      expect(options.length, `${shape}: options are not reachable through the address`).toBe(rows.length)

      // 3. Nothing is offered OUTSIDE it, so counting through the address counts the whole
      //    offer rather than a part of it.
      expect(document.querySelectorAll('[role="radio"]').length, `${shape}: options outside the control`).toBe(
        rows.length,
      )

      // 4. ITS ACCESSIBLE NAME IS ALSO SINGULAR.
      //
      //    This clause is the reason the test is written as an ENUMERATION rather than as the
      //    one check that happened to fail. Clauses 1-3 were added after a moved TESTID broke
      //    three specs — and the identical defect was still sitting in the accessible name,
      //    because each per-group radiogroup was called `<control> — <dataset>` and therefore
      //    every group answered to the control's name. Playwright matches an accessible name
      //    as a case-insensitive SUBSTRING unless told otherwise, so
      //    `getByRole('radiogroup', {name: 'Coordinates'})` resolved to two elements and the
      //    same class recurred one address later.
      //
      //    So: exactly ONE element in the document carries the control's name, by substring,
      //    across every role. A third address will otherwise repeat this a third time.
      const named = [...document.querySelectorAll('[aria-label]')].filter(el =>
        (el.getAttribute('aria-label') ?? '').toLowerCase().includes(CONTROL_NAME.toLowerCase()),
      )
      expect(
        named.map(el => `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${el.getAttribute('aria-label')}`),
        `${shape}: the control's NAME is not unique`,
      ).toHaveLength(1)

      // 5. …and that named element IS the addressed one, or lives inside it — so the two
      //    addresses cannot drift into two different "the control"s.
      //
      //    Containment rather than identity, deliberately: where the offer does not group there
      //    is one radiogroup and it carries the name itself; where it does, the name moves to
      //    the group box that holds them. Both are the control, and a caller reaching it by
      //    either address lands in the same subtree — which is the whole of what a caller
      //    depends on. Demanding identity would force the ungrouped case to grow an unnamed
      //    inner radiogroup purely to satisfy a test, which is worse for a screen reader than
      //    the thing it would be pinning.
      expect(
        named[0] === addressed[0] || addressed[0].contains(named[0]),
        `${shape}: the named element is not the addressed control or inside it`,
      ).toBe(true)
    }
  })

  it('ONE choice still holds ACROSS the groups — picking in the second dispatches its id', async () => {
    // The claim "single choice holds by construction". Splitting one `RadioGroup` into N is
    // exactly the change that could ship N independent selections, and nothing in the primitive
    // prevents it — so the second group's option is chosen and the dispatched IDENTITY read back.
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      inDataset('a1', 'ds-a', 'Batch A'),
      inDataset('b1', 'ds-b', 'Batch B'),
    ]
    const act1 = captureAction()
    mount(RADIO_SPEC({ onChange: act1.id, value: '$state.chosen' }), anchoredScope(catalog, 'hash-one'))
    fireEvent.click(screen.getByTestId('widget-cols-radio-group-1').querySelectorAll('[role="radio"]')[0])
    await waitFor(() => expect(act1.calls).toHaveLength(1))
    expect(act1.calls[0].value).toBe('b1')
  })
})

/** Any aggregate sentence about undeclared alignment. Matched on the CLAIM rather than on a
 *  removed constant, because the defect being guarded against is a control that says this
 *  again in new words, not one that resurrects the exact deleted string. */
const ALIGNMENT_PROSE = /alignment.{0,40}not declared|not declared for any/i

describe('A3 is OFFERED, and no longer marked anywhere (owner, ledger #28 + #29)', () => {
  // ── REWRITTEN (owner, ledger #28 + #29) ────────────────────────────────────────────
  //
  // This asserted the MIXED case: the undeclared candidate carries a mark, the declared one
  // does not. The mark is gone — #28 deleted the alert that stated the fact in prose, #29 the
  // mark an emitted plot carried, and between them DEC-11's *"offered but MARKED"* is retired.
  //
  // What replaces it is the half of the old assertion that still has to hold, and which the
  // old form only carried implicitly: BOTH candidates are still OFFERED, as radio options, in
  // the same order, and neither is distinguished from the other by anything about alignment.
  // The obvious wrong reading of "remove the alignment not declared" is to stop offering the
  // candidate; this is where that would go red.
  it('a MIXED offer offers BOTH candidates, and marks neither', () => {
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      rowSpaceRow('axis-two', 'hash-two', KEYS_TWO),
      alignedCandidate('declared', KEYS_ONE),
      alignedCandidate('undeclared'),
    ]
    mount(RADIO_SPEC(), anchoredScope(catalog, 'hash-one'))
    // THE OFFER — both, as real options.
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    // …and nothing anywhere in the control says a word about alignment, on a row or otherwise.
    expect(screen.queryByTestId('widget-cols-alignment-undeclared')).toBeNull()
    expect(screen.queryByTestId('widget-cols-alignment-declared')).toBeNull()
    expect(screen.getByTestId('widget-cols-field').textContent ?? '').not.toMatch(/alignment/i)
  })

  // ── the AGGREGATE arm, and where it went ────────────────────────────────────────────
  //
  // This test asserted that when every candidate is undeclared the control PRINTS a sentence
  // saying so (`ARTIFACT_REF_COPY.allUnaligned`), and its sibling below asserted the list arm
  // printed the same one. Both the copy and the production `allAlignmentUnknown` that gated it
  // are DELETED (owner, 2026-08-13): the pane stated that one fact in three places on one
  // screen — this control's prose, § Coordinates' `coordinateAlignmentAlert` and the entry
  // section's alert — and a fact said three times is furniture, which a reader learns to skip.
  //
  // So the assertion is INVERTED rather than dropped, and it is now the stronger of the two:
  // the pane says it ONCE, in § Coordinates' alert (asserted on the shipped declaration in
  // `core/spec/visualizeEmitModel.test.ts`), and this control says it ZERO times. Silence is
  // exactly what a deleted branch must produce, and asserting it here is what stops the prose
  // being re-added to the control by an author who only read the copy table.
  //
  // The PER-CANDIDATE marks the owner never objected to are untouched, and the "no row is
  // marked" half of the original — the half that actually distinguished this state from the
  // mixed one — is kept verbatim.

  it('when EVERY candidate is undeclared, no row is marked AND the control says nothing about it', () => {
    // The DEFAULT state of a project whose value artifacts declare no alignment at all — the
    // state in which the per-row mark would be on every row and therefore informative on none.
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      alignedCandidate('a'),
      alignedCandidate('b', undefined, 'ds-b'),
    ]
    mount(RADIO_SPEC(), anchoredScope(catalog, 'hash-one'))
    expect(screen.queryByTestId('widget-cols-alignment-a')).toBeNull()
    expect(screen.queryByTestId('widget-cols-alignment-b')).toBeNull()
    expect(screen.getByTestId('widget-cols-field').textContent ?? '').not.toMatch(ALIGNMENT_PROSE)
  })

  // Same rewrite, on the arm every OTHER `artifact_ref` in the app renders — which is why the
  // pair exists at all: a one-armed change is the drift it catches, in whichever direction the
  // two arms are supposed to agree. They now agree on silence.
  it('the LIST arm offers both and marks neither — the two controls cannot disagree', async () => {
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      alignedCandidate('declared', KEYS_ONE),
      alignedCandidate('undeclared'),
    ]
    // No `control: radio` ⇒ the ordinary searchable list, which is what every other
    // `artifact_ref` in the app renders.
    mount(RADIO_SPEC({ control: undefined }), anchoredScope(catalog, 'hash-one'))
    await openPicker(picker())
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.queryByTestId('widget-cols-alignment-undeclared')).toBeNull()
    expect(screen.queryByTestId('widget-cols-alignment-declared')).toBeNull()
  })
})

// ── the gaps a blind test-reality audit found in the block above ────────────────────────
//
// Each of these was reached by MUTATION, not by reading: the production line was neutered and
// the whole suite stayed green. They are listed with the surviving mutation, because a test
// whose surviving mutation cannot be named is a test nobody has checked.

describe('the A3 aggregate has a NEGATIVE control, and the threshold has a boundary', () => {
  it('an offer where EVERY candidate is declared says NOTHING about alignment', () => {
    // Surviving mutation (when the aggregate still existed): `allAlignmentUnknown` reduced to
    // `candidates.length > 0` — i.e. every `artifact_ref` in the app permanently telling the
    // user "alignment is not declared for any of these". 42 tests passed against it, because
    // the only two all-declared fixtures asserted testids and never asserted that the picker
    // stays SILENT.
    //
    // The aggregate is now deleted outright, so this is the case that MUST still hold after
    // the deletion as well as before it, and it is kept unchanged except for reading the claim
    // instead of the removed constant.
    const catalog = [
      rowSpaceRow('axis-one', 'hash-one', KEYS_ONE),
      alignedCandidate('one', KEYS_ONE),
      alignedCandidate('two', KEYS_ONE, 'ds-b'),
    ]
    mount(RADIO_SPEC(), anchoredScope(catalog, 'hash-one'))
    expect(screen.getByTestId('widget-cols-field').textContent ?? '').not.toMatch(ALIGNMENT_PROSE)
  })

  it('the LIST arm is silent about the aggregate too — the two arms cannot disagree', () => {
    // This asserted the opposite (both arms PRINT the sentence), against the surviving mutation
    // "delete the `allUnaligned` entry from the LIST arm's description array". The sentence is
    // gone from both arms (owner, 2026-08-13: the pane stated one fact three times; § Coordinates'
    // `coordinateAlignmentAlert` is the one place it is said now).
    //
    // The property is unchanged and is why this is not merely the radio test again: the LIST arm
    // is what every OTHER `artifact_ref` in the app renders, so a one-armed change is exactly the
    // drift this pair exists to catch — in whichever direction the two arms are supposed to agree.
    const catalog = [rowSpaceRow('axis-one', 'hash-one', KEYS_ONE), alignedCandidate('a'), alignedCandidate('b', undefined, 'ds-b')]
    mount(RADIO_SPEC({ control: undefined }), anchoredScope(catalog, 'hash-one'))
    expect(screen.queryByTestId('widget-cols-radio')).toBeNull()
    expect(screen.getByTestId('widget-cols-field').textContent ?? '').not.toMatch(ALIGNMENT_PROSE)
  })

  it('AT the threshold it is still a radio — the boundary, pinned in both directions', () => {
    // Surviving mutation: `>` → `>=`. That off-by-one drops the SHIPPED frame picker to a
    // dropdown at exactly 8 candidates, and the above-case alone cannot see it.
    //
    // ONE dataset, deliberately: the radio arm now draws one `RadioGroup` per source dataset
    // when there is more than one, so a per-`ds-${i}` fixture would be asserting the GROUPED
    // testids and the threshold at the same time. Grouping has its own tests below; this one
    // is about the count at which the control stops being a radio at all.
    const catalog: ArtifactRow[] = [rowSpaceRow('axis-one', 'hash-one', KEYS_ONE)]
    for (let i = 0; i < ARTIFACT_REF_RADIO_MAX; i++) catalog.push(alignedCandidate(`c${i}`, KEYS_ONE))
    mount(RADIO_SPEC(), anchoredScope(catalog, 'hash-one'))
    expect(screen.getByTestId('widget-cols-radio')).toBeTruthy()
    expect(screen.queryByTestId('widget-cols-select')).toBeNull()
    expect(screen.getByTestId('widget-cols-field').textContent).not.toContain('too many to list side by side')
  })

  it('the substitution NAMES the count that tripped it, so the threshold and its reason cannot drift', () => {
    // What stood here asserted that the pane's TWO radio controls — the frame picker and the
    // row-space anchor above it — turned over at the same candidate count, `expect(ANCHOR_RADIO_MAX)
    // .toBe(ARTIFACT_REF_RADIO_MAX)`. The anchor is deleted (owner, 2026-08-13), so there is no
    // second control to agree with and `ANCHOR_RADIO_MAX` no longer exists.
    //
    // What the pair protected was that a user never meets two thresholds dressed as one rule. The
    // surviving half of that is INTERNAL: the count the control falls back AT and the count it
    // NAMES when it does must be the same number. Asserting the full sentence (not the "too many"
    // fragment the neighbouring test reads) is what pins it — a hardcoded `8` in the copy, or a
    // count taken from anything but the offer, fails here and nowhere else.
    const catalog: ArtifactRow[] = [rowSpaceRow('axis-one', 'hash-one', KEYS_ONE)]
    for (let i = 0; i <= ARTIFACT_REF_RADIO_MAX; i++) catalog.push(alignedCandidate(`c${i}`, KEYS_ONE))
    mount(RADIO_SPEC(), anchoredScope(catalog, 'hash-one'))
    expect(screen.getByTestId('widget-cols-field').textContent).toContain(
      ARTIFACT_REF_COPY.radioOverflowed(ARTIFACT_REF_RADIO_MAX + 1),
    )
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// binding-origin — site 1. The auto-bound value must be TOLD APART from a chosen one, on
// screen and in what the run is handed.
//
// Every case below is built so that the artifact is THE SAME on both sides. A test that
// merely asserted "the sole candidate still gets bound" would pass on main and prove nothing
// about this change.
// ══════════════════════════════════════════════════════════════════════════════════════════

describe('TEST-16 (binding-origin / ITEM-6, ITEM-7) — [acceptance] [invariant: INV-2] the mark is on screen', () => {
  const declared = (onChange: string): WidgetSpec => ({
    id: 'cols',
    kind: 'artifact_ref',
    label: 'Column names',
    source: { axis: 'cols', of: '$state.matrix', values: 'string' },
    value: '$state.cols',
    auto_bind_sole_candidate: true,
    onChange,
  })

  it('the auto-bound summary carries a VISIBLE mark and data-binding-origin', () => {
    mount(declared('setCols'), scopeWith([MATRIX, row('col_name')], { matrix: 'm1', cols: 'col_name' }))
    const summary = screen.getByTestId('widget-cols-summary')
    expect(summary.getAttribute('data-binding-origin')).toBe('auto')
    // Read as TEXT, not as a `title`/tooltip: INV-2 says "without hover", and a mark that
    // needs a gesture to reveal is R8's disclaimer rather than a marker.
    expect(summary.textContent).toContain(ARTIFACT_REF_COPY.autoBoundMark)
    expect(screen.getByTestId('widget-cols-origin').textContent).toBe(ARTIFACT_REF_COPY.autoBoundMark)
  })

  it('THE SAME artifact chosen by the user through a picker carries NO mark', () => {
    // The distinction, stated as directly as the DOM allows: same widget, same bound value,
    // and the only difference is who chose it. Before the origin existed these two renders
    // were identical, which is the defect.
    const twoCandidates: WidgetSpec = {
      id: 'cols',
      kind: 'artifact_ref',
      label: 'Column names',
      source: { axis: 'cols', of: '$state.matrix', values: 'string' },
      value: '$state.cols',
      auto_bind_sole_candidate: true,
      onChange: 'setCols',
    }
    mount(
      twoCandidates,
      scopeWith([MATRIX, row('col_name'), row('alt_name')], { matrix: 'm1', cols: 'col_name' }),
    )
    // With two candidates the auto-bind cannot have fired, so the control is a picker and
    // nothing on screen claims the choice was made for anyone.
    expect(screen.queryByTestId('widget-cols-origin')).toBeNull()
    expect(screen.queryByTestId('widget-cols-summary')).toBeNull()
    expect(document.body.textContent).not.toContain(ARTIFACT_REF_COPY.autoBoundMark)
  })

  it('an UNDECLARED sole candidate is not marked, because it was not bound (DEC-15)', () => {
    // Absence of the declaration means the control offers its one option unbound. Marking it
    // would state that something was chosen when nothing was — the opposite error, and just
    // as much a false claim.
    // Built by OMISSION rather than by deleting the key off a declared twin: `WidgetSpec` is
    // a discriminated union, so the cast a `delete` needs is exactly the escape hatch that
    // would let a later rename of `auto_bind_sole_candidate` leave this test silently
    // asserting nothing. Spelling the spec without the key keeps the compiler on the hook.
    const undeclaredSpec: WidgetSpec = {
      id: 'cols',
      kind: 'artifact_ref',
      label: 'Column names',
      source: { axis: 'cols', of: '$state.matrix', values: 'string' },
      value: '$state.cols',
      onChange: 'setCols',
    }
    mount(undeclaredSpec, scopeWith([MATRIX, row('col_name')], { matrix: 'm1' }))
    expect(screen.queryByTestId('widget-cols-origin')).toBeNull()
  })

  it('the mark appears only once the binding has LANDED, never beside a pending one', () => {
    // Same rule as the value itself: a control must never describe how a value the run has
    // not been given was chosen. `data-pending` is the unlanded state and is a different
    // fact from origin.
    mount(declared('setCols'), scopeWith([MATRIX, row('col_name')], { matrix: 'm1' }))
    const summary = screen.getByTestId('widget-cols-summary')
    expect(summary.getAttribute('data-pending')).toBe('true')
    expect(summary.getAttribute('data-binding-origin')).toBeNull()
    expect(screen.queryByTestId('widget-cols-origin')).toBeNull()
  })
})

describe('TEST-17 (binding-origin / ITEM-6) — what the run is told', () => {
  it('the AUTO dispatch carries the origin on its ctx; a user pick carries none', async () => {
    const act = captureAction()
    const spec: WidgetSpec = {
      id: 'cols',
      kind: 'artifact_ref',
      label: 'Column names',
      source: { axis: 'cols', of: '$state.matrix', values: 'string' },
      value: '$state.cols',
      auto_bind_sole_candidate: true,
      onChange: act.id,
    }
    mount(spec, scopeWith([MATRIX, row('col_name')], { matrix: 'm1' }))
    await waitFor(() => expect(act.calls).toHaveLength(1))
    // The VALUE is unchanged — the origin is a separate channel, so the launch identity and
    // everything else that reads the params bag see exactly what they saw before.
    expect(act.calls[0]).toMatchObject({ value: 'col_name', view_id: 'v1' })
    expect(act.ctxs[0]?.__bindingOrigin).toBe('auto')
  })

  it('a user picking from a 2+ list dispatches with NO origin, leaving the store default', async () => {
    const act = captureAction()
    const spec: WidgetSpec = {
      id: 'cols',
      kind: 'artifact_ref',
      label: 'Column names',
      source: { axis: 'cols', of: '$state.matrix', values: 'string' },
      value: '$state.cols',
      auto_bind_sole_candidate: true,
      onChange: act.id,
    }
    mount(spec, scopeWith([MATRIX, row('col_name'), row('alt_name')], { matrix: 'm1' }))
    await choosePicker(screen.getByTestId('widget-cols-select'), 'col_name')
    await waitFor(() => expect(act.calls.length).toBeGreaterThan(0))
    expect(act.calls[0]).toMatchObject({ value: 'col_name' })
    // Deliberately `undefined` rather than a literal `'user'`: the fallback is decided in
    // exactly ONE place (`ViewStore.set`'s default). Two places deciding it is how the two
    // come to disagree.
    expect(act.ctxs[0]?.__bindingOrigin).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// TEST-43 (ITEM-35, DEC-D) — `expandSelectionArtifacts`: a MIXED multi-select must not drop the
// unfused picks. This is the HIGH bug both blind-audit angles corroborated (FIX_ROUND-1): the
// member set is AUTHORITATIVE for what the run consumes, so an unfused pick contributing nothing
// would be silently dropped from the run — the inverse of the provenance hole ITEM-35 closes.
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('expandSelectionArtifacts (ITEM-35) — a mixed fused+unfused multi-select drops nothing', () => {
  // A fused offer (primary 'a', members [a,b]) and a plain single-dataset column 'x'.
  const cands = [
    { id: 'a', artifacts: ['a', 'b'] as readonly string[] },
    { id: 'x' }, // unfused — no `artifacts`
  ]

  it('a single FUSED pick expands to its whole member set, primary first', () => {
    expect(expandSelectionArtifacts('a', cands)).toEqual(['a', 'b'])
  })

  it('a single UNFUSED pick records NO set — the raw value binds as before (INV-4)', () => {
    expect(expandSelectionArtifacts('x', cands)).toBeUndefined()
  })

  it('a MIXED multi-select keeps the unfused pick — [a,x] -> [a,b,x], not [a,b] (the HIGH regression)', () => {
    // Before the fix, the unfused `x` was dropped and the run bound only {a,b}; `x` — a real
    // user selection — never reached the compute. It must be present.
    expect(expandSelectionArtifacts(['a', 'x'], cands)).toEqual(['a', 'b', 'x'])
  })

  it('an ALL-unfused multi-select records NO set (nothing fused)', () => {
    expect(expandSelectionArtifacts(['x', 'y'], cands)).toBeUndefined()
  })

  it('dedups a member shared by a fused set and an explicit pick, preserving order', () => {
    // 'b' is both a member of the fused 'a' and (hypothetically) separately selected.
    expect(expandSelectionArtifacts(['a', 'b'], cands)).toEqual(['a', 'b'])
  })
})
