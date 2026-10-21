import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createCapabilityBroker, type WorkbenchAPI } from '@/modules/workbench/core'
import { workbenchDockStore } from './WorkbenchDock.store'
import {
  FallbackPane,
  registerPaneRenderer,
  artifactPaneEntity,
  runPaneEntity,
  RUN_PANE_ARTIFACT_KEY,
} from './paneModel'
import { setPaneState, getPaneState, __resetPaneState } from './paneState'
import { reconcileEntityPanes, entityBoundPanes } from './entityLifecycle'

// TEST-235 (ITEM-19) — a pane bound to a DELETED artifact self-closes, INCLUDING when it is not
// the pane its region is currently rendering.
//
// ── THE DEFECT THIS PINS ────────────────────────────────────────────────────────────────────
//
// The binding used to be registered by `ArtifactPane`'s own mount effect and dropped on unmount.
// `RegionShell` renders only the ACTIVE pane's body per region, so a bound pane sitting behind
// another tab had NO binding — and the delete affordance's flow forces exactly that arrangement:
// the artifact REVIEW has to be active for its "Delete artifact" to be clickable, so the pane
// bound to the artifact being deleted is a background tab at the moment of the delete. The
// reconcile found zero bindings and closed nothing.
//
// Nothing here mounts a component, deliberately: "no pane body is rendered" is the STATE the bug
// lived in, so the test has to be able to express it. Rendering the pane would reintroduce the
// one condition that made the old code look correct.

/** A `WorkbenchAPI` carrying just the `data` capability the reconcile resolves — enough to make
 *  the catalog answer whatever a test needs, and nothing else. */
function apiWithCatalog(artifactIds: string[] | (() => never)): WorkbenchAPI {
  const capabilities = createCapabilityBroker()
  capabilities.publish('data', '1.0.0', {
    catalog: async () => {
      if (typeof artifactIds === 'function') artifactIds()
      return { project_id: 'p1', axes: [], artifacts: (artifactIds as string[]).map(id => ({ id })) }
    },
  })
  return { capabilities } as unknown as WorkbenchAPI
}

/** Open an `artifact` pane on `ref` WITHOUT rendering it (the store is the only thing touched). */
function addArtifactPane(ref: string): string {
  return workbenchDockStore.getState().addPane('artifact', ref)
}

describe('entityLifecycle — an entity-bound pane self-closes when its artifact is gone', () => {
  beforeEach(() => {
    __resetPaneState()
    workbenchDockStore.getState().reset()
    // The production resolvers, registered the way `panes.tsx` registers them. The RENDERERS are
    // irrelevant here (nothing renders); what is under test is that the kind declares how to read
    // an entity off pane-lifetime state.
    registerPaneRenderer('artifact', FallbackPane, { entity: artifactPaneEntity })
    registerPaneRenderer('run', FallbackPane, { entity: runPaneEntity })
  })
  afterEach(() => {
    registerPaneRenderer('artifact', FallbackPane)
    registerPaneRenderer('run', FallbackPane)
    workbenchDockStore.getState().reset()
  })

  it('binds every artifact pane in the STORE — a background tab is bound like a rendered one', () => {
    const bound = addArtifactPane('kind-a::a1')
    const review = addArtifactPane('run::r1')
    expect(entityBoundPanes()).toEqual([{ paneId: bound, entity: { entity: 'artifact', id: 'a1' } }])
    // The run-scoped REVIEW names no single artifact: it outlives any one of the run's outputs.
    expect(entityBoundPanes().map(b => b.paneId)).not.toContain(review)
  })

  it('closes the bound pane whose artifact left the catalog, and only that one', async () => {
    const gone = addArtifactPane('kind-a::a1')
    const kept = addArtifactPane('kind-a::a2')
    const review = addArtifactPane('run::r1')
    setPaneState(gone, { scroll: 1 })

    await reconcileEntityPanes(apiWithCatalog(['a2']))

    const paneOpen = (id: string) => workbenchDockStore.getState().paneIds().includes(id)
    expect(paneOpen(gone), 'the pane bound to the deleted artifact self-closes').toBe(false)
    expect(paneOpen(kept), 'a pane bound to a surviving artifact is untouched').toBe(true)
    expect(paneOpen(review), 'the run review is not bound to one artifact and stays open').toBe(true)
    expect(getPaneState(gone), 'a closed pane releases its content state').toBeUndefined()
  })

  it('closes NOTHING when the catalog read fails — "gone" is not "the query failed"', async () => {
    const bound = addArtifactPane('kind-a::a1')
    addArtifactPane('run::r1')

    await reconcileEntityPanes(
      apiWithCatalog(() => {
        throw new Error('network down')
      }),
    )

    expect(workbenchDockStore.getState().paneIds()).toContain(bound)
  })

  it('binds nothing for a kind whose registration declares no resolver', async () => {
    registerPaneRenderer('artifact', FallbackPane)
    const bound = addArtifactPane('kind-a::a1')
    addArtifactPane('run::r1')
    expect(entityBoundPanes()).toEqual([])
    await reconcileEntityPanes(apiWithCatalog([]))
    expect(workbenchDockStore.getState().paneIds()).toContain(bound)
  })

  // The RUN pane learns its artifact at runtime (its `ref` is the ANALYSIS id), so its binding
  // rides `paneState` — which is keyed by pane id and survives a tab switch — instead of a render
  // effect. Same property, same reconcile, same background-tab requirement.
  it('closes a run pane whose PRODUCED artifact is gone, from pane state alone', async () => {
    const run = workbenchDockStore.getState().addPane('run', 'some.analysis')
    addArtifactPane('run::r1')
    expect(entityBoundPanes(), 'a run pane that has produced nothing yet binds nothing').toEqual([])

    setPaneState(run, { [RUN_PANE_ARTIFACT_KEY]: 'a1' })
    expect(entityBoundPanes()).toEqual([{ paneId: run, entity: { entity: 'artifact', id: 'a1' } }])

    await reconcileEntityPanes(apiWithCatalog([]))
    expect(workbenchDockStore.getState().paneIds()).not.toContain(run)
  })
})
