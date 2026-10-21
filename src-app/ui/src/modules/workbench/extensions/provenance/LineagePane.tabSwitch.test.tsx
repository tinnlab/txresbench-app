// @vitest-environment jsdom
//
// The provenance pane's own disclosures must survive a REAL tab switch.
//
// The capture-failure banner keeps the raw error behind a "Details" disclosure. A user who opens
// it is mid-diagnosis — reading a 403 body, comparing it against another pane — and the region
// renders only its ACTIVE tab, so the glance away closed the disclosure and dropped them back to
// the summary. Nothing was closed and nothing changed; the pane simply forgot.
//
// The switch here is the real one: a click on `RegionShell`'s own `region-tab-<paneId>` element,
// which calls `setActive`. The pane, the banner, the shell and the pane-state store are real; only
// the provenance STORE reads (HTTP) and the export drawer are faked, neither being the subject.

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const provenance = {
  graph: null as unknown,
  loading: false,
  error: null as string | null,
  captureError: '403 forbidden — the recipe was rejected',
  lastCapture: { projectId: 'p-lineage-tab-switch' } as unknown,
  recording: false,
  readiness: null as unknown,
  $: { loadedProjectId: 'p-lineage-tab-switch' },
  load: vi.fn(),
  reloadCurrent: vi.fn(),
  retryCapture: vi.fn(),
  clearCaptureError: vi.fn(),
}

vi.mock('@/modules/provenance/stores/Provenance.store', () => ({ Provenance: provenance }))
vi.mock('@/modules/provenance/stores/ProvenanceExport.store', () => ({
  ProvenanceExport: { openFor: vi.fn() },
}))
vi.mock('@/modules/provenance/project-extension/components/ExportDrawer', () => ({
  ExportDrawer: () => null,
}))
// `RegionShell` needs `evaluatePermission` (its "+" menu filter) and the pane needs
// `usePermission` — both are held here, so the pane's own `provenance::read` gate (covered by
// `LineagePane.permission.test.tsx`) does not replace the banner with the 403 surface.
vi.mock('@/core/permissions', () => ({
  usePermission: () => true,
  evaluatePermission: () => true,
}))

const { createWorkbenchApi } = await import('@/modules/workbench/core')
const { makeFakeHost } = await import('@/modules/workbench/core/host/createHost')
const { WorkbenchProvider } = await import('@/modules/workbench/core/shell/WorkbenchContext')
const { workbenchDockStore } = await import('@/modules/workbench/core/shell/dock/WorkbenchDock.store')
const { FallbackPane, registerPaneRenderer } = await import('@/modules/workbench/core/shell/dock/paneModel')
const { __resetPaneState } = await import('@/modules/workbench/core/shell/dock/paneState')
const { workbenchRegionsStore } = await import('@/modules/workbench/core/shell/regions/WorkbenchRegions.store')
const { RegionShell } = await import('@/modules/workbench/core/shell/regions/RegionShell')
const { ProvenancePane } = await import('./LineagePane')

const PROJECT = 'p-lineage-tab-switch'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
})

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
  __resetPaneState()
  workbenchRegionsStore.getState().reset()
  registerPaneRenderer('reproducibility', ProvenancePane)
  registerPaneRenderer('jobs', ({ pane }) => <div data-testid={`other-${pane.id}`} />)
})

afterEach(() => {
  cleanup()
  registerPaneRenderer('reproducibility', FallbackPane)
  registerPaneRenderer('jobs', FallbackPane)
})

describe('ProvenancePane across a real tab switch', () => {
  it('keeps the capture-failure Details disclosure open', async () => {
    const api = createWorkbenchApi(makeFakeHost({ projectId: PROJECT }), 'lineage-tab-switch-test')
    workbenchDockStore.getState().ensureProject(PROJECT)
    workbenchRegionsStore.getState().ensureProject(PROJECT)
    await act(async () => {
      render(
        <WorkbenchProvider api={api} projectId={PROJECT} viewId="lineage-tab-switch" canEdit>
          <RegionShell />
        </WorkbenchProvider>,
      )
    })
    let prov = ''
    let other = ''
    await act(async () => {
      prov = workbenchDockStore.getState().requestAddPane('reproducibility')
      other = workbenchDockStore.getState().requestAddPane('jobs')
    })
    const switchTo = async (id: string) => {
      await act(async () => {
        fireEvent.click(screen.getByTestId(`region-tab-${id}`))
      })
    }
    const detailsId = `workbench-provenance-capture-error-${prov}-details`

    await switchTo(prov)
    expect(screen.queryByTestId(detailsId), 'the disclosure starts closed').toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${detailsId}-toggle`))
    })
    expect(screen.getByTestId(detailsId).textContent).toContain('403 forbidden')

    await switchTo(other)
    expect(screen.queryByTestId(`region-pane-body-${prov}`), 'the switch really unmounts the pane').toBeNull()
    await switchTo(prov)

    expect(
      screen.queryByTestId(detailsId),
      'the user opened the raw error, glanced at another tab, and came back to a collapsed banner ' +
        '— mid-diagnosis, having changed nothing',
    ).not.toBeNull()
  })
})
