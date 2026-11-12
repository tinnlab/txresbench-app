// @vitest-environment jsdom
//
// canvasContributionRetire.test.tsx — RETIRING ONE VIEW'S CONTRIBUTION IS NOT TEARING THE CANVAS
// DOWN, and the two must not share a teardown.
//
// Since contributions became per-view, the canvas has two distinct shrinking events and they are
// answered in different places:
//
//   · a pane CLOSES while others stay open — `declarativeMount.destroy` retires that view from the
//     feed, the remaining contributions recompose, and the ONE shared controller is re-driven with
//     the smaller option. `applyOption` acquires the new set BEFORE releasing the previous one, so
//     the closed view's slice drops out and every surviving view's is carried straight through,
//     under the identity it already had. Nothing is abandoned here, so nothing here may dispose;
//   · the canvas itself goes — the last contribution retires (the composed feed goes inactive), an
//     explicit-prop controller is replaced, or the view unmounts. `CanvasView` calls
//     `teardownCanvas` and nulls its reference, so that controller will never be driven again. That
//     is the one that must release, and `canvasTeardown.test.ts` is where that is asserted.
//
// Conflating them — retiring one contribution taking the whole canvas with it — is the defect the
// per-view contribution map was introduced to fix, and hanging a release on the retirement path is
// how it would come back. So the survivor is pinned from both sides:
//
//   · through the REAL `CanvasView` + `DeclarativeRegion`, that closing one pane leaves the other
//     pane's plot resolved and on the canvas. Read off `window.__canvasPanes`, which reports the row
//     count from the viz `DatasetStore` the grid renders from — the feed's own resolver always
//     answers with current data, so an assertion that stops there passes with the canvas blank;
//   · and on the drive path alone, with no mounted grid, that the SHARED controller carries the
//     surviving slice across the recompose under the SAME generation. A mounted grid takes a
//     reference of its own, which is enough to hold an entry up through a controller that was
//     disposed and immediately rebuilt — so the controller's own ref-keeping is only visible when it
//     is the one holder. It is worth seeing: a dataset identity is also a selection space, and
//     re-minting it silently discards whatever is keyed to it.

import { act } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVizStores, defaultVizStores, installBuiltins, VizController, type DatasetResolver } from '@txresbench/viz'
import { createWorkbenchApi } from '@/modules/workbench/core'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { makeFakeHost } from '@/modules/workbench/core/host/createHost'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
import { DeclarativeRegion } from '@/modules/workbench/core/render/DeclarativeRegion'
import {
  destroy as destroyDeclarativeMount,
  __resetDeclarativeMountsForTests,
} from '@/modules/workbench/core/render/declarativeMount'
// The registration side effect: the canvas host is installed by the extensions barrel, exactly as
// it is on the real mount path.
import '@/modules/workbench/extensions'
import { CanvasView } from './CanvasView'
import { driveCanvas } from './canvasBinding'
import { resolveDeclarativeCanvas } from './canvasFeed'
import { declarativeCanvas } from './declarativeCanvasFeed.store'

installBuiltins()

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  // jsdom ships no canvas backend, so every `getContext` call logs a "Not implemented" trace that
  // buries the real output. `null` is the SAME answer the code already acts on — `webglAvailable`
  // falls back to the headless render, and the in-grid legend painter returns early — so this
  // silences noise without moving the test onto a different path.
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

const PROJECT = 'canvas-contribution-retire'
const VIEW_IDS = ['view-a', 'view-b'] as const

/** Neutral columns — a declaration binds by name, so what they are called carries no meaning. */
const FRAME = { depth: [10, 20, 30, 40], fraction: [1, 2, 3, 4] }

function specWith(id: string, coordId: string): ViewSpec {
  return {
    id,
    title: id,
    permission: 'studies::use',
    state: {},
    widgets: [],
    actions: [],
    canvas: {
      datasets: [{ id: 'frame' }],
      grid: [],
      series: [
        {
          id: `s-${coordId}`,
          type: 'violin',
          coordId,
          datasetId: 'frame',
          title: `${coordId} title`,
          encode: { valueKey: 'depth' },
        },
      ],
    },
  } as unknown as ViewSpec
}

interface Pane {
  id: string
  viewId: string | null
  rows: number | null
  datasetKey: string | null
}

/** What the canvas grid is actually showing, straight off the shipped read-only seam. */
function panes(): Pane[] {
  const seam = (window as unknown as { __canvasPanes?: () => Pane[] }).__canvasPanes
  return seam?.() ?? []
}

const paneNamed = (id: string): Pane | undefined => panes().find(p => p.id === id)

/** How many holders the viz store counts on the slice a pane is bound to. */
function holdersOf(paneId: string): number | undefined {
  const key = paneNamed(paneId)?.datasetKey
  return key ? defaultVizStores.datasetStore.getState().getEntry(key)?.refCount : undefined
}

/** Let the effects' async `setOption` settle (resolve → catalog → store write). */
async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

const apiFor = (viewId: string) => createWorkbenchApi(makeFakeHost({ projectId: PROJECT }), `retire-${viewId}`)

/** The always-mounted centre canvas — one controller for every contributing view, as in the shell. */
async function mountCanvas(): Promise<() => void> {
  let unmount = (): void => {}
  await act(async () => {
    const r = render(
      <WorkbenchProvider api={apiFor('canvas')} projectId={PROJECT} viewId="canvas" canEdit>
        <CanvasView />
      </WorkbenchProvider>,
    )
    unmount = r.unmount
  })
  await settle()
  return unmount
}

