// @vitest-environment jsdom
//
// TEST-8 / TEST-9 (stack half) / TEST-76 [covers: visualize-pane ITEM-3, ITEM-4, ITEM-62]
//
// `SectionStack` is `DeclarativeStack` minus the run band, so the assertions below are
// mostly about STRUCTURE — one scroll track for the pane (not one per section), the
// readable-width `RegionBody` inside it, one `DeclarativeRegion` per declared `ui:` file,
// every section inside the HOST's frame, and no `AnalysisRunListHost`.
//
// `DeclarativeRegion` is stubbed. It is a large live host (store mount coordinator, catalog
// fetch, interpreter, the whole widget layer) and none of that is what this file is about:
// the question here is how many of them the stack renders and where, which a stub answers
// exactly and a real one answers slowly and flakily. Its own behaviour is covered where it
// lives.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent, within } from '@testing-library/react'

vi.mock('@/modules/workbench/core/render/DeclarativeRegion', () => ({
  DeclarativeRegion: ({ view, canvasOrder }: { view: { view_id: string }; canvasOrder?: number }) => (
    <div data-testid={`decl-region-${view.view_id}`} data-canvas-order={canvasOrder}>
      {view.view_id}
    </div>
  ),
}))

// The workbench CONTEXT is the injection boundary this component reads from, and it is
// mocked here rather than driven through the real `WorkbenchProvider`: the real provider
// resolves `producedTypeIds` and the catalog epoch from a live realtime/API path, none of
// which this file is about. The unit under test is never mocked — only what is handed to it.
let CTX: Record<string, unknown> = {}
vi.mock('./WorkbenchContext', () => ({
  useWorkbench: () => CTX,
  useWhenContext: () => ({ producedTypeIds: (CTX as { producedTypeIds: string[] }).producedTypeIds }),
}))

import { DatatypeRegistry } from '@/core/datatypes'
import type { Datatype, DatatypeLattice, SectionContribution } from '@/modules/workbench/core'
import { SectionStack } from './SectionStack'
import { workbenchRegionsStore } from './regions/WorkbenchRegions.store'

// ── the REAL lattice ────────────────────────────────────────────────────────────────────
//
// Deliberately NOT `fakeLattice`/`identityLattice`: both IGNORE `capabilities` and return
// true, so a capability-only `applies_to` — the exact selector shape a Visualize section
// uses — would pass this file vacuously. The real `DatatypeRegistry` is the one that
// actually implements `caps.every(...)`.
const dt = (id: string, capabilities: string[]): Datatype =>
  ({ id, extends: null, title: id, description: '', storage: {}, capabilities, viewers: [] }) as unknown as Datatype

function realLattice(): DatatypeLattice {
  const reg = new DatatypeRegistry()
  reg.replaceAll([dt('projection', ['plottable-xy']), dt('grouping', [])])
  return {
    isA: (sub, sup) => reg.isA(sub, sup),
    matches: (id, sel) => reg.matches(id, sel as Parameters<typeof reg.matches>[1]),
    get: id => reg.get(id) as ReturnType<DatatypeLattice['get']>,
  }
}

// A control that proves the lattice is honouring capabilities at all — if this ever
// returned true, every availability assertion below would be meaningless.
it('guard: the injected lattice really evaluates capabilities (not a permissive fake)', () => {
  expect(realLattice().matches('grouping', { capabilities: ['plottable-xy'] })).toBe(false)
  expect(realLattice().matches('projection', { capabilities: ['plottable-xy'] })).toBe(true)
})

function section(over: Partial<SectionContribution> & { id: string }): SectionContribution {
  return {
    extensionId: 'viz.pkg',
    apiVersion: '1.0.0',
    title: over.id,
    pane: 'visualize',
    views: [{ view_id: `${over.id}/v`, view_spec: { id: `${over.id}/v` } as never }],
    ...over,
  }
}

function mount(sections: SectionContribution[], producedTypeIds = ['projection']) {
  CTX = {
    api: { registry: { sections: { all: () => sections } } },
    projectId: 'p1',
    viewId: 'wb',
    canEdit: true,
    producedTypeIds,
    lattice: realLattice(),
    backendArch: 'x86_64',
    refreshCatalog: () => {},
    catalogEpoch: 0,
  }
  return render(<SectionStack pane="visualize" />)
}

