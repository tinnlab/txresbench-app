// @vitest-environment jsdom
//
// TEST-31 (ITEM-23) + TEST-A6 (acceptance, INV-6) — the `entry_list` widget kind.
//
// The justification for a new KIND is entirely about what a TOKEN cannot carry, so the tests
// are about exactly that: which sources an entry resolved to, that it resolved to ZERO (U1),
// and a per-source sub-toggle that exists only where the sources are separately addressable.
// A test that only checked "the list renders and you can tick a row" would pass just as well
// against the `multiselect` this kind exists because it could not be.
//
// INV-6 — "an entry states its own resolution. `entry_list` renders unchosen,
// chosen-and-resolved (with source count), and chosen-and-unresolved DISTINCTLY."

import * as React from 'react'
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { z } from 'zod'
import { defineAction } from '@/core/actions/defineAction'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { __clearWidgetsForTests } from '@/modules/workbench/core/render/registry'
import { WidgetList } from '@/modules/workbench/core/render/WidgetHost'
import { installVisualizeWidgets, __resetVisualizeWidgetsForTests } from './installVisualizeWidgets'
import {
  ENTRY_HEADING_ESTIMATE,
  ENTRY_LINE_ESTIMATE,
  ENTRY_LIST_COPY,
  ENTRY_LIST_OVERSCAN,
  ENTRY_ROW_ESTIMATE,
} from './EntryListWidget'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
  }
})

beforeEach(() => {
  cleanup()
  __clearWidgetsForTests()
  __resetVisualizeWidgetsForTests()
  installVisualizeWidgets()
})
afterEach(cleanup)

// Vocabulary-free on purpose: nothing in this control knows what an entry MEANS, so naming the
// fixture after any real-world entity would assert a domain the code does not have.
const ENTRIES = ['e-one', 'e-two', 'e-three']

const SOURCES = {
  // two sources — the case a token cannot represent at all
  'e-one': [
    { artifact: 'art-a', selector: 'col:x', title: 'raw' },
    { artifact: 'art-b', selector: 'col:x', title: 'normalized' },
  ],
  // one source
  'e-two': [{ artifact: 'art-a', selector: 'col:y', title: 'only' }],
  // U1: chosen and resolved to ZERO — deliberately spelled as an EMPTY array here and as an
  // ABSENT key in the test below, because from the user's side they are the same fact.
  'e-three': [],
}

/** `[{name, count}]` for whatever groups the fixture declares — the engine's own `groups`
 *  shape, so the heading counts under test come from the offer and not from a literal. */
function groupTotals(entries: unknown): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  if (Array.isArray(entries)) {
    for (const e of entries) {
      const g = (e as { group?: unknown })?.group
      if (typeof g === 'string' && g !== '') counts.set(g, (counts.get(g) ?? 0) + 1)
    }
  }
  return [...counts].map(([name, count]) => ({ name, count }))
}

function spec(over: Record<string, unknown> = {}): WidgetSpec {
  return {
    id: 'ents',
    kind: 'entry_list',
    label: 'Entries',
    entries: '$const.entries',
    sources: '$const.sources',
    value: '$state.picked',
    ...over,
  } as unknown as WidgetSpec
}

function mount(
  w: WidgetSpec,
  over: {
    picked?: string[]
    entries?: unknown
    sources?: unknown
    enabled?: unknown
    /** the ENGINE's "the entries were actually listed" answer — see the defect-B block. */
    browsable?: boolean
  } = {},
) {
  const entries = over.entries ?? ENTRIES
  const scope: Scope = {
    params: {},
    state: { picked: over.picked ?? [], enabled: over.enabled },
    derived: {},
    const: {
      entries,
      sources: over.sources ?? SOURCES,
      browsable: over.browsable,
      // The DECLARED group totals, derived from the fixture so a heading's `n of N` is checked
      // against the whole offer rather than against a hand-typed number that could drift.
      groups: groupTotals(entries),
    },
    data: {},
  }
  return render(<WidgetList specs={[w]} scope={scope} viewId="v" specId="t/spec" />)
}

/** Re-render the SAME mounted widget with a different offer — which is what a change of
 *  anchor, or of entry axis, looks like from inside this control: the binding produces a
 *  different array and the component is not remounted. `mount()` alone cannot express it. */
function remount(view: ReturnType<typeof mount>, w: WidgetSpec, entries: unknown): void {
  const scope: Scope = {
    params: {},
    state: { picked: [] },
    derived: {},
    const: { entries, sources: SOURCES, browsable: undefined, groups: groupTotals(entries) },
    data: {},
  }
  view.rerender(<WidgetList specs={[w]} scope={scope} viewId="v" specId="t/spec" />)
}

const entryRow = (key: string): HTMLElement => screen.getByTestId(`widget-ents-entry-${key}`)

describe('entry_list renders the THREE entry states distinctly (TEST-31 / TEST-A6, INV-6)', () => {
  it('unchosen · chosen-and-resolved · chosen-and-UNRESOLVED are three different rows', () => {
    mount(spec(), { picked: ['e-two', 'e-three'] })
    expect(entryRow('e-one').getAttribute('data-entry-state')).toBe('unchosen')
    expect(entryRow('e-two').getAttribute('data-entry-state')).toBe('resolved')
    expect(entryRow('e-three').getAttribute('data-entry-state')).toBe('unresolved')
  })

  it('a RESOLVED entry states how many sources it resolved to', () => {
    // The count is the fact a chip cannot carry, and it is the difference between "this plots
    // one column" and "this plots two".
    mount(spec(), { picked: ['e-one', 'e-two'] })
    expect(screen.getByTestId('widget-ents-count-e-one').textContent).toBe('2 sources')
    expect(screen.getByTestId('widget-ents-count-e-two').textContent).toBe('1 source')
  })

  it('U1 — an entry resolving to ZERO STAYS chosen and says so, in the view’s words', () => {
    // Dropping the choice instead would make "I picked it and nothing happened" identical to
    // "I never picked it", which is the one distinction the user needs in this state.
    mount(spec({ unresolved_text: 'no values on these rows' }), { picked: ['e-three'] })
    const row = entryRow('e-three')
    expect(row.getAttribute('data-entry-state')).toBe('unresolved')
    expect(screen.getByTestId('widget-ents-unresolved-e-three').textContent).toBe('no values on these rows')
    expect((screen.getByTestId('widget-ents-toggle-e-three') as HTMLElement).getAttribute('data-state')).not.toBe(
      'unchecked',
    )
  })

  it('an entry MISSING from the sources map is the same U1 state as one mapped to []', () => {
    // "no sources" and "no answer about sources" are indistinguishable from the user's side,
    // and a control that rendered them differently would be inventing a distinction.
    mount(spec(), { picked: ['e-one'], sources: {} })
    expect(entryRow('e-one').getAttribute('data-entry-state')).toBe('unresolved')
    expect(screen.getByTestId('widget-ents-unresolved-e-one').textContent).toBe(
      ENTRY_LIST_COPY.unresolved,
    )
  })

  it('the view’s `unresolved_text` beats the engine’s wording, and `empty_text` is a DIFFERENT string', () => {
    // They are different facts: "nothing is offered" vs "what you picked is not here". One
    // string for both would say the wrong one in whichever state it was not written for.
    mount(spec({ empty_text: 'this axis declares no entries' }), { entries: [] })
    expect(screen.getByTestId('widget-ents-empty').textContent).toBe('this axis declares no entries')
    expect(screen.queryByTestId('widget-ents-search')).toBeNull()
  })

  it('falls back to the ENGINE’s wording when the view declares none', () => {
    mount(spec(), { entries: [] })
    expect(screen.getByTestId('widget-ents-empty').textContent).toBe(ENTRY_LIST_COPY.empty)
  })
})

