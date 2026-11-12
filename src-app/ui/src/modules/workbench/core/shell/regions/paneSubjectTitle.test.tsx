// @vitest-environment jsdom
//
// A TAB NAMES ITS SUBJECT, AND IT NEVER NAMES IT WITH A UUID.
//
// `paneTitle` used to end `pane.ref ? base + ' · ' + ref : base`, so a Jobs pane deep-linked by
// `revealPane('jobs', job.id)` — the route the completion toast and the per-analysis run list both
// take — read `Jobs · 3f2a1c8e-9d4b-…`. Two properties are asserted here, on the RENDERED shell:
//
//   1. the CLASS invariant — no tab's accessible name contains a uuid, for ANY pane kind. Written
//      over `PANE_KINDS` rather than over a hand-listed case, because a hand-listed case is what
//      lets the next kind regress silently.
//   2. the ARRIVAL — a job's name is fetched, so a tab exists before its name is known. It must
//      say something honest until then and then UPDATE IN PLACE, with no remount and no reload.
//
// The geometry/axe half of the tab strips lives in `tests/e2e/14-workbench/region-tab-strip.spec.ts`;
// this file owns the naming.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { PaneBody, RegionShell } from './RegionShell'
import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import { workbenchRegionsStore } from './WorkbenchRegions.store'
import {
  PANE_KINDS,
  paneRenderers,
  registerPaneRenderer,
  runPaneEntity,
  authoredRefSubject,
  type PaneKind,
} from '@/modules/workbench/core/shell/dock/paneModel'
import { rememberJobNames, __resetJobNames } from '@/modules/jobs/jobNames'
import { rememberArtifacts, __resetArtifactNames } from '@/core/workstore/artifactNames'
import { createWorkbenchApi } from '@/modules/workbench/core'
import { makeFakeHost } from '@/modules/workbench/core/host/createHost'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
// The production registration (the side-effect import the shell performs at boot) — without it
// every kind resolves the seeded fallback and no subject resolver exists to measure.
import '@/modules/workbench/core/shell/dock/panes'

/** A uuid ANYWHERE in a string — the shape a user must never read off a tab. */
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const JOB_ID = '3f2a1c8e-9d4b-4c1e-8a77-2b6f0d1e5a90'

let project = ''
let seq = 0

/** The shell inside its provider — `PlacedArea` (the canvas/visualize pane bodies) reads the
 *  workbench context, so a bare `<RegionShell/>` throws before any tab is drawn. */
function mountShell() {
  const api = createWorkbenchApi(makeFakeHost({ projectId: project }), `txr.workbench.subject-${seq}`)
  return render(
    <WorkbenchProvider api={api} projectId={project} viewId={`test-${project}`} canEdit>
      <RegionShell />
    </WorkbenchProvider>,
  )
}

beforeEach(() => {
  project = `wb-subject-${++seq}`
  __resetJobNames()
  __resetArtifactNames()
  window.localStorage.clear()
  workbenchDockStore.getState().ensureProject(project)
  workbenchRegionsStore.getState().reconcilePanes(workbenchDockStore.getState().paneIds())
})
afterEach(cleanup)

