// LauncherPane (ITEM-20 / ITEM-28) — the analysis launcher as a dock PANE: registered
// analyses grouped by `category`, SEARCHABLE, and availability-gated (available /
// needs-<type> / arch-disabled via `backendArch`). Each row launches via the ONE
// `runAction('analysis.launch')` path, so the Launcher, the toolbar "+", ⌘K, and the
// AI share one execution path (W1). An unavailable analysis is LISTED-with-a-reason, never
// hidden (owner ruling) — and the reason is REACHABLE: these rows were natively `disabled`,
// which is pointer-events:none and no tab stop, so the reason they carried could be read by
// nobody. See `unavailableReason` in the kit Button.

import { useMemo } from 'react'
import { Alert, Button, Empty, Input, Tag } from '@txresbench/kit'
import { SlidersHorizontal } from 'lucide-react'
import { usePaneStateValue, type AnalysisContribution } from '@/modules/workbench/core'
import { runAction } from '@/core/actions/defineAction'
import { useWhenContext, useWorkbench } from '../../core/shell/WorkbenchContext'
import { launcherRowEnabled } from '../../core/shell/readOnlyGating'
import {
  byCategory,
  launcherVisibleAnalyses,
  matchesQuery,
  type LauncherRow as LauncherRowModel,
} from '../analysis/launcherAvailability'
import { type WorkbenchPane, PaneScroll } from '../../core/shell/dock/paneModel'

function AvailabilityBadge({ row }: { row: LauncherRowModel }) {
  const a = row.availability
  const testid = `workbench-launcher-badge-${row.analysis.id}`
  if (a.status === 'available') return null
  if (a.status === 'needs-type') {
    return (
      <Tag tone="warning" variant="soft" data-testid={testid}>
        needs {a.missing.join(', ')}
      </Tag>
    )
  }
  return (
    <Tag tone="default" variant="soft" data-testid={testid}>
      {a.reason}
    </Tag>
  )
}

function LauncherRow({
  row,
  canEdit,
  onLaunch,
  onOpen,
}: {
  row: LauncherRowModel
  canEdit: boolean
  onLaunch: (a: AnalysisContribution) => void
  onOpen: (a: AnalysisContribution) => void
}) {
  const { analysis, availability, launchable } = row
  // ITEM-29: launching an analysis is a DATA MUTATION (it enqueues a compute job), so a
  // viewer's rows are unavailable-with-reason (listed, never hidden — the owner ruling), and
  // the read-only reason wins over the availability reason.
  const enabled = launcherRowEnabled(launchable, canEdit)
  // `unavailableReason`, NOT `disabled` + `tooltip`. These strings are the ONLY place the
  // "why" exists for the read-only case (the arch/needs-type cases at least get a badge), and
  // on a natively `disabled` button they reached nobody: such a button is pointer-events:none
  // and out of the tab order, so neither a pointer nor a keyboard could ever surface them.
  // `!canEdit` is NO LONGER one of the causes. Both affordances on this row OPEN A FORM and
  // enqueue nothing (`analysis.launch`, now declared `mutating: false` + `ProjectsUse`), so a
  // viewer is refused by neither. The refusal a viewer DOES get is the one that is true —
  // "you cannot RUN this" — and it is stated by `AnalysisRunPanel` on the form the row opens,
  // which is a branch this component's gate used to stand in front of. What survives here are
  // the availability causes, which apply to editors and viewers alike.
  const reason = !enabled
    ? availability.status === 'needs-type'
      ? `Requires ${availability.missing.join(', ')}`
      : availability.status === 'arch-disabled'
        ? availability.reason
        : 'Not available yet'
    : undefined
  return (
    <div className="flex w-full items-center gap-1" data-testid={`workbench-launcher-item-${analysis.id}`}>
      <Button
        variant="ghost"
        unavailableReason={reason}
        // The NAME is the analysis, always — a list whose whole job is telling eight rows apart
        // must not answer "which row is this" with the same refusal sentence eight times.
        aria-label={analysis.title}
        onClick={() => onLaunch(analysis)}
        data-testid={`workbench-launcher-row-${analysis.id}`}
        data-availability={availability.status}
        className="min-w-0 flex-1 justify-start gap-2"
      >
        <span className="flex-1 truncate text-start">{analysis.title}</span>
        <AvailabilityBadge row={row} />
      </Button>
      {/* OPEN the analysis's config FORM for inspection — distinct from LAUNCH: it works even
          for an availability-gated analysis (its Run button stays gated inside the form), so a
          user can review params / previews before the inputs it needs exist. Editor-only. */}
      <Button
        variant="ghost"
        size="icon"
        // NO LONGER REFUSED FOR A VIEWER. The finding recorded here previously — that
        // `analysis.launch` only OPENS A FORM and enqueues anything, while being declared
        // `mutating` + `JobsUse` — has been resolved in favour of the doc: the action is now
        // `mutating: false` + `ProjectsUse` (see `builtin/workbenchActions.ts` for the full
        // reasoning). The claim made here, that "a viewer's click would be refused by the
        // action framework whatever this button did", was also simply FALSE: `runAction`
        // performs no permission check at all (`ActionMeta.permission` documents itself as
        // "never the enforcement point"), so this component's own `canEdit` was the entire gate.
        icon={<SlidersHorizontal className="size-3.5" />}
        // ONE string for both channels. These were two: the tooltip said "Open the analysis
        // form" while the accessible name said "Open <that analysis> form", so on a list of
        // eight analyses a pointer user got the same eight words every time and a screen-reader
        // user got the one that identified the row. Naming the analysis is the useful half, so
        // that is the string that survives — in both channels.
        tooltip={`Open ${analysis.title} form`}
        onClick={() => onOpen(analysis)}
        data-testid={`workbench-analysis-open-${analysis.id}`}
      />
    </div>
  )
}