describe('entry_list search', () => {
  it('honours `search.placeholder` and narrows the list', () => {
    mount(spec({ search: { placeholder: 'Find an entry…' } }))
    const box = screen.getByTestId('widget-ents-search') as HTMLInputElement
    expect(box.getAttribute('placeholder')).toBe('Find an entry…')
    fireEvent.change(box, { target: { value: 'two' } })
    expect(screen.queryByTestId('widget-ents-entry-e-two')).not.toBeNull()
    expect(screen.queryByTestId('widget-ents-entry-e-one')).toBeNull()
  })

  it('a search matching nothing SAYS so rather than rendering an empty list', () => {
    mount(spec())
    fireEvent.change(screen.getByTestId('widget-ents-search'), { target: { value: 'zzz' } })
    expect(screen.getByTestId('widget-ents-no-match').textContent).toBe(ENTRY_LIST_COPY.noMatch)
    // and it is NOT the empty state — "nothing offered" and "nothing matched" are two facts
    expect(screen.queryByTestId('widget-ents-empty')).toBeNull()
  })

  it('a row is findable by its KEY, not only by what it displays', () => {
    // Someone who pasted an identifier must find its row even when the list is showing a
    // different annotation — the same rule ITEM-50 states for the section that hosts this
    // control, applied to the one key/label pair the control itself holds.
    const scope: Scope = {
      params: {},
      state: { picked: [] },
      derived: {},
      const: { labelled: [{ key: 'e-one', label: 'Displayed name' }] },
      data: {},
    }
    render(
      <WidgetList specs={[spec({ entries: '$const.labelled' })]} scope={scope} viewId="v" specId="t/spec" />,
    )
    fireEvent.change(screen.getByTestId('widget-ents-search'), { target: { value: 'e-one' } })
    expect(screen.queryByTestId('widget-ents-entry-e-one')).not.toBeNull()
  })
})

describe('entry_list per-source sub-toggles exist ONLY under disposition `each`', () => {
  const sourceToggle = (): HTMLElement | null => screen.queryByTestId('widget-ents-source-e-one-raw')

  it('`each` renders one sub-toggle per source', () => {
    mount(spec({ disposition: 'each' }), { picked: ['e-one'] })
    expect(sourceToggle()).not.toBeNull()
    expect(screen.queryByTestId('widget-ents-source-e-one-normalized')).not.toBeNull()
  })

  for (const disposition of ['combined', 'one', undefined]) {
    it(`does NOT render sub-toggles under ${String(disposition)}`, () => {
      // Under `combined` and `one` the sources are not separately addressable, so a toggle
      // would offer a choice that does not exist — worse than not offering it, because it
      // looks like it worked.
      mount(spec(disposition === undefined ? {} : { disposition }), { picked: ['e-one'] })
      expect(sourceToggle()).toBeNull()
      // the entry itself still renders, resolved, with its count
      expect(entryRow('e-one').getAttribute('data-entry-state')).toBe('resolved')
    })
  }

  it('a sub-toggle dispatches the SOURCE ADDRESS, never its title (INV-1)', async () => {
    const calls: Array<Record<string, unknown>> = []
    const localId = `srcToggle${Date.now()}`
    defineAction({
      id: `t/spec::${localId}`,
      title: localId,
      permission: 'jobs::use',
      mutating: true,
      params: z.object({}).passthrough(),
      run: async (p: Record<string, unknown>) => {
        calls.push(p)
      },
    })
    mount(spec({ disposition: 'each', onSourceChange: localId }), { picked: ['e-one'] })
    fireEvent.click(screen.getByTestId('widget-ents-source-e-one-raw'))
    await waitFor(() => expect(calls).toHaveLength(1))
    // `(artifact, selector)`, never `"raw"` — a title may be absent, repeat, or be renamed.
    expect(calls[0]).toMatchObject({ entry: 'e-one', source: 'art-a col:x', value: false })
  })

  it('an UNRESOLVED entry has no sub-toggles even under `each` — there is nothing to toggle', () => {
    mount(spec({ disposition: 'each' }), { picked: ['e-three'] })
    expect(screen.queryByTestId(/widget-ents-source-e-three/)).toBeNull()
  })
})

// ── DEFECT A (ledger 27) → TRUE WINDOWING (ledger 38) — REAL cardinality ────────────────
//
// The engine declares an axis browsable up to 200,000 entries, so an ordinary project hands
// this control tens of thousands of rows and the section that hosts it is one click from
// expanded. The list used to `shown.map(renderEntry)` all of them, each with a nested
// per-source `<ul>`. These tests drive the REAL widget at real cardinality and assert on the
// DOM it actually built — a test that asserted "the constant is 200" would restate the subject
// and would pass against the unwindowed list.
//
// ── WHY THIS BLOCK WAS REWRITTEN RATHER THAN DELETED (ledger #38) ───────────────────────
//
// The tests here used to assert the MOUNT BUDGET: "20,000 entries mount exactly one page of
// 200", "pressing Show-more mounts 200 more", "the count line names both numbers". The budget
// is gone — the owner asked for virtual scrolling with proper ARIA row indices, and the count
// line and its button went with it because an honest thumb already states the size. Asserting
// the budget would now be asserting a mechanism that was deliberately removed, so each of
// those tests is rewritten INTO the claim that survived it, and none is silently dropped:
//   · "mounts one page, not 20,000"    → mounts a WINDOW, not 35,477 (the bound survives).
//   · "the budget GROWS on request"    → the END IS REACHABLE, by scrolling and by End.
//   · "the count line names both"      → `aria-rowcount` names the full filtered set, and the
//                                        SCROLL TRACK is sized from it (the honest thumb).
//   · "search matches the whole set"   → unchanged in claim, re-driven against the window.
//   · "a group beyond the budget has no heading" → a group beyond the WINDOW has none, and is
//                                        reached by scrolling instead of by pressing.
// The one test with no successor is "a new query starts a fresh page": there is no page to
// reset. Its real content — a new answer starts at its top — is asserted below on the
// viewport's offset instead.

/** 35,477 — the owner's own axis, and the number the window has to stay responsive at. */
const BULK = 35_477
const bulkKeys = (n = BULK): string[] => Array.from({ length: n }, (_, i) => `k-${String(i).padStart(6, '0')}`)

