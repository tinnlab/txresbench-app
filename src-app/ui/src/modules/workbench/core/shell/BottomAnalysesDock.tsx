// BottomAnalysesDock (ITEM-13) — the tabbed, full-width ANALYSES dock. Composes:
//   (a) an "Analyses" run rail — the registered analyses + an "Add analysis"
//       affordance that opens one as a run tab;
//   (b) per opened analysis, a run tab: its params form (SchemaForm) + a Run button
//       (editor-only) that submits a sandboxed job and drives an idle→running→
//       done/error lifecycle, rendering the ArtifactPanel on success. An analysis that
//       declares `ui:` owns its form, so its tab is a SIGNPOST to that pane instead —
//       `AnalysisRunPanel` gates it, this dock inherits the gate (INV-3/INV-4);
//   (c) the BOTTOM-area contributed views (placeViews) as additional tabs.
//
// UX walk: the user picks an analysis, tweaks params, hits Run, watches
// progress, reads the artifact — all without leaving the canvas above.
// Infra walk: `compute.run` returns a JobHandle streamed over the jobs SSE; we
// detect completion from the terminal STATUS frame (the FE JobHandle exposes only
// `onProgress`, no terminal promise — see the note on `onFrame`), then refresh the
// catalog so the new artifact + its produced datatype light up availability.
// Entity-lifecycle: empty registry → an honest empty rail; a run that fails/stops
// → an inline error (never a crash); a viewer → the Run button is withheld.
//
// It was called `BottomArtifactsDock`, and every noun in it was wrong: it docks
// ANALYSES and contributed VIEWS, it holds no artifact list, and its empty state told a
// user with no analysis open that there were "No artifacts yet" — naming a thing this
// surface does not show, so the one instruction beside it ("add an analysis") read as a
// non-sequitur. A tab strip of analysis runs is empty when nothing is OPEN, which is what
// it now says. (The project's real artifact list is `workstore`'s `ArtifactsPanel`; two
// surfaces sharing the noun was the other half of the confusion.)

import { useMemo, useState } from 'react'
import { Button, Empty, ScrollArea, SectionHeader, Tabs } from '@ziee/kit'
import { type AnalysisContribution } from '@/modules/workbench/core'
import { useWhenContext, useWorkbench } from './WorkbenchContext'
import { placeViews } from './placement'
import { ViewHost } from './ViewHost'
import { AnalysisRunPanel } from '../../extensions/analysis/AnalysisRunPanel'

export function BottomAnalysesDock() {
  const { api, lattice } = useWorkbench()
  const whenCtx = useWhenContext()

  // Static registry reads (populated at boot) + the availability-gated bottom views.
  const analyses = api.registry.analyses.all()
  const bottomViews = placeViews(api.registry, 'bottom', whenCtx, lattice)

  const [openIds, setOpenIds] = useState<string[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const openAnalysis = (id: string) => {
    setOpenIds(prev => (prev.includes(id) ? prev : [...prev, id]))
    setActiveKey(`analysis:${id}`)
  }

  // "Add analysis" opens the next not-yet-open analysis (unavailable-with-a-reason when none
  // remain — the rail beside it is the affordance that lets a user pick a SPECIFIC one).
  const nextToAdd = analyses.find(a => !openIds.includes(a.id))

  const tabItems = useMemo(() => {
    const analysisTabs = openIds
      .map(id => analyses.find(a => a.id === id))
      .filter((a): a is AnalysisContribution => a != null)
      // Keyed so a run here survives a TAB SWITCH in this strip, for the same reason the
      // pane hosts key theirs. This dock is not a pane, so there is no `clearPaneState` to
      // release the session on close — and it needs none: it has no per-tab close
      // affordance, the key set is bounded by the analysis registry, and a session frees
      // its stream on the run's terminal frame regardless of what is mounted.
      .map(a => ({
        key: `analysis:${a.id}`,
        label: a.title,
        children: <AnalysisRunPanel analysis={a} sessionKey={`bottom-dock:${a.id}`} />,
      }))
    const viewTabs = bottomViews.map(v => ({ key: `view:${v.id}`, label: v.title, children: <ViewHost view={v} /> }))
    return [...analysisTabs, ...viewTabs]
  }, [openIds, analyses, bottomViews])

  // Keep the active tab valid as tabs open/close.
  const effectiveKey = activeKey && tabItems.some(t => t.key === activeKey) ? activeKey : (tabItems[0]?.key ?? null)

  return (
    <div data-testid="workbench-dock-bottom-body" className="flex min-h-0 flex-1">
      {/* (a) the run rail */}
      <div className="flex w-52 min-w-0 max-w-[38%] shrink-0 flex-col gap-1 border-e border-border p-2">
        <SectionHeader
          title="Analyses"
          data-testid="workbench-analyses-rail-header"
          actions={
            <Button
              variant="outline"
              // `unavailableReason`, not `disabled` + `tooltip`: the sentence below is the only
              // thing that distinguishes "there is nothing left to add" from "this button is
              // broken", and on a natively `disabled` button it could never open.
              unavailableReason={nextToAdd == null ? 'Every analysis is already open' : undefined}
              aria-label="Add analysis"
              onClick={() => nextToAdd && openAnalysis(nextToAdd.id)}
              data-testid="workbench-add-analysis"
            >
              Add analysis
            </Button>
          }
        />
        {analyses.length === 0 ? (
          <Empty
            data-testid="workbench-analyses-empty"
            title="No analyses available"
            description="Install an analysis extension to run one here."
          />
        ) : (
          <ScrollArea className="min-h-0 flex-1" data-testid="workbench-analyses-rail">
            <div className="flex flex-col gap-0.5">
              {analyses.map(a => {
                const isOpen = openIds.includes(a.id)
                return (
                  <Button
                    key={a.id}
                    variant="ghost"
                    onClick={() => openAnalysis(a.id)}
                    aria-pressed={isOpen}
                    data-testid={`workbench-analysis-open-${a.id}`}
                    className={`w-full justify-start ${isOpen ? 'bg-accent text-accent-foreground' : ''}`}
                  >
                    {a.title}
                  </Button>
                )
              })}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* (b) + (c) the run tabs + contributed bottom views */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {tabItems.length === 0 ? (
          <Empty
            data-testid="workbench-analyses-panel-empty"
            title="Nothing open"
            description="Choose an analysis from the rail to configure and run it."
          />
        ) : (
          <Tabs
            variant="line"
            fill
            value={effectiveKey ?? undefined}
            onValueChange={setActiveKey}
            items={tabItems}
            data-testid="workbench-analyses-tabs"
          />
        )}
      </div>
    </div>
  )
}