export function LauncherPane({ pane }: { pane: WorkbenchPane }) {
  const { api, lattice, viewId, backendArch, canEdit } = useWorkbench()
  const whenCtx = useWhenContext()
  // ITEM-16: the launcher lists ONLY real, user-launchable analyses — converters
  // (`trigger:'on-ingest'`) + demos (`launchable:false`) are filtered out at this
  // choke point (registration is untouched; they stay resolvable by id).
  const analyses = launcherVisibleAnalyses(api.registry.analyses.all())
  // Keyed by PANE, not by React lifecycle: a region renders only its active tab, so a plain
  // `useState` here emptied the user's search the moment they glanced at a sibling tab.
  const [query, setQuery] = usePaneStateValue(pane.id, 'query', '')

  const groups = useMemo(
    () => byCategory(analyses.filter(a => matchesQuery(a, query)), whenCtx, lattice, backendArch),
    [analyses, query, whenCtx, lattice, backendArch],
  )
  const hasRows = groups.some(g => g.rows.length > 0)

  const launch = (a: AnalysisContribution) => {
    // NO `canEdit` GUARD. It was here as ITEM-29 defense-in-depth against launching, back when
    // launching was read as a write; now that the row is ENABLED for a viewer, keeping it would
    // be strictly worse than the defect this branch exists to fix — a live-looking button that
    // silently does nothing is a refusal with no reason in any channel at all. The write this
    // path leads to is Run, which is gated in `AnalysisRunPanel` and, authoritatively, by the
    // backend `/jobs` route.
    void runAction('analysis.launch', { view_id: viewId, analysis_id: a.id }).catch(err => {
      api.ui.notify(err instanceof Error ? err.message : String(err), 'error')
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={`workbench-launcher-${pane.id}`}>
      {!canEdit && (
        <div className="shrink-0 pb-2">
          <Alert
            tone="info"
            title="Read-only"
            description="You have viewer access — open any analysis here to read its parameters; running one needs edit access."
            data-testid={`workbench-launcher-readonly-${pane.id}`}
          />
        </div>
      )}
      <div className="shrink-0 pb-2">
        <Input
          size="sm"
          allowClear
          aria-label="Search analyses"
          placeholder="Search analyses…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          data-testid="workbench-launcher-search"
        />
      </div>
      <PaneScroll className="min-h-0 flex-1">
        <div className="flex flex-col gap-3">
          {analyses.length === 0 ? (
            <Empty
              data-testid="workbench-launcher-empty"
              title="No analyses available"
              description="Install an analysis extension to launch one here."
            />
          ) : !hasRows ? (
            <Empty
              data-testid="workbench-launcher-no-matches"
              title="No matching analyses"
              description="No analysis matches your search."
            />
          ) : (
            groups.map(group => (
              <div key={group.category} className="flex flex-col gap-1">
                <span className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.category}
                </span>
                {/* Both affordances OPEN THE ANALYSIS' FORM (analysis.launch does not itself enqueue
                    a job — Run inside the form does), so they share one handler by design. WHICH form
                    is the handler's call, not this row's: an analysis that declares `ui:` is revealed
                    in its OWN pane, and one that does not gets the run pane's slot-derived fallback
                    (INV-3/INV-4 — see `WorkbenchSection.tsx`). The two-affordance DISTINCTION lives in
                    each Button's disabled logic, not the handler: the primary title button gates on
                    availability (`enabled`), while the form (⚙) button stays open even for an
                    availability-gated analysis so a user can inspect its params — which still holds
                    for a declarative view, whose pane carries no `appliesTo` gate of its own. */}
                {group.rows.map(row => (
                  <LauncherRow key={row.analysis.id} row={row} canEdit={canEdit} onLaunch={launch} onOpen={launch} />
                ))}
              </div>
            ))
          )}
        </div>
      </PaneScroll>
    </div>
  )
}