/** How many ENTRY rows the document actually holds. The count the defect is about. */
const rowCount = (): number => document.querySelectorAll('[data-testid^="widget-ents-entry-"]').length

// ── jsdom HAS NO LAYOUT, and this virtualiser is made of layout ─────────────────────────
//
// The production virtualiser reads `offsetHeight` (viewport height, and each row's measured
// height), reads `scrollTop`, listens for `scroll`, and calls `scrollTo`. jsdom answers 0, 0, 0
// and "not implemented" respectively, so a window driven against stock jsdom would render one
// overscan block forever and every assertion below would be about jsdom's defaults instead of
// about the widget.
//
// So layout is STATED, and stated structurally: a row's height is computed from what that row
// actually rendered (its per-source sub-rows, its group heading), which is what makes the
// variable-height test a test of the widget rather than of a constant. This is the same device
// the pre-existing scroll test used when it defined `scrollHeight`/`clientHeight` on the box.
const VIEWPORT_H = 300
// The STATED row geometry is the widget's own estimate, so every offset assertion below is
// exact arithmetic rather than an approximation: a row measures what it was estimated to be, and
// a mismatch in a test is then a real mismatch. That the measurement is WIRED AT ALL — that a
// row which is not the height it was estimated to be corrects the track — is asserted
// separately, by `rowHeightOverride`, since these three constants cannot show it.
const ROW_H = ENTRY_ROW_ESTIMATE
const LINE_H = ENTRY_LINE_ESTIMATE
const HEADING_H = ENTRY_HEADING_ESTIMATE

/** When set, every row measures this instead — the seam that proves measurement beats estimate. */
let rowHeightOverride: number | null = null

function rowHeight(el: HTMLElement): number {
  if (rowHeightOverride !== null) return rowHeightOverride
  const subRows = el.querySelectorAll('li').length
  const heading = el.querySelector('[data-testid^="widget-ents-group-"]') === null ? 0 : HEADING_H
  return ROW_H + subRows * LINE_H + heading
}

let restoreLayout: (() => void) | null = null

const isViewport = (el: HTMLElement): boolean => el.hasAttribute('data-overlayscrollbars-viewport')

/** What the browser would compute for the scroller's content: the grid's own declared height,
 *  which is the virtualiser's total size — the number the honest thumb is derived from. */
function contentHeight(el: HTMLElement): number {
  const grid = el.querySelector<HTMLElement>('[role="grid"]')
  return grid === null ? 0 : Math.round(parseFloat(grid.style.height) || 0)
}

function statedLayout(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const saved = ['offsetHeight', 'clientHeight', 'scrollHeight'].map(
    k => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
  )
  const scrollTo = proto.scrollTo
  const define = (key: string, get: (el: HTMLElement) => number): void => {
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: HTMLElement): number {
        return get(this)
      },
    })
  }
  // The scroller's own box, and each row's real height. `scrollHeight`/`clientHeight` matter as
  // much as `offsetHeight`: the virtualiser clamps every programmatic scroll to
  // `scrollHeight - clientHeight`, so without them stated, jsdom answers 0 and EVERY
  // scroll-to-index silently lands at the top — a window that looks broken for a reason that
  // has nothing to do with the widget.
  define('offsetHeight', el =>
    isViewport(el) ? VIEWPORT_H : el.getAttribute('role') === 'row' ? rowHeight(el) : 0,
  )
  define('clientHeight', el => (isViewport(el) ? VIEWPORT_H : 0))
  define('scrollHeight', el => (isViewport(el) ? contentHeight(el) : 0))
  proto.scrollTo = function (this: HTMLElement, arg: unknown): void {
    const top = typeof arg === 'object' && arg !== null ? Number((arg as { top?: unknown }).top ?? 0) : 0
    this.scrollTop = Number.isFinite(top) ? top : 0
    this.dispatchEvent(new Event('scroll'))
  }
  restoreLayout = () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d)
      else delete proto[k]
    }
    proto.scrollTo = scrollTo
  }
}

// EVERY test in this file gets the stated layout: the list is a window now, and a window with
// no viewport height is a blank list, so a test running against stock jsdom would be asserting
// on an empty DOM rather than on the widget.
beforeEach(statedLayout)
afterEach(() => {
  restoreLayout?.()
  restoreLayout = null
  rowHeightOverride = null
})

/** The element that ACTUALLY scrolls — overlayscrollbars' own viewport, which is the node the
 *  virtualiser must be bound to and the node the "no native scrollbar" claim is about. */
const viewport = (): HTMLElement =>
  document.querySelector('[data-overlayscrollbars-viewport]') as HTMLElement

/** Scroll the real scroller, the way a wheel gesture does. */
function scrollTo(top: number): void {
  const vp = viewport()
  vp.scrollTop = top
  fireEvent.scroll(vp)
}

/** Every mounted row, in DOM order, as `[key, aria-rowindex]`. */
function windowRows(): Array<[string, number]> {
  return [...document.querySelectorAll('[data-testid^="widget-ents-row-"]')].map(el => [
    el.getAttribute('data-testid')!.replace('widget-ents-row-', ''),
    Number(el.getAttribute('aria-rowindex')),
  ])
}

