// TEST-518 (ITEM-55) + TEST-527 (ITEM-60) — the placement engine routes contributed views
// to ALL dock areas (not only bottom), `center` is a first-class dock area, and the tail
// registry gaps (render-strategy / layout-options) each resolve through a REGISTRY lookup
// rather than a hardcoded list. Pure logic → the node runner.
//
// ITEM-35 deleted the third tail gap (`collections`): the registry had ZERO contributors,
// its BE surface never landed, and THIS test was `listCollections`'s only importer — a
// reader whose only reader was its own test.

import { describe, expect, it } from 'vitest'
import type { Contributions, DatatypeLattice, ViewContribution, WhenContext } from '@/modules/workbench/core'
import { placeViews } from './placement'
import { DOCK_AREAS, defaultProjectLayout } from './types'
import { layoutOptions } from './registryTail'
import { selectRenderStrategy } from './renderStrategies'

const LATTICE = { isA: () => false, matches: () => false, get: () => undefined } as unknown as DatatypeLattice
const CTX: WhenContext = { producedTypeIds: [] }

function view(id: string, area: ViewContribution['area']): ViewContribution {
  return {
    id,
    extensionId: 'test',
    apiVersion: '1.0.0',
    title: id,
    area,
    render: { component: `ui/${id}` },
  }
}

/** A minimal `Contributions` exposing just the registries the units read. */
function fakeRegistry(views: ViewContribution[]): Contributions {
  return { views: { all: () => views } } as unknown as Contributions
}

describe('placeViews routes to ALL dock areas (TEST-518 / ITEM-55)', () => {
  const views = [
    view('workbench.canvas', 'center'), // the ONE whitelisted center view (the canvas GridWorkspace)
    view('visualize', 'left'),
    view('inspector', 'right'),
    view('results', 'bottom'),
  ]
  const reg = fakeRegistry(views)

  it('places a view into each of left / right / center / bottom (not only bottom)', () => {
    expect(placeViews(reg, 'left', CTX, LATTICE).map(v => v.id)).toEqual(['visualize'])
    expect(placeViews(reg, 'right', CTX, LATTICE).map(v => v.id)).toEqual(['inspector'])
    expect(placeViews(reg, 'center', CTX, LATTICE).map(v => v.id)).toEqual(['workbench.canvas'])
    expect(placeViews(reg, 'bottom', CTX, LATTICE).map(v => v.id)).toEqual(['results'])
  })

  it('an out-of-vocabulary area places nothing for a valid area (no cross-placement)', () => {
    // No 'left' view leaks into 'center' etc.
    expect(placeViews(reg, 'center', CTX, LATTICE).some(v => v.area !== 'center')).toBe(false)
  })

  it('ITEM-15: a stray NON-canvas area:center contribution is rejected LOUD at the placement seam', () => {
    // Any analysis/JS-authored view claiming the reserved center (other than the canvas) throws —
    // so no analysis can ever tab beside the canvas. Enforced at placeViews, not only the fan.
    const rogue = fakeRegistry([view('workbench.canvas', 'center'), view('rogue.analysis', 'center')])
    expect(() => placeViews(rogue, 'center', CTX, LATTICE)).toThrow(/may not declare area "center"/)
    // A center-reserving analysis can't sneak in via ANOTHER requested area either (the filter runs
    // over ALL contributed views regardless of the queried area).
    expect(() => placeViews(rogue, 'bottom', CTX, LATTICE)).toThrow(/may not declare area "center"/)
  })

  it('`center` is a first-class DockArea + DockState member', () => {
    expect(DOCK_AREAS).toContain('center')
    expect(defaultProjectLayout().center).toEqual({ collapsed: false, size: expect.any(Number) })
  })
})

describe('tail registry gaps resolve through a registry (TEST-527 / ITEM-60)', () => {
  it('a ViewHost render-strategy is classified by its render-union shape', () => {
    expect(selectRenderStrategy({ component: 'ui/x' })).toBe('named')
    expect(selectRenderStrategy({ component: (() => null) as never })).toBe('component')
    expect(selectRenderStrategy({ iframe: 'about:blank' })).toBe('iframe')
    expect(selectRenderStrategy({ spec: {} })).toBe('spec')
  })

  it('LAYOUT_OPTIONS come from the layout registry', () => {
    expect(layoutOptions().map(o => o.value)).toEqual(['single', 'split'])
    // The values look up through the registry, so a new mode registered would appear here.
    expect(layoutOptions().every(o => typeof o.label === 'string')).toBe(true)
  })
})

// ── TEST-7 (visualize-pane ITEM-2): a registered SECTION never reaches placement ────────
//
// INV-12 — "A section is not a view." The proof this file can give is the runtime one:
// drive a FULL placement pass with sections registered and observe that the placed view
// set is byte-identical to the pass without them, in every dock area. If a section ever
// acquired an `area` and leaked into `registry.views`, the `center` case below would throw
// (`assertContributableArea`) rather than merely differ — which is the fail-LOUD half.

describe('TEST-7: a section is not a view (visualize-pane ITEM-2 / INV-12)', () => {
  const views = [view('workbench.canvas', 'center'), view('inspector', 'right')]

  /** Sections carry a `pane`, never an `area`, so they are shaped so as NOT to be placeable. */
  const sections = [
    { id: 'sec.alpha', extensionId: 'viz.pkg', apiVersion: '1.0.0', title: 'Alpha', pane: 'visualize', views: [] },
    { id: 'sec.beta', extensionId: 'viz.pkg', apiVersion: '1.0.0', title: 'Beta', pane: 'visualize', views: [] },
  ]

  function withSections(): Contributions {
    return {
      views: { all: () => views },
      sections: { all: () => sections },
    } as unknown as Contributions
  }

  it('placeViews is unchanged in EVERY area by the presence of registered sections', () => {
    const before = fakeRegistry(views)
    const after = withSections()
    for (const area of DOCK_AREAS) {
      expect(placeViews(after, area, CTX, LATTICE).map(v => v.id)).toEqual(
        placeViews(before, area, CTX, LATTICE).map(v => v.id),
      )
    }
  })

  it('no section id appears in any placed area — including the reserved centre', () => {
    const reg = withSections()
    const placed = DOCK_AREAS.flatMap(area => placeViews(reg, area, CTX, LATTICE).map(v => v.id))
    for (const s of sections) expect(placed).not.toContain(s.id)
    // Positive control: the pass DID place something, so the assertion above is not vacuous.
    expect(placed).toContain('workbench.canvas')
  })
})
