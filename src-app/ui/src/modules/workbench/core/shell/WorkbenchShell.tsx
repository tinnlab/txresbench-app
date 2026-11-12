// WorkbenchShell — the workbench IDE frame: a FIXED 4-region shell (`RegionShell`, mounted by
// `WorkbenchDockHost`) under the shared kit `HeaderBarContainer` top bar (same as the datasets page)
// and above the status bar. The header shows the project name (left) + a CENTERED workbench command
// palette; the app's own left-sidebar collapse button handles collapse (no custom toggle here).
// Surfaces open via the palette; each pane belongs to a region (left/center/right/bottom).

import { useEffect } from 'react'
import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'
import { WorkbenchLayout } from '@/modules/workbench/core/shell/stores/WorkbenchLayout.store'
import './seam' // installs the read-only window.__workbench e2e seam (import side-effect)
import { useIsMobile, Title } from '@txresbench/kit'
import { HeaderBarContainer } from '@txresbench/shell'
import { useWorkbench } from './WorkbenchContext'
import { MobileShell } from './MobileShell'
import { WorkbenchStatusBar } from './WorkbenchStatusBar'
import { WorkbenchCommandPalette } from './WorkbenchCommandPalette'
import { WorkbenchDockHost } from './dock/WorkbenchDockHost'
import { ChoreographyOverlay } from './ChoreographyOverlay'
import { vizStateStore } from '@/modules/workbench/extensions/canvas/vizState.store'
import { workbenchRegionsStore } from './regions/WorkbenchRegions.store'
import { resetDismissedViews } from './dock/paneReconcile'

export function WorkbenchShell() {
  const { projectId } = useWorkbench()
  const isMobile = useIsMobile()
  const { project } = ProjectDetail

  // Bind the per-project layout + viz state (color-by / plot-type / embedding). Hooks run
  // unconditionally (Rules of Hooks) before the mobile early-return.
  useEffect(() => {
    // Bind the (singleton) region ARRANGEMENT to this project: reset, then restore what this
    // project persisted (collapse / active tab / order / overrides — `WorkbenchRegions.store`).
    // The RESET half is why this stays here rather than moving earlier: default pane ids
    // (`p-visualize`, `p-canvas`, …) are IDENTICAL across projects, so leftover
    // popouts/overrides from the previous project would otherwise capture the same-id panes of
    // this one (dropping `poppedOut` also closes the stale popout windows) — AND this effect's
    // position relative to `WorkbenchDockHost`'s child `useViewReconciliation` effect is load-
    // bearing for where auto-mounted contributed views dock. `ensureProject` is idempotent
    // (a re-bind of the same project is a no-op), so a remount can't clobber the live
    // arrangement. Region SIZES need no bind — they are a global preference the store reads
    // from storage at construction, so they are already correct at the FIRST paint.
    workbenchRegionsStore.getState().ensureProject(projectId)
    resetDismissedViews() // a fresh project re-offers every contributed view (drop prior dismissals)
    WorkbenchLayout.ensureProject(projectId)
    vizStateStore.getState().ensureProject(projectId)
  }, [projectId])

  // Narrow viewport → the mobile fallback (canvas stays the hero).
  if (isMobile) return <MobileShell />

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="workbench-shell">
      <HeaderBarContainer>
        <div className="relative flex h-full w-full items-center gap-3">
          <div className="flex min-w-0 items-center">
            <Title level={4} className="!m-0 !leading-tight truncate" data-testid="workbench-project-name">
              {project?.name ?? 'Workbench'}
            </Title>
          </div>
          {/* The workbench command palette, absolutely centered (both axes) in the header bar. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-2">
            <div className="pointer-events-auto w-full max-w-md">
              <WorkbenchCommandPalette />
            </div>
          </div>
        </div>
      </HeaderBarContainer>
      <WorkbenchDockHost />
      <WorkbenchStatusBar />
      {/* Visible choreography spotlight/caption for AI- or human-driven actions. */}
      <ChoreographyOverlay />
    </div>
  )
}