describe('entry_list WINDOWS a set it cannot mount (defect A / ledger 38)', () => {
  it('35,477 entries mount a window of them, not 35,477 rows', () => {
    mount(spec({ value: undefined }), { entries: bulkKeys() })
    // The bound is the assertion. Reverting the window makes this 35,477.
    const mounted = rowCount()
    expect(mounted).toBeGreaterThan(0)
    // a 300px viewport of 30px rows is 10 rows, plus the overscan on each side
    expect(mounted).toBeLessThanOrEqual(VIEWPORT_H / ROW_H + ENTRY_LIST_OVERSCAN * 2 + 2)
  })

  it('a short list mounts entirely, and acquires no window furniture at all', () => {
    // The window must be invisible below its own size — otherwise every small list acquires a
    // "Showing 3 of 3" line that says nothing.
    mount(spec({ value: undefined }))
    expect(rowCount()).toBe(3)
    // The budget's own furniture is GONE, not merely absent on short lists — see the block
    // comment above. Both ids are asserted at BULK cardinality too, in the honesty test below.
    expect(screen.queryByTestId('widget-ents-showing')).toBeNull()
    expect(screen.queryByTestId('widget-ents-more')).toBeNull()
  })

  it('SEARCH still matches the WHOLE set — including an entry far beyond the mounted window', () => {
    // The regression a window invites: filter the mounted rows instead of the offer, and the
    // control silently answers a question about the first screenful.
    mount(spec({ value: undefined }), { entries: bulkKeys() })
    expect(screen.queryByTestId('widget-ents-entry-k-035476')).toBeNull() // not mounted
    fireEvent.change(screen.getByTestId('widget-ents-search'), { target: { value: 'k-035476' } })
    expect(screen.queryByTestId('widget-ents-entry-k-035476')).not.toBeNull()
    expect(screen.queryByTestId('widget-ents-no-match')).toBeNull()
    expect(rowCount()).toBe(1)
  })

  it('the per-source sub-lists are mounted only for MOUNTED rows', () => {
    // The nested `<ul>` is the multiplier: under `each` with a flat source list EVERY row gets
    // one, so an unwindowed list mounts 35,477 of them at once.
    mount(spec({ disposition: 'each', value: undefined, action: { label: 'Plot', onClick: 'noop' } }), {
      entries: bulkKeys(),
      sources: [
        { artifact: 'art-a', selector: 'col:x', title: 'raw' },
        { artifact: 'art-b', selector: 'col:x', title: 'normalized' },
      ],
    })
    // one ▶ per row + one per source of each mounted row, and not one more
    expect(document.querySelectorAll('[data-testid^="widget-ents-plot-"]').length).toBe(
      rowCount() * 3,
    )
  })

  it('GROUP HEADINGS count every match, not the part of the group inside the window', () => {
    // A heading that counted the window would say the axis is smaller than it is — the same
    // lie as a truncated list, moved into the heading.
    const entries = [
      ...Array.from({ length: 300 }, (_, i) => ({ key: `a-${i}`, group: 'alpha' })),
      ...Array.from({ length: 300 }, (_, i) => ({ key: `b-${i}`, group: 'beta' })),
    ]
    mount(spec({ value: undefined, grouped: true, groups: '$const.groups' }), { entries })
    // the first group's heading states its DECLARED total, though a screenful of it is mounted
    expect(screen.getByTestId('widget-ents-group-alpha').textContent).toBe('alpha · 300')
    // a group entirely beyond the WINDOW renders no heading — it is not mounted at all
    expect(screen.queryByTestId('widget-ents-group-beta')).toBeNull()
    // …and is reached by SCROLLING to it, which is what replaced pressing Show-more twice.
    // Row 301 (`b-0`) carries beta's heading; every row before it is 30px, alpha's own heading
    // adds 24px, so beta's row starts at 300*30 + 24.
    scrollTo(300 * ROW_H + HEADING_H)
    expect(screen.getByTestId('widget-ents-group-beta').textContent).toBe('beta · 300')
  })

  it('the GRID is focusable and named, so the list is reachable without a mouse', () => {
    // A window that put the rows in a scroll container nobody can focus would make the list
    // strictly less accessible than the unwindowed one it replaced. The focusable element is
    // the grid rather than the outer box now: the scroller is overlayscrollbars' viewport, and
    // focus INSIDE it is what makes it keyboard-scrollable.
    mount(spec({ value: undefined }), { entries: bulkKeys() })
    const grid = screen.getByTestId('widget-ents-grid')
    expect(grid.getAttribute('tabindex')).toBe('0')
    expect(grid.getAttribute('aria-label')).toBe('Entries')
    expect(grid.getAttribute('role')).toBe('grid')
  })
})

// ── THE A11Y CONTRACT — the objection the budget was chosen to avoid, DONE ──────────────
//
// The file header used to argue that a window "tells a screen reader a different row count from
// the one the DOM holds". That is the failure these tests exist to make impossible, and they
// are driven WITH A FILTER APPLIED on purpose: with no filter, a row's index in the window and
// its index in the set coincide at the top of the list, so an implementation that reported the
// WINDOW's numbers would pass. Under a filter, and scrolled, the three numbers — window
// position, filtered-set index, and offered-set index — are all different, and only one of them
// is the right answer.

describe('entry_list states the FILTERED SET in aria-rowcount / aria-rowindex (ledger 38)', () => {
  /** `k-012` matches k-012000…k-012999 — exactly 1,000 of the 35,477 offered. */
  const QUERY = 'k-012'
  const MATCHES = 1_000

  const filtered = (): HTMLElement => {
    mount(spec({ value: undefined }), { entries: bulkKeys() })
    fireEvent.change(screen.getByTestId('widget-ents-search'), { target: { value: QUERY } })
    return screen.getByTestId('widget-ents-grid')
  }

  it('aria-rowcount is the FULL FILTERED SET while only a window is mounted', () => {
    const grid = filtered()
    expect(grid.getAttribute('aria-rowcount')).toBe(String(MATCHES))
    // …and the DOM holds a fraction of it. Both halves matter: the count without the window is
    // an ordinary list, and the window without the count is the defect.
    expect(rowCount()).toBeLessThan(MATCHES)
    expect(rowCount()).toBeGreaterThan(0)
    // It is the FILTERED set, not the offered one — a control reporting the offer would say
    // 35,477 here, which is a truthful number about the wrong question.
    expect(grid.getAttribute('aria-rowcount')).not.toBe(String(BULK))
  })

  it('a rendered row’s aria-rowindex is its index in the FILTERED SET, not in the window', () => {
    const grid = filtered()
    // Scroll 400 rows into the 1,000 matches. Now the first MOUNTED row is nowhere near row 1,
    // which is what makes this assertion non-vacuous.
    scrollTo(400 * ROW_H)
    const rows = windowRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const [key, rowindex] of rows) {
      // `k-030407` is the 408th match — 1-based, in the filtered set.
      const inFilteredSet = Number(key.slice(QUERY.length)) + 1
      expect(rowindex).toBe(inFilteredSet)
    }
    // The window's own first row is index 0; the set index it reports is not 1.
    expect(rows[0][1]).toBeGreaterThan(300)
    expect(Number(grid.getAttribute('aria-rowcount'))).toBe(MATCHES)
  })

  it('the attributes sit on roles that make them LEGAL — row inside grid, never a bare li', () => {
    // `aria-rowindex` on an `<li>` in a `<ul>` is ignored, so the markup changed rather than
    // the attributes. This is the assertion that a future "let's go back to a list" cannot pass.
    const grid = filtered()
    const row = grid.querySelector('[aria-rowindex]') as HTMLElement
    expect(row.getAttribute('role')).toBe('row')
    expect(row.tagName).not.toBe('LI')
    // grid > rowgroup > row, and the row owns a gridcell
    expect(row.parentElement!.getAttribute('role')).toBe('rowgroup')
    expect(row.parentElement!.parentElement).toBe(grid)
    expect(row.querySelector('[role="gridcell"]')).not.toBeNull()
  })
})

// ── NO NATIVE SCROLLBAR, and the thumb is the honesty signal ────────────────────────────
//
// Ledger #38's second half: *"Also do not use native scroll bar please"*. The list scrolls
// inside the kit `ScrollArea` (overlayscrollbars) — the house pattern — and NOT in a native
// `overflow-y-auto` box, which is what it used to be.
//
// The thumb is what makes the removed "Showing 200 of 35,477" line redundant, so its arithmetic
// is asserted rather than assumed: the track the thumb is proportioned against is the FULL
// filtered set's height, not the mounted window's.

