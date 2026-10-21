// @vitest-environment jsdom
//
// canvasPersistence.test.tsx — the canvas belongs to the WORKBENCH, not to whichever pane happens
// to be the active tab.
//
// A region renders only while its pane is the active tab (`RegionShell` renders
// `{active ? <PaneBody/> : null}`), so switching tabs UNMOUNTS the declarative region. That is a
// statement about what is on screen, not about what the user still wants: the pane is open, its
// form state is deliberately preserved across the switch, and the plots the user built from that
// state must be preserved with it. Losing them is the same defect as losing the form — the user
// changed nothing and came back to less.
//
// So the assertions below drive the REAL region through mount → unmount (the tab switch) and read
// the panes off `window.__canvasPanes`, the seam that reports what the canvas grid is actually
// showing. NOT `window.__declarativeStores`: that reports the view's own state, which was never
// the thing being lost here, and an assertion on it would pass with the canvas blank.
//
// The counterpart matters just as much: a pane the user CLOSES must take its plots with it, or
// "persist" quietly becomes "leak for the life of the page".

import { act } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
import { declarativeCanvas } from './declarativeCanvasFeed.store'

beforeAll(() => {
  // React only treats `act` as a real flush boundary when the environment says so; without it
  // every mount warns and the assertions read a half-committed tree.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})

/** The frame both views plot. Neutral inventions — a declaration binds columns by name, so what
 *  they are called carries no meaning here. */
const FRAME = { depth: [10, 20, 30, 40], fraction: [1, 2, 3, 4] }

function specWith(id: string, coordIds: readonly string[]): ViewSpec {
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
      series: coordIds.map((coordId, i) => ({
        id: `s-${coordId}`,
        type: 'violin',
        coordId,
        datasetId: 'frame',
        title: `${coordId} title`,
        encode: { valueKey: i === 0 ? 'depth' : 'fraction' },
      })),
    },
  } as unknown as ViewSpec
}

/** What the canvas is showing right now, in grid order — the seam the e2e reads. */
function panes(): string[] {
  const seam = (window as unknown as { __canvasPanes?: () => Array<{ id: string }> }).__canvasPanes
  return (seam?.() ?? []).map(p => p.id)
}

/** The workbench the panes below live in. ONE project, because that is what a workbench is — every
 *  open pane sees the same one. */
const PROJECT = 'canvas-persistence'

/** Mount ONE declarative pane the way the shell does, and hand back its unmount (the tab switch). */
async function mountPane(spec: ViewSpec, viewId: string): Promise<() => void> {
  const projectId = PROJECT
  const api = createWorkbenchApi(makeFakeHost({ projectId }), 'canvas-persistence-test')
  let unmount = (): void => {}
  await act(async () => {
    const r = render(
      <WorkbenchProvider api={api} projectId={projectId} viewId={viewId} canEdit>
        <DeclarativeRegion view={{ view_spec: spec, view_id: viewId }} data={{ frame: FRAME }} />
      </WorkbenchProvider>,
    )
    unmount = r.unmount
  })
  await act(async () => {
    await Promise.resolve()
  })
  return unmount
}

describe('the canvas outlives the pane that is on screen', () => {
  beforeEach(() => {
    for (const id of ['view-a', 'view-b']) {
      declarativeCanvas.clear(id)
      destroyDeclarativeMount(id)
    }
  })
  afterEach(() => {
    __resetDeclarativeMountsForTests()
  })

  it('keeps a pane\'s plots when its tab stops being the active one', async () => {
    const unmount = await mountPane(specWith('view.a', ['a1', 'a2']), 'view-a')
    expect(panes(), 'the mounted pane published its canvas').toEqual(['a1', 'a2'])

    // The tab switch: the region stops rendering. Nothing was closed and nothing was changed.
    await act(async () => {
      unmount()
    })
    expect(
      panes(),
      'switching tabs blanked the canvas. A region unmount means "not the active tab", not ' +
        '"discard this pane" — the plots belong to the open pane, and the user changed nothing.',
    ).toEqual(['a1', 'a2'])
  })

  it('accumulates the panes of every open view, not just the last one on screen', async () => {
    const unmountA = await mountPane(specWith('view.a', ['a1']), 'view-a')
    await act(async () => {
      unmountA()
    })
    await mountPane(specWith('view.b', ['b1']), 'view-b')
    expect(
      panes(),
      'the canvas is the workbench\'s, shared by every open pane — a second view must ADD to it, ' +
        'never replace what the first one contributed',
    ).toEqual(['a1', 'b1'])
  })

  it('retires a pane\'s plots when the pane is CLOSED', async () => {
    await mountPane(specWith('view.a', ['a1']), 'view-a')
    const unmountB = await mountPane(specWith('view.b', ['b1']), 'view-b')
    expect(panes()).toEqual(['a1', 'b1'])

    // A real close: the shell removes the pane and destroys its declarative store. The canvas
    // contribution goes with it — persistence must not become an unbounded accumulation.
    await act(async () => {
      unmountB()
      destroyDeclarativeMount('view-b')
    })
    expect(panes(), 'a closed pane takes its plots with it').toEqual(['a1'])
  })
})