describe('a pane tab names its subject', () => {
  it('shows the job NAME once it is known, and honest words before that', async () => {
    const paneId = workbenchDockStore.getState().requestAddPane('jobs', JOB_ID)
    expect(paneId, 'the jobs pane opened').toBeTruthy()
    mountShell()

    const tab = screen.getByTestId(`region-tab-${paneId}`)
    // BEFORE the fetch: the tab is honest — it is the Jobs pane — and it prints no id.
    expect(tab.getAttribute('aria-label')).toBe('Jobs')

    // The name ARRIVES (a list poll / detail load feeds `jobNames`). The tab updates in place:
    // no remount, no reload, no second render triggered by anything else.
    await act(async () => {
      rememberJobNames([{ id: JOB_ID, name: 'Nightly filter', job_type: 'demo.filter' }])
    })
    expect(screen.getByTestId(`region-tab-${paneId}`).getAttribute('aria-label')).toBe(
      'Jobs · Nightly filter',
    )
  })

  it('falls back to the job TYPE for an unnamed job, never to the id', async () => {
    const paneId = workbenchDockStore.getState().requestAddPane('jobs', JOB_ID)
    mountShell()
    await act(async () => {
      rememberJobNames([{ id: JOB_ID, name: '', job_type: 'stub' }])
    })
    expect(screen.getByTestId(`region-tab-${paneId}`).getAttribute('aria-label')).toBe('Jobs · stub')
  })

  it('NO tab of ANY kind prints a uuid, even when every kind is open with a uuid ref', () => {
    // Derived from the registry: a kind added tomorrow is covered tomorrow, with no edit here.
    const opened: Array<{ kind: PaneKind; id: string }> = []
    for (const kind of PANE_KINDS as readonly PaneKind[]) {
      const id = workbenchDockStore.getState().requestAddPane(kind, `${JOB_ID}`)
      if (id) opened.push({ kind, id })
    }
    expect(opened.length, 'every registry kind opened with a uuid ref').toBe(PANE_KINDS.length)
    mountShell()

    const offenders = opened
      .map(({ kind, id }) => ({
        kind,
        label: screen.getByTestId(`region-tab-${id}`).getAttribute('aria-label') ?? '',
      }))
      .filter(({ label }) => UUID_ANYWHERE.test(label))
    expect(
      offenders.map(o => `${o.kind}: ${o.label}`),
      'a tab must never show a raw uuid — the kind needs a subject resolver, or none at all',
    ).toEqual([])
  })

  // THE PANE HEADER IS A SECOND, INDEPENDENT SUBSCRIBER — and its window only exists here.
  //
  // In the shell, `RegionShell`'s own `usePaneSubjectEpoch` re-renders the whole tree, so
  // `PaneBody`'s subscription is masked: delete it and every assertion above still passes.
  // `PaneBody` is EXPORTED and mounted on its own by the component gallery ("so the gallery can
  // mount the REAL pane body for every kind in the registry"), and in that mounting there is no
  // RegionShell above it. This is that mounting.
  it('a PaneBody mounted ALONE still re-reads its title when the name arrives', async () => {
    const paneId = workbenchDockStore.getState().requestAddPane('jobs', JOB_ID)
    const pane = workbenchDockStore.getState().panes().find(c => c.id === paneId)!
    const api = createWorkbenchApi(makeFakeHost({ projectId: project }), `txr.workbench.subject-body-${seq}`)
    render(
      <WorkbenchProvider api={api} projectId={project} viewId={`test-${project}`} canEdit>
        <PaneBody pane={pane} titled />
      </WorkbenchProvider>,
    )
    const header = screen.getByTestId(`pane-header-${paneId}`)
    expect(header.textContent).toContain('Jobs')
    expect(header.textContent).not.toContain(JOB_ID)

    await act(async () => {
      rememberJobNames([{ id: JOB_ID, name: 'Nightly filter', job_type: 'demo.filter' }])
    })
    expect(screen.getByTestId(`pane-header-${paneId}`).textContent).toContain('Jobs · Nightly filter')
  })

  // ── the two kinds `27b19e86` REPORTED rather than guessed ────────────────────────────────
  //
  // Inverting the default stopped `artifact` and `compare` printing uuids and left them reading
  // their kind title alone: no longer wrong, still uninformative. Both name RUNS — an `artifact`
  // pane's `run::<id>` form reviews one run's whole output, and a `compare` pane's ref is a
  // comma-joined run list — and a compute run's id IS its job's id (`job.run_id.unwrap_or(job.id)`,
  // `jobs/scheduler.rs`), so both read through the SAME ambient lookup a jobs tab does. No new
  // fetch, and the same words in both places.

  it('an artifact pane reviewing a RUN names that run, not its uuid', async () => {
    const paneId = workbenchDockStore.getState().requestAddPane('artifact', `run::${JOB_ID}`)
    expect(paneId, 'the artifact pane opened').toBeTruthy()
    mountShell()
    // Honest before the fetch.
    expect(screen.getByTestId(`region-tab-${paneId}`).getAttribute('aria-label')).toBe('Artifact')

    await act(async () => {
      rememberJobNames([{ id: JOB_ID, name: 'Nightly filter', job_type: 'demo.filter' }])
    })
    expect(screen.getByTestId(`region-tab-${paneId}`).getAttribute('aria-label')).toBe(
      'Artifact · Nightly filter',
    )
  })

  it('an artifact pane bound to ONE artifact reads the SAME label its picker offered', async () => {
    // The ref carries the datatype (`<datatype>::<artifactId>`), and the tab deliberately does
    // NOT print that: what the ref happens to encode is not what the artifact IS. Until a fetch
    // has described it, "Artifact" is the honest answer.
    const artifactId = 'b41e77aa-1c5d-4a90-9f31-8e2d5c6a7b04'
    const paneId = workbenchDockStore.getState().requestAddPane('artifact', `table::${artifactId}`)
    mountShell()
    const label = () => screen.getByTestId(`region-tab-${paneId}`).getAttribute('aria-label')
    expect(label()).toBe('Artifact')

    // A catalog fetch describes it (`core/workstore/catalog` feeds this on every artifact
    // fetch the app already makes). The label is the SHARED one — the words the artifact-ref
    // picker and the lineage DAG use for the same row.
    await act(async () => {
      rememberArtifacts([
        {
          id: artifactId,
          datatype: 'table',
          created_at: new Date().toISOString(),
          structure: {
            encoding: 'zarr_v3',
            kind: 'table',
            axis: 'entries',
            n: 5000,
            arrays: [{ path: 'coords', kind: 'numeric', shape: [5000, 2] }],
          },
        },
      ])
    })
    expect(label()).toBe('Artifact · table · 5000×2 · just now')
  })

  it('a compare pane names the runs it compares once they are all named', async () => {
    const other = '7c1d9b02-3e5a-4f18-9a2c-6d0b4e7f1c33'
    const paneId = workbenchDockStore.getState().requestAddPane('compare', `${JOB_ID},${other}`)
    mountShell()
    const label = () => screen.getByTestId(`region-tab-${paneId}`).getAttribute('aria-label')

    // BEFORE any name lands the tab still says something a count can be trusted for — how many
    // runs are in the set. It is exact (it is read off the ref), and it is the only thing that
    // can be said honestly while the names are unknown.
    expect(label()).toBe('Compare · 2 runs')

    // A PARTIAL set stays a count: naming the half that has arrived would read as the whole set
    // and misstate how many runs are being compared.
    await act(async () => {
      rememberJobNames([{ id: JOB_ID, name: 'Nightly filter', job_type: 'demo.filter' }])
    })
    expect(label(), 'a half-known set must not read as a complete one').toBe('Compare · 2 runs')

    await act(async () => {
      rememberJobNames([{ id: other, name: 'Baseline', job_type: 'demo.filter' }])
    })
    expect(label()).toBe('Compare · Nightly filter vs Baseline')
  })

  it('…and a compare pane with no ref at all says nothing extra', () => {
    const paneId = workbenchDockStore.getState().requestAddPane('compare')
    mountShell()
    expect(screen.getByTestId(`region-tab-${paneId}`).getAttribute('aria-label')).toBe('Compare')
  })

  it('…and the scan is not vacuous: reinstate the OLD behaviour for one kind and it IS caught', () => {
    // THE NEGATIVE CONTROL. A scan that silently matched nothing would read identically to a clean
    // tree, so the defect is put back — for exactly one kind, by registering the pre-change
    // resolver (`pane => pane.ref`, with no claim about what a ref is) — and the same scan must
    // fail. `run`'s registration is restored immediately after, so nothing leaks into the file.
    const saved = paneRenderers.run
    registerPaneRenderer('run', saved, { entity: runPaneEntity, subject: p => p.ref ?? null })
    try {
      const id = workbenchDockStore.getState().requestAddPane('run', JOB_ID)
      mountShell()
      const label = screen.getByTestId(`region-tab-${id}`).getAttribute('aria-label') ?? ''
      expect(label, 'the old behaviour prints the raw ref').toBe(`Run · ${JOB_ID}`)
      expect(UUID_ANYWHERE.test(label), 'the scan detects it').toBe(true)
    } finally {
      registerPaneRenderer('run', saved, { entity: runPaneEntity, subject: authoredRefSubject })
    }
    // …and the restore actually restored: the same pane is clean again.
    cleanup()
    const again = workbenchDockStore.getState().requestAddPane('run', JOB_ID)
    mountShell()
    const restored =
      screen.getByTestId(`region-tab-${again}`).getAttribute('aria-label') ?? ''
    expect(UUID_ANYWHERE.test(restored), 'the production registration is back').toBe(false)
  })
})
