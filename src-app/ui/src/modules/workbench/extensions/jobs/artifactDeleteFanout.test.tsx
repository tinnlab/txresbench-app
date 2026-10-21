// @vitest-environment jsdom
//
// Deleting an artifact is the WORKBENCH's copy of the self-echo-suppression hole.
//
// ── What was there, and why it looked fine ───────────────────────────────────────────
//
// `workstore/data_api.rs:300` publishes `Artifact`/`Delete` with `origin` applied, so the
// acting tab is the one client the fan-out skips. `DeleteArtifactButton` compensated by
// HAND-WIRING the two things a `sync:artifact` frame would have caused:
//
//     await reconcileEntityPanes(api)   // what `useEntitySelfClose` does
//     refreshCatalog()                  // what `useCatalogInvalidation` does
//
// That is an ENUMERATION of the subscriber list, maintained at a mutation site — the
// exact shape `useCatalogInvalidation.ts` was written to retire ("an enumeration silently
// drops the N+1th entry"). It is correct for today's two subscribers and wrong for the
// third, which gets nothing, with no error to show for it. It also reached across the
// layer boundary: an extension importing `core/shell/dock/entityLifecycle` (a committed
// entry in `scripts/layer-boundary-baseline.json`).
//
// ── What these cases assert ──────────────────────────────────────────────────────────
//
// The discriminating case registers an INDEPENDENT `sync:artifact` subscriber — one the
// delete affordance does not know about and never will — and asserts it is notified.
// That is precisely what the hand-wiring cannot do and the echo does; it fails against
// unmodified `origin/main` while every other case here passes, because the other cases
// are the two subscribers the hand-wiring happened to name.
//
// The pane-self-close and catalog-refresh cases are POSITIVE CONTROLS: they hold both
// before and after, so they prove the migration lost nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { EventBus } from '@ziee/framework/stores'
import { createCapabilityBroker, type WorkbenchAPI } from '@/modules/workbench/core'
import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import {
  FallbackPane,
  registerPaneRenderer,
  artifactPaneEntity,
} from '@/modules/workbench/core/shell/dock/paneModel'
import { __resetPaneState } from '@/modules/workbench/core/shell/dock/paneState'
import { useEntitySelfClose } from '@/modules/workbench/core/shell/dock/entityLifecycle'
import { useCatalogInvalidation } from '@/modules/workbench/core/shell/useCatalogInvalidation'

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))

const deleteArtifact = vi.fn(async () => undefined)
vi.mock('@/api-client', () => ({
  ApiClient: { Workstore: { deleteArtifact: (...a: unknown[]) => deleteArtifact(...(a as [])) } },
}))

/** Live artifact ids the fake `data` capability's catalog answers with. */
let catalogIds: string[] = []
const refreshCatalog = vi.fn()

function makeApi(): WorkbenchAPI {
  const capabilities = createCapabilityBroker()
  capabilities.publish('data', '1.0.0', {
    catalog: async () => ({
      project_id: 'p1',
      axes: [],
      artifacts: catalogIds.map(id => ({ id })),
    }),
  })
  return { capabilities } as unknown as WorkbenchAPI
}

const api = makeApi()

// The button reads `canEdit` / `projectId` / `api` / `refreshCatalog` off the workbench
// context. Mounting a real `WorkbenchProvider` would drag the whole extensions layer
// (deck.gl, the kit's canvas host) into a unit run; only the four fields are under test.
vi.mock('@/modules/workbench/core/shell/WorkbenchContext', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/modules/workbench/core/shell/WorkbenchContext')>()
  return { ...actual, useWorkbench: () => ({ canEdit: true, projectId: 'p1', api, refreshCatalog }) }
})

const { DeleteArtifactButton } = await import('./DeleteArtifactButton')

/** Mounts the two REAL core subscribers a live workbench runs, so the assertions below
 *  are about the production reaction to a frame, not about a frame being emitted. */
function Subscribers() {
  useEntitySelfClose(api)
  useCatalogInvalidation('p1', refreshCatalog)
  return null
}

/** A subscriber the delete affordance does not know about — the N+1th. */
function ThirdParty({ onFrame }: { onFrame: (a: string, id: string) => void }) {
  useEffect(() => EventBus.on('sync:artifact', e => onFrame(e.data.action, e.data.id)), [onFrame])
  return null
}

const paneOpen = (id: string) => workbenchDockStore.getState().paneIds().includes(id)

beforeEach(() => {
  deleteArtifact.mockClear()
  refreshCatalog.mockClear()
  __resetPaneState()
  workbenchDockStore.getState().reset()
  registerPaneRenderer('artifact', FallbackPane, { entity: artifactPaneEntity })
  catalogIds = []
})

afterEach(() => {
  cleanup()
  registerPaneRenderer('artifact', FallbackPane)
  workbenchDockStore.getState().reset()
})

/** Render the affordance + the real subscribers, then press Delete through the confirm. */
async function clickDelete(extra?: React.ReactNode) {
  render(
    <>
      <Subscribers />
      {extra}
      <DeleteArtifactButton artifactId="a1" testid="del" />
    </>,
  )
  screen.getByTestId('del').click()
  const confirm = await screen.findByRole('button', { name: /^Delete$/ })
  confirm.click()
  await waitFor(() => expect(deleteArtifact).toHaveBeenCalledTimes(1))
}

describe('deleting an artifact refreshes through the sync channel, not a hand-wired list', () => {
  it('notifies a `sync:artifact` subscriber the affordance does not know about', async () => {
    const frames: { action: string; id: string }[] = []
    // A bound pane so the reconcile has work to do (it short-circuits on zero bindings) —
    // this case is about the THIRD subscriber, not about the pane.
    workbenchDockStore.getState().addPane('artifact', 'kind-a::a1')

    await clickDelete(<ThirdParty onFrame={(action, id) => frames.push({ action, id })} />)

    // THE POINT: the delete affordance named `reconcileEntityPanes` and `refreshCatalog`
    // one-for-one. It cannot name this one, and with the hand-wiring it never fires.
    await waitFor(() => expect(frames).toHaveLength(1))
    // WIRE PARITY: the exact frame `publish_artifact(&pool, project_id, Delete, id,
    // origin.0)` withheld from this connection — not `update`, not the project id.
    expect(frames[0]).toEqual({ action: 'delete', id: 'a1' })
  })

  it('still self-closes the pane bound to the deleted artifact (positive control)', async () => {
    const bound = workbenchDockStore.getState().addPane('artifact', 'kind-a::a1')
    const kept = workbenchDockStore.getState().addPane('artifact', 'kind-a::a2')
    catalogIds = ['a2'] // a1 is gone from the catalog after the delete

    await clickDelete()

    await waitFor(() => expect(paneOpen(bound)).toBe(false))
    expect(paneOpen(kept), 'an unrelated bound pane is untouched').toBe(true)
  })

  it('still advances the catalog epoch, exactly once (positive control + no double-bump)', async () => {
    workbenchDockStore.getState().addPane('artifact', 'kind-a::a1')

    await clickDelete()

    // `useCatalogInvalidation` coalesces a burst into ONE bump; a surviving direct
    // `refreshCatalog()` call ALONGSIDE the echo would make it two.
    await waitFor(() => expect(refreshCatalog).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 200))
    expect(refreshCatalog).toHaveBeenCalledTimes(1)
  })
})
