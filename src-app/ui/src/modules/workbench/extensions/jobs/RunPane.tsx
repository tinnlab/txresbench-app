// RunPane (W2 host of the run surface) — the pane `analysis.launch` opens for an analysis that
// ships NO form of its own. Its `ref` is the analysis id; it resolves the analysis from the
// registry and renders the shared `AnalysisRunPanel` (config → Run → live progress → artifact),
// pre-seeding any inputs stashed in the pane's content state (ITEM-19, keyed by pane id so they
// survive a pop-out / return). The stable `workbench-run-pane-<paneId>` testid is the observable
// side effect every such `analysis.launch` entry point (Launcher / ⌘K / chaining / AI) shares.
//
// An analysis that DECLARES `ui:` is launched into its OWN pane instead (INV-3/INV-4 —
// `WorkbenchSection.tsx`'s handler), so it does not reach this pane through a launch. It can
// still reach it through a layout persisted before that routing existed, or through
// `window.__workbenchPanes.open('run', <id>)`; `AnalysisRunPanel` refuses to build a rival form
// in that case and renders a signpost to the analysis' own pane.

import { Empty } from '@ziee/kit'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import type { BindingOrigin } from '@/modules/workbench/core'
import { AnalysisRunPanel } from '../analysis/AnalysisRunPanel'
import { RUN_PANE_ARTIFACT_KEY, type WorkbenchPane } from '../../core/shell/dock/paneModel'
import { usePaneState, setPaneState } from '../../core/shell/dock/paneState'

export function RunPane({ pane }: { pane: WorkbenchPane }) {
  const { api } = useWorkbench()
  const [state] = usePaneState<{
    inputs?: Record<string, unknown>
    /** How each persisted input was CHOSEN. Stored beside the values, written with them, so a
     *  restore cannot bring back a value while losing the fact that nobody picked it. */
    inputOrigins?: Record<string, BindingOrigin>
  }>(pane.id)
  const analysis = pane.ref ? api.registry.analyses.all().find(a => a.id === pane.ref) : undefined

  // NO unmount teardown of the entity binding, and no binding registry to tear down. The produced
  // artifact is RECORDED into this pane's own `paneState` below and READ back by the `run` kind's
  // registered resolver, so the binding lasts as long as the pane rather than as long as the
  // render — a region renders only its ACTIVE tab, so the old unmount-unbind dropped the binding
  // the moment the user looked at a sibling.

  return (
    <div data-testid={`workbench-run-pane-${pane.id}`} className="flex min-h-0 flex-1 flex-col">
      {analysis ? (
        <AnalysisRunPanel
          analysis={analysis}
          // The RUN LIFECYCLE is keyed by this pane's id, for exactly the reason the
          // params below are: a region renders only its ACTIVE tab, so a tab switch
          // unmounts this panel — and the run (its state AND its live progress stream)
          // has to outlive that. `clearPaneState` releases the session on close.
          sessionKey={pane.id}
          initialParams={state?.inputs}
          initialParamOrigins={state?.inputOrigins}
          // Persist edits by PANE ID so the entered config survives a pop-out / return (ITEM-19).
          //
          // The origins ride in the SAME write as the values they describe. Persisting one
          // without the other is not a partial save, it is a WRONG one: the value comes back
          // and its mark does not, so a binding nobody reviewed renders as a chosen one. A
          // region renders only its ACTIVE tab, so a tab switch is enough to trigger it.
          onParamsChange={(inputs, inputOrigins) => setPaneState(pane.id, { inputs, inputOrigins })}
          // Record the produced artifact so this pane self-closes if that artifact is deleted
          // (the delete affordance lives in the ArtifactReview this panel renders on completion).
          // `runPaneEntity` reads exactly this key back.
          onArtifact={artifactId => setPaneState(pane.id, { [RUN_PANE_ARTIFACT_KEY]: artifactId ?? undefined })}
        />
      ) : (
        <Empty
          data-testid={`workbench-run-pane-empty-${pane.id}`}
          title="No analysis selected"
          description="Launch an analysis from the launcher to configure and run it here."
        />
      )}
    </div>
  )
}