describe('entry_list scrolls through overlayscrollbars, with a thumb sized by the FULL set', () => {
  it('the element that actually scrolls is the overlayscrollbars viewport, not a native box', () => {
    mount(spec({ value: undefined }), { entries: bulkKeys() })
    const host = screen.getByTestId('widget-ents-scroll')
    expect(host.hasAttribute('data-overlayscrollbars-initialize')).toBe(true)
    const vp = viewport()
    expect(vp).not.toBeNull()
    expect(host.contains(vp)).toBe(true)
    // overlayscrollbars' own statement that the NATIVE bar is suppressed on the scroller.
    expect(vp.getAttribute('data-overlayscrollbars-viewport')).toContain('scrollbarHidden')
    // its custom bar exists, so "no native scrollbar" did not become "no scrollbar"
    expect(host.querySelector('.os-scrollbar-vertical .os-scrollbar-handle')).not.toBeNull()
    // and no native scroll box survives anywhere inside the widget
    const widget = screen.getByTestId('widget-ents')
    for (const el of widget.querySelectorAll<HTMLElement>('*')) {
      if (el.hasAttribute('data-overlayscrollbars-viewport')) continue
      expect(el.className.toString()).not.toMatch(/overflow-(y-)?(auto|scroll)/)
      expect(el.style.overflowY === 'auto' || el.style.overflowY === 'scroll').toBe(false)
    }
  })

  it('the scroll track is the FULL filtered set’s height — which is what makes the thumb honest', () => {
    mount(spec({ value: undefined }), { entries: bulkKeys() })
    const grid = screen.getByTestId('widget-ents-grid')
    const trackOf = (): number => Math.round(parseFloat(grid.style.height))
    // 35,477 rows of 30px. A track sized from the WINDOW would be ~570px, and the thumb would
    // fill the bar — the list would look ~60 rows long while holding 35,477.
    expect(trackOf()).toBe(BULK * ROW_H)

    // …and it TRACKS the filter, which is the same arithmetic seen from the other side: the
    // thumb must grow when the answer narrows. `k-012` matches exactly 1,000.
    fireEvent.change(screen.getByTestId('widget-ents-search'), { target: { value: 'k-012' } })
    expect(trackOf()).toBe(1_000 * ROW_H)
  })

  it('the "Showing N of M" line and its "Show more" button are GONE, at full cardinality', () => {
    // They were the budget's honesty signal. The thumb is now, and ledger #38 asks for one
    // statement rather than two — so their absence is asserted where they used to appear.
    mount(spec({ value: undefined }), { entries: bulkKeys() })
    expect(screen.queryByTestId('widget-ents-showing')).toBeNull()
    expect(screen.queryByTestId('widget-ents-more')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Show \d/)
  })

  it('VARIABLE-HEIGHT rows are windowed at their real heights, not at one assumed height', () => {
    // A row under disposition `each` with two sources carries a nested sub-list, so it is
    // 30 + 2×20 = 70px rather than 30px. A fixed-height virtualiser would place row N at 30N
    // and the list would drift out from under its own scrollbar — 40px per row, i.e. off by a
    // whole screen within a dozen rows.
    mount(spec({ disposition: 'each', value: undefined, action: { label: 'Plot', onClick: 'noop' } }), {
      entries: bulkKeys(),
      sources: [
        { artifact: 'art-a', selector: 'col:x', title: 'raw' },
        { artifact: 'art-b', selector: 'col:x', title: 'normalized' },
      ],
    })
    const grid = screen.getByTestId('widget-ents-grid')
    const tall = ROW_H + 2 * LINE_H
    // the track is sized from the MEASURED row, not from the plain-row estimate
    expect(Math.round(parseFloat(grid.style.height))).toBe(BULK * tall)
    // …and an offset lands on the row that is really there: 100 tall rows down is row 101, and
    // the window opens ENTRY_LIST_OVERSCAN rows above it. Under a fixed 28px assumption the row
    // at that offset would be 243, i.e. the list would be showing somewhere else entirely.
    scrollTo(100 * tall)
    expect(windowRows().map(r => r[1])).toContain(101)
    expect(windowRows()[0][1]).toBe(101 - ENTRY_LIST_OVERSCAN)
  })

  it('a row that is NOT the height it was estimated to be corrects the track', () => {
    // The estimate is a first guess; the measurement is the answer. Without `measureElement`
    // wired to the row, the track would stay at the guess forever and the thumb would be wrong
    // by the ratio between them — here 50/28, i.e. the list would claim to be about half its
    // real length.
    rowHeightOverride = 50
    mount(spec({ value: undefined }), { entries: bulkKeys(200) })
    const grid = screen.getByTestId('widget-ents-grid')
    const track = Math.round(parseFloat(grid.style.height))
    // Only the rows that have been MOUNTED are measured; the rest are still the guess, so the
    // track sits between the two — which is exactly what a measured virtualiser produces, and
    // is already enough to falsify a widget that never measures (whose track would be the pure
    // estimate, to the pixel).
    expect(track).toBeGreaterThan(200 * ENTRY_ROW_ESTIMATE)
    expect(track).toBeLessThanOrEqual(200 * 50)
  })
})

// ── KEYBOARD — a focused row must survive leaving the window ────────────────────────────

describe('entry_list keyboard traversal crosses the window boundary without losing focus', () => {
  it('arrowing past the last MOUNTED row moves focus to the next row of the SET', () => {
    mount(spec({ value: undefined }), { entries: bulkKeys() })
    const grid = screen.getByTestId('widget-ents-grid')
    grid.focus()
    const window0 = rowCount()
    // Far enough that the destination cannot have been mounted when the traversal started —
    // that is the boundary this test is about.
    const steps = window0 + 20
    for (let i = 0; i < steps; i++) fireEvent.keyDown(grid, { key: 'ArrowDown' })

    const focused = document.activeElement as HTMLElement
    expect(focused.getAttribute('role')).toBe('row')
    // 0-based moves from row 1 ⇒ aria-rowindex is steps + 1
    expect(focused.getAttribute('aria-rowindex')).toBe(String(steps + 1))
    expect(grid.contains(focused)).toBe(true)
    // exactly one row is in the tab order, and it is that one
    const tabbable = [...grid.querySelectorAll('[role="row"][tabindex="0"]')]
    expect(tabbable).toEqual([focused])
  })

  it('End reaches the END OF THE SET — the property the Show-more control used to carry', () => {
    mount(spec({ value: undefined }), { entries: bulkKeys() })
    const grid = screen.getByTestId('widget-ents-grid')
    grid.focus()
    fireEvent.keyDown(grid, { key: 'End' })
    const focused = document.activeElement as HTMLElement
    expect(focused.getAttribute('aria-rowindex')).toBe(String(BULK))
    expect(screen.queryByTestId('widget-ents-entry-k-035476')).not.toBeNull()
    // and Home comes back
    fireEvent.keyDown(grid, { key: 'Home' })
    expect((document.activeElement as HTMLElement).getAttribute('aria-rowindex')).toBe('1')
  })
})

// ── DEFECT B (ledger 28) — an over-budget axis is not an EMPTY axis ─────────────────────