/** Mount ONE declarative pane the way the shell does; the returned fn is its region unmount. */
async function mountPane(spec: ViewSpec, viewId: string): Promise<() => void> {
  let unmount = (): void => {}
  await act(async () => {
    const r = render(
      <WorkbenchProvider api={apiFor(viewId)} projectId={PROJECT} viewId={viewId} canEdit>
        <DeclarativeRegion view={{ view_spec: spec, view_id: viewId }} data={{ frame: FRAME }} />
      </WorkbenchProvider>,
    )
    unmount = r.unmount
  })
  await settle()
  return unmount
}

function clearFeed(): void {
  for (const viewId of [...declarativeCanvas.get().contributions.keys()]) declarativeCanvas.clear(viewId)
}

describe('retiring one view\'s contribution leaves the shared canvas standing', () => {
  beforeEach(() => {
    clearFeed()
    for (const id of VIEW_IDS) destroyDeclarativeMount(id)
    defaultVizStores.datasetStore.getState().reset()
  })
  afterEach(() => {
    __resetDeclarativeMountsForTests()
    clearFeed()
  })

  it('closes one pane and the OTHER pane is still plotted', async () => {
    await mountCanvas()
    await mountPane(specWith('view.a', 'a1'), 'view-a')
    const unmountB = await mountPane(specWith('view.b', 'b1'), 'view-b')

    expect(panes().map(p => p.id).sort(), 'both open panes contribute to the one canvas').toEqual(['a1', 'b1'])
    expect(paneNamed('a1')?.rows, 'the canvas resolved the surviving pane before anything closed').toBe(4)
    expect(paneNamed('b1')?.rows).toBe(4)
    const holdersBefore = holdersOf('a1')

    // A real close: the shell removes the pane and destroys its declarative store, which retires its
    // canvas contribution. The other pane is untouched and still open.
    await act(async () => {
      unmountB()
      destroyDeclarativeMount('view-b')
    })
    await settle()

    expect(panes().map(p => p.id), 'the closed pane took its plots with it').toEqual(['a1'])
    expect(
      paneNamed('a1')?.rows,
      'closing ONE pane un-resolved the plot beside it. A contribution being retired is not the ' +
        'canvas being torn down — the shared controller is still driving every other open pane, and ' +
        'a user who closed a different pane changed nothing about this one.',
    ).toBe(4)
    expect(
      holdersOf('a1'),
      'the surviving plot lost a holder on its slice when a DIFFERENT view was retired',
    ).toBe(holdersBefore)
  })

  it('the retired view\'s OWN slice does not linger — retirement releases too', async () => {
    await mountCanvas()
    await mountPane(specWith('view.a', 'a1'), 'view-a')
    const unmountB = await mountPane(specWith('view.b', 'b1'), 'view-b')
    const retiredKey = paneNamed('b1')?.datasetKey
    expect(retiredKey, 'the pane about to close has a slice of its own').toBeTypeOf('string')

    await act(async () => {
      unmountB()
      destroyDeclarativeMount('view-b')
    })
    await settle()

    expect(
      defaultVizStores.datasetStore.getState().getEntry(retiredKey!),
      'the closed pane\'s slice is still pinned. Surviving a tab switch must not become surviving a ' +
        'close.',
    ).toBeNull()
  })

  it('the SHARED controller carries the surviving slice across the recompose, same identity', async () => {
    const stores = createVizStores()
    let published: DatasetResolver | null = null
    const controller = new VizController({
      resolveDataset: (id: string) => {
        if (!published) throw new Error('nothing published yet')
        return published(id)
      },
      stores,
    })

    /** Re-drive the ONE controller from whatever the feed currently composes to — the live loop. */
    const drive = async (): Promise<void> => {
      const { option, resolver } = declarativeCanvas.get()
      published = resolver
      if (option) await driveCanvas(controller, option)
    }
    /** Publish `viewId`'s contribution exactly as the canvas host does, then re-drive. */
    const publishAndDrive = async (spec: ViewSpec, viewId: string): Promise<void> => {
      const data = { frame: FRAME }
      const feed = resolveDeclarativeCanvas(spec, {
        data,
        scope: { params: {}, state: {}, derived: {}, const: {}, data },
      })
      expect(feed, 'the declaration resolves to a plottable feed').not.toBeNull()
      declarativeCanvas.setFeed(viewId, feed!.option, feed!.resolver)
      await drive()
    }

    await publishAndDrive(specWith('view.a', 'a1'), 'view-a')
    await publishAndDrive(specWith('view.b', 'b1'), 'view-b')
    const surviving = 'view-a::frame'
    const entryBefore = stores.datasetStore.getState().getEntry(surviving)
    expect(entryBefore?.catalog?.pointCount, 'the surviving slice resolved before anything retired').toBe(4)

    // Retire the OTHER view and re-drive — the one shared controller, a smaller option.
    declarativeCanvas.clear('view-b')
    await drive()

    const entryAfter = stores.datasetStore.getState().getEntry(surviving)
    expect(entryAfter?.catalog?.pointCount, 'the surviving slice is still resolved').toBe(4)
    expect(
      entryAfter?.gen,
      'the surviving slice was released to zero and resolved again under a new generation. Retiring ' +
        'one contribution must not take the shared controller down: it re-drives, and acquiring the ' +
        'new set before releasing the old one is what carries every other view\'s slice through — ' +
        'identity intact, because a resolved dataset is also a selection space.',
    ).toBe(entryBefore?.gen)
    expect(
      stores.datasetStore.getState().getEntry('view-b::frame'),
      'the retired view\'s own slice should still be released by the re-drive',
    ).toBeNull()
  })
})
