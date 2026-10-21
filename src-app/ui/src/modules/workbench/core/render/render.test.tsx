// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { createViewStore } from '@/modules/workbench/core/runtime/store'
import { registerViewStore, __resetViewStoresForTests } from '@/modules/workbench/core/runtime/viewStores'
import { registerViewSpecActions, __resetRegisteredSpecsForTests } from '@/modules/workbench/core/runtime/interpreter'
import { installBuiltinWidgets, __resetBuiltinWidgetsForTests } from '@/modules/workbench/extensions'
import { WidgetList } from './WidgetHost'
import { choosePicker } from '@/modules/workbench/core/__testutil__/pickerDriver'
import type { Scope } from '@/modules/workbench/core/runtime/expr'

// TEST-23 (PLAN.md ITEM-1, ITEM-7) — an interpreted `view_spec` renders its
// declared widgets (select / range_slider / table / button) and dispatches the
// bound declared action on change/click (through `runAction` → `interpretBody`
// → the live view store).

// jsdom lacks these; base-ui controls (Slider) probe them at mount.
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
})

function spec(): ViewSpec {
  return {
    id: 'render/qc',
    title: 'Render QC',
    permission: 'jobs::use',
    state: {
      selectedEmbedding: { type: 'string', default: 'umap' },
      threshold: { type: 'array', default: [10, 90] },
      saved: { type: 'boolean', default: false },
    },
    const: { embeddings: ['umap', 'tsne', 'pca'], thrRange: [0, 100] },
    derived: {},
    widgets: [
      { id: 'emb', kind: 'select', label: 'Embedding', options: '$const.embeddings', value: '$state.selectedEmbedding', onChange: 'setEmbedding' },
      { id: 'thr', kind: 'range_slider', label: 'Threshold', range: '$const.thrRange', value: '$state.threshold', onCommit: 'setThreshold' },
      { id: 'tbl', kind: 'table', rows: '$const.embeddings', columns: [{ key: 'name', title: 'Name', value: '$row' }] },
      { id: 'save', kind: 'button', label: 'Save', variant: 'primary', onClick: 'markSaved' },
    ],
    actions: [
      { id: 'setEmbedding', title: 'Set embedding', permission: 'jobs::use', mutating: true, stateful: true, params: { value: 'string' }, body: [{ set: { selectedEmbedding: '$params.value' } }] },
      { id: 'setThreshold', title: 'Set threshold', permission: 'jobs::use', mutating: true, stateful: true, params: { range: '[number, number]' }, body: [{ set: { threshold: '$params.range' } }] },
      { id: 'markSaved', title: 'Mark saved', permission: 'jobs::use', mutating: true, params: {}, body: [{ set: { saved: true } }] },
    ],
  }
}

beforeEach(() => {
  cleanup()
  __resetViewStoresForTests()
  __resetRegisteredSpecsForTests()
  __resetBuiltinWidgetsForTests()
})

describe('interpreted view_spec rendering (ITEM-1/ITEM-7)', () => {
  it('renders the declared widgets and dispatches the bound action on change/click', async () => {
    const s = spec()
    installBuiltinWidgets()
    registerViewSpecActions(s)
    const viewId = 'render-view-1'
    const store = createViewStore(s, viewId)
    registerViewStore(viewId, store)

    const scope: Scope = {
      params: {},
      state: store.state,
      derived: store.derived,
      const: s.const ?? {},
      data: {},
    }
    render(<WidgetList specs={s.widgets} scope={scope} viewId={viewId} specId={s.id} />)

    // All four declared widgets render.
    expect(screen.queryByTestId('widget-emb')).not.toBeNull()
    expect(screen.queryByTestId('widget-thr')).not.toBeNull()
    expect(screen.queryByTestId('widget-tbl')).not.toBeNull()
    expect(screen.queryByTestId('widget-save')).not.toBeNull()
    // Table rendered its rows.
    expect(screen.getAllByText('pca').length).toBeGreaterThan(0)

    // select change → bound `setEmbedding` action mutates the live store. The closed set is a
    // POPOVER picker, so the choice is made the way a user makes it — open the control, click
    // the row — rather than by setting a `value` the control does not have.
    await choosePicker(screen.getByTestId('widget-emb'), 'pca')
    await waitFor(() => expect(store.state.selectedEmbedding).toBe('pca'))

    // button click → bound `markSaved` action mutates the live store.
    fireEvent.click(screen.getByTestId('widget-save'))
    await waitFor(() => expect(store.state.saved).toBe(true))

    store.dispose()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// declarative-rendering-hardening ITEM-18 (found BY the Slice-3 gallery coverage).
//
// A `for_each` expansion yields N entries that ALL carry the same declared widget `id`
// (`criterionRow` × 50), and `WidgetHost` keyed its children on that id alone — so React saw
// duplicate keys for every repeated widget and logged "Encountered two children with the same
// key" on every real processor form. It had been invisible because no declarative surface was
// ever rendered under the runtime-health pass; the very first fixture surfaced it.
// ─────────────────────────────────────────────────────────────────────────────

describe('for_each expansion produces UNIQUE React keys (ITEM-18)', () => {
  it('renders N repeated widgets with no duplicate-key warning', () => {
    const s: ViewSpec = {
      id: 'render/foreach',
      title: 'For-each',
      permission: 'jobs::use',
      state: { rows: { type: 'list', default: [{ v: 'a' }, { v: 'b' }, { v: 'c' }] } },
      const: {},
      derived: {},
      widgets: [
        {
          id: 'row',
          kind: 'text',
          for_each: '$state.rows as $r, $i',
          label: 'Row',
          value: '$r.v',
        },
      ],
      actions: [],
    } as unknown as ViewSpec

    installBuiltinWidgets()
    registerViewSpecActions(s)
    const viewId = 'render-foreach-1'
    const store = createViewStore(s, viewId)
    registerViewStore(viewId, store)

    const seen: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      seen.push(args.map(String).join(' '))
    })

    const scope: Scope = {
      params: {},
      state: store.state,
      derived: store.derived,
      const: s.const ?? {},
      data: {},
    }
    render(<WidgetList specs={s.widgets} scope={scope} viewId={viewId} specId={s.id} />)

    // All three repetitions rendered…
    expect(screen.getAllByTestId('widget-row-input').length).toBe(3)
    // …and React never complained about duplicate keys (it did before ITEM-18).
    expect(seen.filter(m => /same key/i.test(m))).toEqual([])

    errSpy.mockRestore()
    store.dispose()
  })
})