describe('entry_list distinguishes REFUSED from EMPTY (defect B)', () => {
  it('says NOTHING when the engine did not list the entries — the refusal is the one sentence', () => {
    // The shipped surface printed the section's refusal ("this axis has 4,100,000 entries")
    // and this control's `empty_text` ("lists no entries") side by side: two sentences, one of
    // them false. With no listing there is nothing for this control to say.
    mount(spec({ browsable: '$const.browsable', empty_text: 'this axis lists no entries' }), {
      entries: [],
      browsable: false,
    })
    expect(screen.queryByTestId('widget-ents-empty')).toBeNull()
    expect(screen.queryByTestId('widget-ents')).toBeNull()
    expect(screen.queryByTestId('widget-ents-search')).toBeNull()
  })

  it('still says it when the axis WAS listed and genuinely holds nothing', () => {
    // The other half of the distinction: gating the claim must not delete it.
    mount(spec({ browsable: '$const.browsable', empty_text: 'this axis lists no entries' }), {
      entries: [],
      browsable: true,
    })
    expect(screen.getByTestId('widget-ents-empty').textContent).toBe('this axis lists no entries')
  })

  it('an undeclared `browsable` leaves every existing view exactly as it was', () => {
    mount(spec({ empty_text: 'this axis lists no entries' }), { entries: [] })
    expect(screen.getByTestId('widget-ents-empty').textContent).toBe('this axis lists no entries')
  })
})

describe('the ▶ names its row UNAMBIGUOUSLY (ITEM-30 / ITEM-58)', () => {
  // A display name may legitimately be CONTESTED — that is what the engine's `qualifier` and
  // its always-qualified `title` exist for. Naming the button from the displayed `label` gave
  // a screen-reader user two controls called the same thing, which is the very failure the
  // per-row naming rule was written against, one step later than "forty rows called Plot".
  const CONTESTED = [
    { key: 'x1', label: 'Shared', title: 'Shared (alpha)' },
    { key: 'x2', label: 'Shared', title: 'Shared (beta)' },
    { key: 'u', label: 'Unique', title: 'Unique' },
  ]
  const plotSpec = (over: Record<string, unknown> = {}): WidgetSpec =>
    spec({ value: undefined, action: { label: 'Plot', onClick: 'noop' }, ...over })
  const name = (testid: string): string | null =>
    screen.getByTestId(testid).getAttribute('aria-label')

  it('two rows DISPLAYING the same name still expose two distinct accessible names', () => {
    mount(plotSpec(), { entries: CONTESTED })
    const a = name('widget-ents-plot-x1')
    const b = name('widget-ents-plot-x2')
    expect(a).toBe('Plot Shared (alpha)')
    expect(b).toBe('Plot Shared (beta)')
    expect(a).not.toBe(b)
  })

  it('an UNCONTESTED row reads exactly as it did — the qualifier is not noise on every row', () => {
    // The positive control: the fix must not turn every button into a qualified mouthful.
    mount(plotSpec(), { entries: CONTESTED })
    expect(name('widget-ents-plot-u')).toBe('Plot Unique')
  })

  it('the per-source ▶ inherits the row’s disambiguated name, not its displayed one', () => {
    // TWO sources, and that is a REQUIREMENT of this test now rather than an incidental
    // fixture choice (owner, 2026-08-13). A per-source sub-row is rendered only where a row
    // genuinely resolves to more than one source: with one, the sub-row printed the same
    // string under every entry in the list and carried a second ▶ doing what the row's own
    // already did. The naming rule under test here is unchanged and still has to hold, so the
    // fixture moves to the case where the sub-rows exist at all.
    mount(plotSpec({ disposition: 'each' }), {
      entries: CONTESTED,
      sources: [
        { artifact: 'art-a', selector: 'col:x', title: 'raw' },
        { artifact: 'art-b', selector: 'col:x', title: 'normalized' },
      ],
    })
    expect(name('widget-ents-plot-x1-raw')).toBe('Plot Shared (alpha) — raw')
    expect(name('widget-ents-plot-x2-raw')).toBe('Plot Shared (beta) — raw')
    expect(name('widget-ents-plot-x1-normalized')).toBe('Plot Shared (alpha) — normalized')
  })
})

describe('entry_list choice', () => {
  it('ticking an entry dispatches the NEW key list, and unticking removes it', async () => {
    const calls: Array<Record<string, unknown>> = []
    const localId = `setEnts${Date.now()}`
    defineAction({
      id: `t/spec::${localId}`,
      title: localId,
      permission: 'jobs::use',
      mutating: true,
      params: z.object({}).passthrough(),
      run: async (p: Record<string, unknown>) => {
        calls.push(p)
      },
    })
    mount(spec({ onChange: localId }), { picked: ['e-two'] })
    fireEvent.click(screen.getByTestId('widget-ents-toggle-e-one'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].value).toEqual(['e-two', 'e-one'])

    cleanup()
    mount(spec({ onChange: localId }), { picked: ['e-two', 'e-one'] })
    fireEvent.click(screen.getByTestId('widget-ents-toggle-e-two'))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].value).toEqual(['e-one'])
  })
})

// ── a NEW ANSWER starts at its top; a RENAMED one does not move ─────────────────────────
//
// This block used to be about the mount budget surviving a change of OFFER. The budget is gone,
// but the claim under it is not: the reader's POSITION is now the thing that must not survive a
// replaced list and must survive a relabelled one. Same identity rule (the offer's KEYS), same
// control test, asserted on the viewport's offset rather than on a row count.

describe('the reader’s position across a replaced offer, and across a new query', () => {
  it('a NEW offer returns the reader to the top — page 400 of one axis is not page 400 of the next', () => {
    const w = spec({ value: undefined })
    const view = mount(w, { entries: bulkKeys() })
    scrollTo(400 * ROW_H)
    expect(windowRows()[0][1]).toBeGreaterThan(300)

    // A DIFFERENT list — different keys, as a different anchor or a different entry axis
    // produces. The component is not remounted; only its binding changed.
    remount(view, w, bulkKeys(BULK).map(k => `x-${k}`))
    expect(viewport().scrollTop).toBe(0)
    expect(windowRows()[0][1]).toBe(1)
  })

  it('CONTROL: relabelling the SAME entries does NOT move the reader', () => {
    // The identity is the offer's KEYS. Changing the displayed annotation renames every row and
    // offers the same list, so throwing the reader back to the top would punish them for
    // renaming what they are looking at — and a reset keyed on the array reference (which
    // `toEntries` rebuilds every render) would fire on EVERY render, pinning the list at row 1.
    const w = spec({ value: undefined })
    const keys = bulkKeys()
    const view = mount(w, { entries: keys })
    scrollTo(400 * ROW_H)
    const before = windowRows()[0][1]
    expect(before).toBeGreaterThan(300)

    remount(view, w, keys.map(k => ({ key: k, label: `renamed ${k}` })))
    expect(viewport().scrollTop).toBe(400 * ROW_H)
    expect(windowRows()[0][1]).toBe(before)
  })

  it('a new QUERY starts its answer at the top', () => {
    // The successor of "a new query starts a fresh page": there is no page to reset, but an
    // answer of twelve rows must not open scrolled to where 35,477 rows used to be.
    mount(spec({ value: undefined }), { entries: bulkKeys() })
    scrollTo(400 * ROW_H)
    fireEvent.change(screen.getByTestId('widget-ents-search'), { target: { value: 'k-012' } })
    expect(viewport().scrollTop).toBe(0)
    expect(windowRows()[0][1]).toBe(1)
  })
})