beforeEach(() => {
  workbenchRegionsStore.getState().reset()
})
afterEach(cleanup)

describe('SectionStack (ITEM-3)', () => {
  it('renders ONE scroll track for the whole pane, not one per section', () => {
    mount([section({ id: 'alpha', order: 10 }), section({ id: 'gamma', order: 20 })])
    // The track is the STACK's. Two sections, one track — a per-section scroller would give
    // a 260px rail a column of small independent viewports each with its own bar.
    expect(screen.getAllByTestId('section-track-visualize')).toHaveLength(1)
    // …and the readable-width cap sits on the CONTENT inside the track, never on the
    // scroller itself (a capped scroller draws its bar mid-pane — `RegionBody`'s header).
    const body = screen.getByTestId('section-body-visualize')
    expect(body.className).toContain('max-w-lg')
    expect(body.className).toContain('gap-3')
    expect(body.className).not.toContain('overflow')
  })

  it('renders one DeclarativeRegion per declared `ui:` file, in declaration order', () => {
    const two = section({ id: 'gamma' })
    two.views = [
      { view_id: 'gamma/a', view_spec: { id: 'gamma/a' } as never },
      { view_id: 'gamma/b', view_spec: { id: 'gamma/b' } as never },
    ]
    mount([two])
    const frame = screen.getByTestId('section-frame-gamma')
    const rendered = within(frame)
      .getAllByTestId(/^decl-region-/)
      .map(el => el.getAttribute('data-testid'))
    expect(rendered).toEqual(['decl-region-gamma/a', 'decl-region-gamma/b'])
  })

  it('wraps EVERY section in the host frame — TEST-9\'s stack half', () => {
    mount([section({ id: 'alpha', order: 10 }), section({ id: 'gamma', order: 20 })])
    // A section cannot forget to have chrome, because the chrome is not the section's.
    for (const id of ['alpha', 'gamma']) {
      expect(screen.getByTestId(`section-frame-${id}`)).toBeTruthy()
      expect(screen.getByTestId(`section-drag-handle-${id}`)).toBeTruthy()
    }
  })

  it('honours each section\'s declared `collapsed` default', () => {
    mount([section({ id: 'alpha', order: 10 }), section({ id: 'beta', order: 30, collapsed: true })])
    expect(screen.getByRole('button', { name: 'alpha' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'beta' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('has NO run band — the whole structural difference from DeclarativeStack', () => {
    mount([section({ id: 'alpha' })])
    // An analysis pane's band renders a run list; a section pane launches nothing, so an
    // empty band would be a permanently empty affordance rather than a quiet one.
    expect(screen.queryByTestId(/analysis-run-list/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/No runs yet/i)
  })

  it('stacks sections in resolved order, and the saved user order wins', () => {
    const list = [section({ id: 'alpha', order: 10 }), section({ id: 'beta', order: 30 })]
    const { unmount } = mount(list)
    const order = () => screen.getAllByTestId(/^section-frame-/).map(el => el.getAttribute('data-testid'))
    expect(order()).toEqual(['section-frame-alpha', 'section-frame-beta'])
    unmount()

    workbenchRegionsStore.getState().ensureProject('p1')
    workbenchRegionsStore.getState().setSectionOrder('visualize', ['beta'])
    mount(list)
    expect(order()).toEqual(['section-frame-beta', 'section-frame-alpha'])
  })

  it('filters by PANE — a section belonging to another stack is not rendered', () => {
    mount([section({ id: 'alpha' }), section({ id: 'elsewhere', pane: 'datasets' })])
    expect(screen.queryByTestId('section-frame-elsewhere')).toBeNull()
    expect(screen.getByTestId('section-frame-alpha')).toBeTruthy()
  })

  it('filters by `applies_to`, evaluated against the REAL capability-aware lattice', () => {
    const list = [
      section({ id: 'alpha', appliesTo: [{ capabilities: ['plottable-xy'] }] }),
      section({ id: 'needs-something-else', appliesTo: [{ capabilities: ['tracks'] }] }),
    ]
    mount(list, ['projection'])
    expect(screen.getByTestId('section-frame-alpha')).toBeTruthy()
    expect(screen.queryByTestId('section-frame-needs-something-else')).toBeNull()
  })

  it('states WHICH emptiness it is when no section applies, rather than rendering a blank rail', () => {
    mount([section({ id: 'alpha', appliesTo: [{ capabilities: ['tracks'] }] })], ['projection'])
    expect(screen.getByTestId('section-stack-visualize-empty')).toBeTruthy()
    expect(screen.queryByTestId('section-track-visualize')).toBeNull()
  })
})

// ── TEST-76 (ITEM-62): composition adds; arbitration discards ──────────────────────────

describe('SectionStack — composition, not arbitration (ITEM-62 / INV-20)', () => {
  it('two PACKAGES contributing a section for the same data yield BOTH, stacked', () => {
    const a = section({ id: 'pkgA.alpha', order: 10, appliesTo: [{ capabilities: ['plottable-xy'] }] })
    const b = section({ id: 'pkgB.alpha', order: 20, appliesTo: [{ capabilities: ['plottable-xy'] }] })
    b.extensionId = 'another-package'
    mount([a, b], ['projection'])
    // Neither is arbitrated away, and neither is deduped on "same applies_to".
    expect(screen.getAllByTestId(/^section-frame-/).map(el => el.getAttribute('data-testid'))).toEqual([
      'section-frame-pkgA.alpha',
      'section-frame-pkgB.alpha',
    ])
  })
})


// ── TEST-43 (ITEM-31b), the wiring half: the stack states WHERE its plots belong ────────
//
// The fold's own rule — rows read in the declared position, not in first-publish order — is
// pinned in `extensions/canvas/canvasComposition.test.ts`. What is asserted here is the half
// only the stack can supply: the position itself, which is the ARRANGEMENT, which is the
// user's. A correct fold fed a constant would still put a dragged block's plots in the wrong
// row and nothing would fail.

describe('SectionStack hands each view its canvas position (TEST-43 / ITEM-31b)', () => {
  const positions = () =>
    screen.getAllByTestId(/^decl-region-/).map(el => [el.getAttribute('data-testid'), el.getAttribute('data-canvas-order')])

  it('positions views in FLATTENED stack order, across sections and within one', () => {
    const two = section({ id: 'beta', order: 30 })
    two.views = [
      { view_id: 'beta/a', view_spec: { id: 'beta/a' } as never },
      { view_id: 'beta/b', view_spec: { id: 'beta/b' } as never },
    ]
    mount([section({ id: 'alpha', order: 10 }), two])
    expect(positions()).toEqual([
      ['decl-region-alpha/v', '0'],
      ['decl-region-beta/a', '1'],
      ['decl-region-beta/b', '2'],
    ])
  })

  it('the SAVED user order moves the positions with the blocks — what a drag does', () => {
    const list = [section({ id: 'alpha', order: 10 }), section({ id: 'beta', order: 30 })]
    workbenchRegionsStore.getState().ensureProject('p1')
    workbenchRegionsStore.getState().setSectionOrder('visualize', ['beta'])
    mount(list)
    // `beta` is first in the rail, so its plots are first down the canvas. Before this wiring the
    // rail moved and the canvas did not.
    expect(positions()).toEqual([
      ['decl-region-beta/v', '0'],
      ['decl-region-alpha/v', '1'],
    ])
  })
})

// ── REORDERING: the drop's MEANING, and the two ways to ask for one ────────────────────────
//
// These drive the REAL drag. `SectionStack` calls the real `startPointerDrag`, which installs
// real window listeners and resolves the drop through the real `attributeAtPoint` — the only
// thing standing in for the browser is `document.elementFromPoint`, which jsdom does not
// implement and which is, by construction, the one input the whole drop resolution turns on.
// Stubbing it is stating "the pointer is over THIS element"; everything after that is the
// component's own code, including the part being asserted.
//
// The e2e (TEST-15) drags with a MOUSE and can therefore see none of this: the self-drop it
// never performs (it always drags onto the other section's box) and the `pointercancel` a
// mouse never emits.

/** The LAYOUT the drop is resolved against — three 100px sections, 12px apart (`gap-3`), in a
 *  400px track. jsdom lays nothing out and returns all-zero rects, so geometry is the one input
 *  supplied by hand; everything downstream of it is the component's own code. Midpoints are 50,
 *  160 and 270, so every coordinate below can be read off this table. */
const LAYOUT: Record<string, [number, number]> = { alpha: [0, 100], beta: [110, 210], gamma: [220, 320] }
const TRACK: [number, number] = [0, 400]

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, x: 0, y: top, width: 100, height: bottom - top, toJSON: () => ({}) } as DOMRect
}

/** Give the mounted stack the layout above. Applied to the ELEMENTS, so a reorder carries each
 *  section's box with it exactly as a real layout would. */
function layOut() {
  for (const [id, [top, bottom]] of Object.entries(LAYOUT)) {
    const el = box(id)
    if (el) el.getBoundingClientRect = () => rect(top, bottom)
  }
  const track = document.querySelector('[data-testid="section-track-visualize"]')
  if (track) track.getBoundingClientRect = () => rect(TRACK[0], TRACK[1])
}

/** A pointer event carrying a real button + real coordinates.
 *
 *  `fireEvent.pointerDown(el, { button: 0, clientX })` cannot be used: jsdom ships no
 *  `PointerEvent`, so testing-library falls back to a bare `Event` and SILENTLY DROPS both —
 *  the handler then sees `button: undefined`, the primitive declines the press as non-primary,
 *  and every assertion about a drag passes vacuously because no drag ever happened. `MouseEvent`
 *  does exist and does carry them, so it is what the browser's pointer stream stands in as. */
function pointer(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
}
const press = (grip: Element) => fireEvent(grip, pointer('pointerdown', 50, 5))
const move = (y: number) => fireEvent(window, pointer('pointermove', 50, y))

/** A complete pointer drag from a section's grip, released at `y` in the layout above. */
function dragTo(id: string, y: number) {
  press(screen.getByTestId(`section-drag-handle-${id}`))
  layOut()
  move(y) // past the 4px threshold; below it the primitive reports a CLICK and no drop happens
  fireEvent(window, pointer('pointerup', 50, y))
}

const box = (id: string) => document.querySelector(`[data-section-id="${id}"]`)
const order = () => screen.getAllByTestId(/^section-frame-/).map(el => el.getAttribute('data-testid')?.slice('section-frame-'.length))

const THREE = () => [section({ id: 'alpha', order: 10 }), section({ id: 'beta', order: 20 }), section({ id: 'gamma', order: 30 })]

/** A guard on the harness itself: if a drag can be refused (a dropped `button`, a missed
 *  threshold), every "nothing moved" assertion in this file passes for the wrong reason. */
it('guard: the harness really drives a drag (a refused press would pass every no-op test)', () => {
  mount(THREE())
  dragTo('alpha', 380)
  expect(order()).toEqual(['beta', 'gamma', 'alpha'])
})

describe('SectionStack reorder — every pixel of the list means something', () => {
  it('released over ITS OWN section (either half): NOTHING moves', () => {
    // A section box wraps the section's whole EXPANDED body, so a short drag ordinarily never
    // leaves it. Read as "no target ⇒ append", that gesture silently sent the section to the
    // bottom — the commonest drag in the pane producing the most surprising result.
    mount(THREE())
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
    dragTo('beta', 120)
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
    dragTo('beta', 200)
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
    expect(workbenchRegionsStore.getState().sectionOrder.visualize ?? []).not.toContain('beta')
  })

  it('released in the GAP between two sections: it lands THERE, not at the bottom', () => {
    // The gap is over no section. That is not "nowhere" — it is a boundary, and the most
    // literal statement of intent the gesture has.
    mount(THREE())
    dragTo('gamma', 105)
    expect(order()).toEqual(['alpha', 'gamma', 'beta'])
  })

  it('released BELOW the last section: appends — and the gesture is reachable at all', () => {
    // The container is the scroll TRACK, so the empty space under the last section is inside
    // the list. Scoped to the section column it is not, and this release resolved to nothing.
    mount(THREE())
    dragTo('alpha', 380)
    expect(order()).toEqual(['beta', 'gamma', 'alpha'])
  })

  it('released OUTSIDE the track entirely: NOTHING moves', () => {
    mount(THREE())
    dragTo('alpha', 500)
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('the LOWER half of the next section moves a section down exactly ONE place', () => {
    // Insert-before-only made a downward drag off by one: released over the section directly
    // below, nothing happened, and the user had to aim at the one after it.
    mount(THREE())
    dragTo('alpha', 200)
    expect(order()).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('shows the boundary it will ACTUALLY use, and takes it away on release', () => {
    // The floating ghost says only WHAT is being dragged. The indicator says WHERE — and it is
    // drawn from the same slot number the drop uses, so the promise and the outcome cannot
    // disagree (they used to: the line was painted above the hovered section while the release
    // resolved to an append).
    mount(THREE())
    press(screen.getByTestId('section-drag-handle-alpha'))
    layOut()

    // over beta's LOWER half ⇒ the boundary between beta and gamma…
    move(200)
    const indicator = screen.getByTestId('section-drop-indicator-visualize')
    expect(box('gamma')?.contains(indicator)).toBe(true)
    expect(indicator.getAttribute('data-drop-edge')).toBe('top')

    // …below everything ⇒ the boundary after the last section…
    move(380)
    const last = screen.getByTestId('section-drop-indicator-visualize')
    expect(box('gamma')?.contains(last)).toBe(true)
    expect(last.getAttribute('data-drop-edge')).toBe('bottom')

    // …and over its own box ⇒ nothing promised, because nothing would happen.
    move(50)
    expect(screen.queryByTestId('section-drop-indicator-visualize')).toBeNull()

    move(200)
    fireEvent(window, pointer('pointerup', 50, 200))
    expect(screen.queryByTestId('section-drop-indicator-visualize')).toBeNull()
    // …and it landed on the boundary it drew.
    expect(order()).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('the indicator adds no HEIGHT — it must not move the boxes it is measured against', () => {
    // An in-flow line pushes every section below it down mid-drag, changing the very geometry
    // the next move resolves against: the indicator would chase itself down the list.
    mount(THREE())
    press(screen.getByTestId('section-drag-handle-alpha'))
    layOut()
    move(200)
    const style = screen.getByTestId('section-drop-indicator-visualize').className
    expect(style).toContain('absolute')
    expect(box('gamma')?.className).toContain('relative')
    fireEvent(window, pointer('pointerup', 50, 200))
  })

  it('a CANCELLED drag moves nothing and leaves no indicator behind', () => {
    // `pointercancel` is the touch reality (the scroller claims the pointer, a second finger
    // lands); the grip is a 44px touch target, so this is a path real users are on.
    mount(THREE())
    press(screen.getByTestId('section-drag-handle-alpha'))
    layOut()
    move(200)
    expect(screen.getByTestId('section-drop-indicator-visualize')).toBeTruthy()

    fireEvent(window, pointer('pointercancel', 50, 200))
    expect(screen.queryByTestId('section-drop-indicator-visualize')).toBeNull()
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])

    // The release the user\'s hand makes afterwards is not this drag\'s drop.
    fireEvent(window, pointer('pointerup', 50, 200))
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
  })
})

// ── the arrangement is reachable WITHOUT a pointer ─────────────────────────────────────────
//
// The handle was a `role="button"` carrying a pointer listener and nothing else: a per-user
// setting the entire pane is read against, reachable by mouse and touch and by no other means —
// and a button announcing itself to a screen reader while doing nothing on Enter is worse than
// no button at all.

const status = () => screen.getByTestId('section-reorder-status-visualize').textContent ?? ''

describe('SectionStack reorder — the keyboard path', () => {
  it('picks up, moves, and drops a section with the keyboard alone, announcing each step', () => {
    mount(THREE())
    const grip = screen.getByTestId('section-drag-handle-alpha')
    expect(grip.getAttribute('aria-pressed')).toBe('false')
    // The instructions are ON the control, so the affordance is discoverable rather than folklore.
    const help = document.getElementById(grip.getAttribute('aria-describedby') ?? '')
    expect(help?.textContent).toMatch(/pick this section up/i)

    fireEvent.keyDown(grip, { key: 'Enter' })
    expect(grip.getAttribute('aria-pressed')).toBe('true')
    expect(status()).toMatch(/alpha picked up, position 1 of 3/i)

    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(order()).toEqual(['beta', 'alpha', 'gamma'])
    expect(status()).toMatch(/alpha moved to position 2 of 3/i)

    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(order()).toEqual(['beta', 'gamma', 'alpha'])

    // Dropping COMMITS — the arrangement stays where the user put it.
    fireEvent.keyDown(grip, { key: ' ' })
    expect(grip.getAttribute('aria-pressed')).toBe('false')
    expect(status()).toMatch(/alpha dropped at position 3 of 3/i)
    expect(order()).toEqual(['beta', 'gamma', 'alpha'])
  })

  it('ESCAPE puts the section back where it was picked up from', () => {
    mount(THREE())
    const grip = screen.getByTestId('section-drag-handle-gamma')
    fireEvent.keyDown(grip, { key: 'Enter' })
    fireEvent.keyDown(grip, { key: 'ArrowUp' })
    expect(order()).toEqual(['alpha', 'gamma', 'beta'])

    fireEvent.keyDown(grip, { key: 'Escape' })
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
    expect(grip.getAttribute('aria-pressed')).toBe('false')
    expect(status()).toMatch(/move canceled/i)
  })

  it('refuses the ends OUT LOUD — silence is indistinguishable from a key that did not register', () => {
    mount(THREE())
    const grip = screen.getByTestId('section-drag-handle-alpha')
    fireEvent.keyDown(grip, { key: 'Enter' })
    fireEvent.keyDown(grip, { key: 'ArrowUp' })
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
    expect(status()).toMatch(/already at position 1 of 3/i)
  })

  it('does nothing on the arrows until the section is PICKED UP', () => {
    // Bare arrows would fight the pane's own scrolling, and would leave the user no way to say
    // "I am done" — so the pickup brackets the move. The refusal is asserted, not assumed.
    mount(THREE())
    fireEvent.keyDown(screen.getByTestId('section-drag-handle-alpha'), { key: 'ArrowDown' })
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('SectionStack reorder — the keyboard path survives its own reorder', () => {
  /** the browser\'s "focus has settled" point, which is when the blur handler asks its question. */
  const settle = () => act(async () => { await Promise.resolve() })

  it('KEEPS the pickup across the blur a reorder causes, and moves again', async () => {
    // React reorders keyed children by MOVING the DOM nodes, and moving a node containing the
    // focused element blurs it. jsdom does not do that, so the browser\'s blur is supplied by
    // hand here — the sequence is otherwise the real one. Without the fix the first arrow moved
    // the section, the blur ended the pickup, and the second arrow was a silent no-op: the user
    // pressed Down twice and it moved once, with nothing said about why.
    mount(THREE())
    const grip = screen.getByTestId('section-drag-handle-alpha')
    grip.focus()
    fireEvent.keyDown(grip, { key: 'Enter' })

    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    fireEvent.blur(grip) // ← what the node move does in a real browser
    await settle()

    expect(order()).toEqual(['beta', 'alpha', 'gamma'])
    expect(grip.getAttribute('aria-pressed')).toBe('true')

    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    await settle()
    expect(order()).toEqual(['beta', 'gamma', 'alpha'])
  })

  it('PUTS THE FOCUS BACK on the handle after a move, so the next key reaches it', async () => {
    // The other half, and the one that matters even with the pickup preserved: focus lands on
    // `<body>` when the node moves, and keys delivered to the body reach no handler at all.
    mount(THREE())
    const grip = screen.getByTestId('section-drag-handle-alpha')
    grip.focus()
    fireEvent.keyDown(grip, { key: 'Enter' })

    // Focus lost, exactly as the reorder loses it …
    grip.blur()
    expect(document.activeElement).not.toBe(grip)
    // … and the move puts it back, in the same commit.
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(grip)

    await settle()
    expect(grip.getAttribute('aria-pressed')).toBe('true')
  })

  it('still ENDS the pickup when the user genuinely leaves the handle', async () => {
    // The round-1 rule, kept: otherwise the mode outlives the focus that started it, and a user
    // who tabs away and returns later moves a section by pressing an arrow.
    mount(THREE())
    const grip = screen.getByTestId('section-drag-handle-alpha')
    grip.focus()
    fireEvent.keyDown(grip, { key: 'Enter' })
    expect(grip.getAttribute('aria-pressed')).toBe('true')

    grip.blur() // focus really is gone, and nothing puts it back
    fireEvent.blur(grip)
    await settle()

    expect(grip.getAttribute('aria-pressed')).toBe('false')
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(order()).toEqual(['alpha', 'beta', 'gamma'])
  })
})
