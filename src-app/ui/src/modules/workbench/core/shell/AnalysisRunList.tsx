// AnalysisRunList — the runs of THIS analysis, beside the form that launches them.
//
// CORE, not contributed (spec Part 2). "Your runs" is a host concern in the same way the Run
// button's job wiring is: a processor knows nothing about jobs, and an analysis whose author
// forgot to declare a run list would silently lose the feedback — which is the failure this
// exists to remove. INV-1/INV-2 say the VIEW owns what the user sees *of the analysis' own
// vocabulary*; a run list is not that.
//
// Mounted once per ANALYSIS rather than per view file: a pane can stack several view files
// (INV-3) and they are one analysis with one set of runs.
//
// Click-through reuses the existing job surface (`revealPane('jobs', id)`) — the same route the
// completion toast takes. A second job-detail surface would be a second thing to keep correct.
//
// ── IT IS THE PANE'S PINNED FOOTER BAND, NOT THE FORM'S LAST WIDGET ──────────────────────────
//
// It renders as the second TRACK of the pane column (`DeclarativeRegion::DeclarativeStack`), not
// inside the form's scroll container, because feedback for an action must not be displaced by the
// growth of the thing that produces it. As the last child of the form it sat wherever the form
// ended, and a declarative form's list is rows a user adds — measured at y≈9169 in a 718px track
// on the 50-row gallery surface, and y≈808 in a 720px viewport in the app after adding ONE row to
// a shipped analysis' form.
//
// Being pinned is affordable precisely because the list is BOUNDED: `runsOfAnalysis` caps it at
// `ANALYSIS_RUNS_LIMIT`, so the band's height is bounded by construction rather than by a height
// picked out of the air. `max-h-[40%]` is not that height — it is a proportion rule for the
// degenerate case (a bottom region dragged shorter than the band), and it says the feedback band
// may never claim the majority of a pane: past that it scrolls inside itself.
//
// It carries its own VERTICAL rhythm (`py-3`) and no horizontal inset at all. Inside `RegionBody`
// it inherited that frame's `p-4` — and its `items-start`, which sized this section to its
// content: measured 73px wide, a `border-t` rule a fifth of the way across a 512px column. It
// then briefly supplied its own `px-4` to re-align with that frame. Both are gone: the pane body
// (`RegionShell::paneContentClass`) is now the ONE owner of a pane's horizontal inset, so the
// band and the form it belongs to line up because they are inset by the SAME element rather than
// by two numbers someone has to keep equal.

import type { Job } from '@/api-client/types'
import { JobStatusBadge } from '@/modules/jobs/components/JobStatusBadge'
import { useWorkbench } from './WorkbenchContext'
import { revealPane } from './regions/openPane'
import { runsOfAnalysis, isRunning, ANALYSIS_RUNS_LIMIT } from '../runtime/analysisRuns'
import { PaneScroll } from '@/modules/workbench/core/shell/dock/paneModel'

/** What the list says when the analysis has never run. Stated rather than rendered blank: an
 *  empty region with no sentence is the illegible state this work exists to remove. */
export const NO_RUNS_LABEL = 'No runs yet.'

function startedLabel(job: Job): string {
  const raw = String(job.created_at ?? '')
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleString()
}

export function AnalysisRunList({ analysisId, jobs }: { analysisId?: string; jobs?: readonly Job[] }) {
  const { api } = useWorkbench()
  if (!analysisId) return null
  const runs = runsOfAnalysis(jobs ?? [], analysisId, api.registry.analyses.all(), ANALYSIS_RUNS_LIMIT)

  return (
    <section
      data-testid={`analysis-runs-${analysisId}`}
      aria-label="Runs of this analysis"
      // ONE statement of "the form is the track that gives ground", and it is not here — it is
      // the form track's `flex-1` (`DeclarativeStack`), which takes the leftover space and leaves
      // this band its natural height. A `shrink-0` here would say the same thing a second time
      // and could never engage; a `w-full` likewise (the pane column stretches its children).
      // Both were written, and mutation-testing found that no test could tell either from its
      // absence — because neither was reachable. They are gone rather than kept as belt-and-braces
      // that hide which mechanism is load-bearing.
      //
      // `max-h-[40%]` IS reachable, and is the band's only self-imposed bound: in a pane dragged
      // shorter than the band, the band gives ground and its list scrolls inside it, rather than
      // taking the pane or hanging off the bottom. The `run-feedback-short` gallery surface is
      // what makes that falsifiable.
      className="flex max-h-[40%] flex-col gap-2 border-t border-border py-3"
    >
      {/* No `shrink-0`: a one-line heading's automatic minimum size already floors it, so the
          band's shrink lands entirely on the list below. Mutation-tested — removing a `shrink-0`
          here changed no measurement, which is the definition of a class that is not doing work. */}
      <h3 className="text-xs font-medium text-muted-foreground">Runs</h3>
      {runs.length === 0 ? (
        <p data-testid={`analysis-runs-${analysisId}-empty`} className="text-xs text-muted-foreground">
          {NO_RUNS_LABEL}
        </p>
      ) : (
        // The band's internal scroll (the pane-dragged-shorter-than-the-band case). Overlay
        // bars, like every other scroll track in the workbench — a native bar here would take
        // layout width out of a band that is already the constrained one.
        <PaneScroll axis="y" className="min-h-0" data-testid={`analysis-runs-${analysisId}-scroll`}>
          <ul className="flex flex-col gap-1">
            {runs.map(job => (
              <li key={job.id}>
                <button
                  type="button"
                  data-testid={`analysis-run-${job.id}`}
                  // The row opens the EXISTING job detail. A row that only displayed a status
                  // would answer "did it work?" and then strand the user on "why not?".
                  onClick={() => revealPane('jobs', job.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start text-xs hover:bg-accent"
                >
                  <JobStatusBadge status={job.status as never} />
                  <span className="truncate text-muted-foreground">{startedLabel(job)}</span>
                  {isRunning(job.status) ? (
                    <span className="ms-auto shrink-0 text-muted-foreground">in progress</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </PaneScroll>
      )}
    </section>
  )
}