// ── A3 REACHES THE SCREEN (ledger 62) ──────────────────────────────────────────────────
//
// The resolver-side fields are well covered in `axisEntryRows.test.ts`. Nothing asserted that
// any of them reaches a user: a blind mutation deleted the whole mark span from the widget and
// 55 tests passed. A fact computed and never rendered is the same as a fact not computed.

// ── REWRITTEN (owner, ledger #28 + #29) ────────────────────────────────────────────────
//
// A `describe('the per-source A3 mark is RENDERED, and only where the engine marked it')` block
// stood here with two cases: a MIXED offer marks the undeclared source and leaves the other
// clean, and a NOTHING-marked offer renders nothing. They pinned `EntryListSource.alignment_mark`
// — a field that is gone with the marks themselves.
//
// The block is rewritten to what it was also proving and never said: THE SOURCES ARE RENDERED.
// The old fixture's two-source row is kept verbatim minus the mark, so the case is the same
// case; what is asserted is that both sources still appear, are still individually addressable,
// and that nothing in the rendered list mentions alignment. The obvious wrong reading of
// "remove the alignment not declared" is to drop the unaligned source, and it would go red here.
describe('every source the engine offers is rendered, and none is marked (ledger #28 + #29)', () => {
  /** The MIXED offer's shape, as the engine hands it over — one source that declares its
   *  alignment and one that does not, now indistinguishable in the payload as on the screen. */
  const MIXED = {
    'e-one': [
      { artifact: 'art-a', selector: 'col:x', title: 'raw' },
      { artifact: 'art-b', selector: 'col:x', title: 'normalized' },
    ],
  }

  it('renders BOTH sources of a row, each with its own ▶, and marks neither', () => {
    mount(spec({ disposition: 'each', action: { label: 'Plot', icon: 'plot', onClick: 'plot' } }), {
      picked: ['e-one'],
      sources: MIXED,
    })
    // Both are there, and both are separately pressable — which is what `each` means and what a
    // dropped source would take away.
    expect(screen.getByTestId('widget-ents-plot-e-one-raw')).toBeTruthy()
    expect(screen.getByTestId('widget-ents-plot-e-one-normalized')).toBeTruthy()
    // …and no mark, on either, from any field.
    expect(document.querySelectorAll('[data-testid^="widget-ents-alignment-"]')).toHaveLength(0)
    expect(document.body.textContent ?? '').not.toMatch(/alignment/i)
  })

  it('a source carrying a stray `alignment_mark` still renders nothing — the field is retired', () => {
    // The NEGATIVE control, and the one that makes this block worth keeping: an engine (or a
    // fixture, or a half-reverted branch) that puts the old field back must not resurrect the
    // rendering. The widget reads no such field any more, and that is asserted rather than
    // assumed.
    const stale = {
      'e-one': [{ artifact: 'art-a', selector: 'col:x', title: 'raw', alignment_mark: 'alignment not declared' }],
    }
    mount(spec({ disposition: 'each' }), { picked: ['e-one'], sources: stale })
    expect(document.body.textContent ?? '').not.toMatch(/alignment not declared/i)
  })
})

// ── THE CLASS THE OWNER REPORTED, asserted on the RENDERED DOM ─────────────────────────
//
// The shipped the entry section rendered, UNDER EVERY ENTRY, a sub-row naming the source it would
// plot — and every entry in an ordinary project resolves to the same one source, so 18,000
// rows carried one identical string in the slot whose whole job is to tell one row from the
// next. Each of those sub-rows also carried its own ▶, so every entry had TWO controls doing
// one thing. Meanwhile the mockup's own per-row discriminator — the entry's OTHER annotation,
// inline beside the name — was not rendered at all: the constant was added and the variable
// was dropped.
//
// Both halves are asserted as a CLASS over whatever the list rendered, not as three named
// selectors. An earlier audit of this very list inspected it and reported *"the per-source
// qualifier is only rendered where contested, already correct"*; a per-instance test would have
// agreed with that audit. So the rule is stated over the DOM: no text may repeat on every row
// in a distinguishing slot, and no row may hold two controls for one verb.

/** Every entry row currently mounted, as elements. */
function mountedRows(): HTMLElement[] {
  return ENTRIES.map(k => screen.queryByTestId(`widget-ents-entry-${k}`)).filter(
    (e): e is HTMLElement => e !== null,
  )
}

const PLOT_ACTION = { label: 'Plot', onClick: 'noop', args: {} }

describe('the entry section renders nothing that is identical on every row (owner, 2026-08-13)', () => {
  it('a ONE-SOURCE list carries no per-source sub-row and exactly ONE control per row', () => {
    // The owner's shape: every entry resolves to the SAME single source. The sub-list is the
    // thing under test, so `disposition: each` is declared — under any other disposition it
    // never rendered and the test would pass vacuously.
    const oneEach = { 'e-one': [SOURCES['e-two'][0]], 'e-two': [SOURCES['e-two'][0]], 'e-three': [SOURCES['e-two'][0]] }
    mount(spec({ disposition: 'each', value: undefined, action: PLOT_ACTION }), { sources: oneEach })

    const rows = mountedRows()
    expect(rows.length).toBe(ENTRIES.length)
    for (const row of rows) {
      // ONE verb, one control. Two ▶ on a row is the same act offered twice.
      expect(row.querySelectorAll('button').length).toBe(1)
      // …and the source's own name is nowhere on the row: it is the same word on all of them.
      expect(row.textContent ?? '').not.toContain(SOURCES['e-two'][0].title)
    }
  })

  it('THE CLASS — no substring is repeated in every row of the list', () => {
    const oneEach = Object.fromEntries(ENTRIES.map(k => [k, [SOURCES['e-two'][0]]]))
    mount(spec({ disposition: 'each', value: undefined, action: PLOT_ACTION }), { sources: oneEach })

    // Every WORD each row renders, minus the row's own identity. A word present in EVERY row
    // is a constant of the list, and it is occupying a slot meant to distinguish.
    const words = mountedRows().map(
      row => new Set((row.textContent ?? '').split(/[\s·—()]+/).map(w => w.trim()).filter(w => w.length > 2)),
    )
    expect(words.length).toBeGreaterThan(1)
    const everywhere = [...words[0]].filter(w => words.every(s => s.has(w)))
    expect(everywhere, `these words appear in EVERY row: ${everywhere.join(', ')}`).toEqual([])
  })

  it('POSITIVE CONTROL — an entry that genuinely has TWO sources still names them', () => {
    // The rule is "print what distinguishes", not "print less". `e-one` resolves to two
    // sources, so which one a picture came from IS the information — the sub-rows and their
    // per-source ▶ come back, and only for that entry. Without this control the assertions
    // above would be satisfied by a list that had simply stopped saying anything.
    mount(spec({ disposition: 'each', value: undefined, action: PLOT_ACTION }))

    const two = entryRow('e-one')
    expect(two.textContent).toContain(SOURCES['e-one'][0].title)
    expect(two.textContent).toContain(SOURCES['e-one'][1].title)
    // One control for the row plus one per source.
    expect(two.querySelectorAll('button').length).toBe(1 + SOURCES['e-one'].length)

    // …and the single-source entry beside it is untouched by that: one control, no names.
    const one = entryRow('e-two')
    expect(one.querySelectorAll('button').length).toBe(1)
    expect(one.textContent ?? '').not.toContain(SOURCES['e-two'][0].title)
  })
})

describe('the entry section shows the row’s OTHER annotation inline (the mockup’s `CD3E  ENSG…`)', () => {
  /** Entries in the engine's own row shape: a displayed name plus the annotations that name is
   *  one of. `values[0]` is the displayed one; `values[1]` is the other name. */
  const NAMED = [
    { key: 'k-1', label: 'alpha', values: [{ title: 'Name', value: 'alpha' }, { title: 'Accession', value: 'ACC-0001' }] },
    { key: 'k-2', label: 'beta', values: [{ title: 'Name', value: 'beta' }, { title: 'Accession', value: 'ACC-0002' }] },
  ]

  it('renders the second annotation on the row, and it VARIES per row', () => {
    mount(spec({ value: undefined, action: PLOT_ACTION }), { entries: NAMED })
    const shown = NAMED.map(e => screen.getByTestId(`widget-ents-second-${e.key}`).textContent)
    expect(shown).toEqual(NAMED.map(e => e.values[1].value))
    // The whole reason it belongs on the row: it is the thing that differs.
    expect(new Set(shown).size).toBe(NAMED.length)
  })

  it('does NOT render it when it merely repeats the name', () => {
    // A row reading `alpha  alpha` spends the slot on a constant of the ROW — the same defect
    // one scale down from a constant of the list.
    mount(spec({ value: undefined, action: PLOT_ACTION }), {
      entries: [{ key: 'k-1', label: 'alpha', values: [{ title: 'Name', value: 'alpha' }, { title: 'Alias', value: 'alpha' }] }],
    })
    expect(screen.queryByTestId('widget-ents-second-k-1')).toBeNull()
  })
})

describe('the second annotation never repeats what a heading already said', () => {
  // FOUND BY LOOKING AT THE CAPTURE, not by an assertion — the first shot of this section showed
  // `RNA` beside all three rows sitting under a heading that read `RNA`. The row's own group is
  // stated once, above it; repeating it per row is the reported defect at group scale, added by
  // the fix for that same defect at list scale.
  const GROUPED = [
    { key: 'g-1', label: 'alpha', group: 'RNA', values: [{ title: 'Name', value: 'alpha' }, { title: 'Panel', value: 'RNA' }] },
    { key: 'g-2', label: 'beta', group: 'RNA', values: [{ title: 'Name', value: 'beta' }, { title: 'Panel', value: 'RNA' }] },
  ]

  it('suppresses an annotation that merely restates the row’s GROUP', () => {
    mount(spec({ value: undefined, action: PLOT_ACTION, grouped: '$const.grouped' }), { entries: GROUPED })
    for (const e of GROUPED) expect(screen.queryByTestId(`widget-ents-second-${e.key}`)).toBeNull()
  })

  it('POSITIVE CONTROL — an annotation that is NOT the group is still shown', () => {
    // Without this, "suppress the group" would be satisfied by suppressing everything.
    const withAccession = GROUPED.map((e, i) => ({
      ...e,
      values: [...e.values, { title: 'Accession', value: `ACC-000${i + 1}` }],
    }))
    mount(spec({ value: undefined, action: PLOT_ACTION, grouped: '$const.grouped' }), { entries: withAccession })
    const shown = withAccession.map(e => screen.getByTestId(`widget-ents-second-${e.key}`).textContent)
    expect(shown).toEqual(['ACC-0001', 'ACC-0002'])
    expect(new Set(shown).size).toBe(shown.length)
  })
})

// ── THE SECOND LINE (dimension-membership ITEM-10) ───────────────────────────────────────────
//
// A whole SENTENCE about the entry relative to what the pane is framed on, on its own line
// beneath the name.
//
// It exists because the resolver had been sending the sentence as a THIRD `values` annotation
// since ITEM-10 landed, where nothing rendered it: the inline slot above shows exactly ONE
// value by design, so the figure was computed, carried, searchable — and invisible on screen.
// Every unit test of the resolver was green throughout, and the e2e tier is what caught it.
// So the class is pinned HERE, at the surface that renders, and not only at the one that
// computes.
describe('the row’s SECOND LINE — a sentence, not a third annotation', () => {
  const NOTED = [
    { key: 'n-1', label: 'alpha', note: 'describes all 40 rows', values: [{ title: 'Name', value: 'alpha' }] },
    { key: 'n-2', label: 'beta', note: 'describes 20 of 40 rows', values: [{ title: 'Name', value: 'beta' }] },
  ]

  it('renders the note on its own line, per row', () => {
    mount(spec({ value: undefined, action: PLOT_ACTION }), { entries: NOTED })
    const shown = NOTED.map(e => screen.getByTestId(`widget-ents-note-${e.key}`).textContent)
    expect(shown).toEqual(NOTED.map(e => e.note))
  })

  it('an entry declaring NO note renders no line at all', () => {
    // Every row of the sibling entry-axis section, and every row of every project that has
    // produced no membership. A
    // blank line on each of them would spend the row's height on nothing.
    mount(spec({ value: undefined, action: PLOT_ACTION }), {
      entries: [{ key: 'n-1', label: 'alpha', values: [{ title: 'Name', value: 'alpha' }] }],
    })
    expect(screen.queryByTestId('widget-ents-note-n-1')).toBeNull()
  })

  it('the note does NOT also take the inline annotation slot, and a real annotation still does', () => {
    // The resolver puts the sentence in the search corpus as well (so `40` finds these rows),
    // which without the guard would print the same string twice on any row whose annotation
    // slot is otherwise empty. The second entry is the positive control: an annotation that is
    // NOT the note keeps the inline slot, so "never show the note inline" is not satisfied by
    // showing nothing inline.
    mount(spec({ value: undefined, action: PLOT_ACTION }), {
      entries: [
        { key: 'n-1', label: 'alpha', note: 'describes all 40 rows', values: [{ title: 'Name', value: 'alpha' }, { title: 'Rows', value: 'describes all 40 rows' }] },
        { key: 'n-2', label: 'beta', note: 'describes all 40 rows', values: [{ title: 'Name', value: 'beta' }, { title: 'Shape', value: '2 levels' }, { title: 'Rows', value: 'describes all 40 rows' }] },
      ],
    })
    expect(screen.queryByTestId('widget-ents-second-n-1')).toBeNull()
    expect(screen.getByTestId('widget-ents-note-n-1').textContent).toBe('describes all 40 rows')
    expect(screen.getByTestId('widget-ents-second-n-2').textContent).toBe('2 levels')
  })
})
