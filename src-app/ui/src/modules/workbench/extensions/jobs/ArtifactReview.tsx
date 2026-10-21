// Multi-output artifact review (ITEM-24 + ITEM-25 + ITEM-27 + ITEM-39) — the
// deterministic review of ONE run's outputs. `listArtifacts({project_id, run_id})`
// yields EXACTLY the artifacts the run produced (fixing the racy `pickNewest`).
// Outputs are grouped by produced kind: a single artifact renders through the
// host-owned `ArtifactPanel` (→ its registered renderer, else the honest default); a
// group of ≥2 same-kind artifacts renders through `ArtifactCompareView` (a registered
// compare renderer, else tiled panes — ITEM-39). Below the cards: the compact lineage
// (ITEM-25) and the "start next analysis" chaining chips (ITEM-27).

import { useEffect } from 'react'
import { Button, Card, Empty, ErrorState, SectionHeader, Separator, Spinner, Tag } from '@ziee/kit'
import type { Artifact } from '@/api-client/types'
import { ArtifactPanel } from './ArtifactPanel'
import { ArtifactCompareView } from './ArtifactCompareView'
import { ArtifactLineage } from '../provenance/ArtifactLineage'
import { ArtifactChaining } from './ArtifactChaining'
import { useRunArtifacts } from './useRunArtifacts'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { workbenchDockStore } from '../../core/shell/dock/WorkbenchDock.store'
import { revealPane } from '../../core/shell/regions/openPane'
import { DeleteArtifactButton } from './DeleteArtifactButton'

export interface ArtifactReviewProps {
  /** the run whose outputs are reviewed. */
  runId: string
  /** the producing analysis (excluded from chaining candidates; drives methods text). */
  producedByAnalysisId?: string
  /** the analysis' methods paragraph (`methodsText(params)`), if known at run time. */
  methodsText?: string
  /** fired once the run's outputs resolve — the run pane binds itself to the primary
   *  artifact so it self-closes if that artifact is deleted (ITEM-19). */
  onArtifactsLoaded?: (artifacts: Artifact[]) => void
  'data-testid'?: string
}

/** Group a run's artifacts by produced datatype, preserving first-seen order. */
function groupByKind(artifacts: Artifact[]): { kind: string; items: Artifact[] }[] {
  const order: string[] = []
  const groups = new Map<string, Artifact[]>()
  for (const a of artifacts) {
    if (!groups.has(a.datatype)) {
      groups.set(a.datatype, [])
      order.push(a.datatype)
    }
    groups.get(a.datatype)!.push(a)
  }
  return order.map(kind => ({ kind, items: groups.get(kind)! }))
}

export function ArtifactReview({
  runId,
  producedByAnalysisId,
  methodsText,
  onArtifactsLoaded,
  'data-testid': testid = 'workbench-artifact-review',
}: ArtifactReviewProps) {
  const { projectId, canEdit } = useWorkbench()
  const { artifacts, loading, error, reload } = useRunArtifacts(projectId, runId)

  // Notify once the outputs resolve (the run pane binds to the primary artifact).
  useEffect(() => {
    if (!loading && !error && artifacts.length > 0) onArtifactsLoaded?.(artifacts)
  }, [loading, error, artifacts, onArtifactsLoaded])

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner label="Loading artifacts…" data-testid={`${testid}-loading`} />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        resource="artifacts"
        description="This run's outputs could not be loaded."
        details={error}
        onRetry={reload}
        data-testid={`${testid}-error`}
      />
    )
  }

  if (artifacts.length === 0) {
    return (
      <Empty
        title="No outputs"
        description="This run produced no artifacts."
        data-testid={`${testid}-empty`}
      />
    )
  }

  const groups = groupByKind(artifacts)

  return (
    <div className="flex min-h-0 flex-col gap-4" data-testid={testid}>
      {/* The iteration-loop entry (ITEM-63): re-run THIS run with tweaked params. Opens a
          re-run pane pre-seeded with the run's params + a before/after diff. Editors only. */}
      {canEdit && (
        <SectionHeader
          data-testid={`${testid}-actions`}
          title={<span className="text-sm font-medium">Artifacts</span>}
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => revealPane('rerun', runId)}
                data-testid={`${testid}-rerun`}
              >
                Re-run with tweaked params
              </Button>
              {/* Delete the produced artifact. Owner/Editor only (the button self-hides for a
                  Viewer, matching the backend `require_project_edit`). On success the bound run
                  pane self-closes locally (ITEM-19); a route mount reloads its cards. */}
              <DeleteArtifactButton
                artifactId={artifacts[0].id}
                testid={`${testid}-delete`}
                onDeleted={reload}
              />
            </div>
          }
        />
      )}

      <div className="flex flex-col gap-4">
        {groups.map(group => {
          const first = group.items[0]
          const multi = group.items.length > 1
          return (
            <Card
              key={group.kind}
              title={
                <span className="flex items-center gap-2">
                  <span className="truncate">{multi ? `${group.kind} (${group.items.length})` : first.output_id}</span>
                  <Tag tone="info" variant="soft" data-testid={`${testid}-kind-${group.kind}`}>
                    {group.kind}
                  </Tag>
                </span>
              }
              data-testid={`${testid}-card-${group.kind}`}
            >
              <div className="flex flex-col gap-3">
                {multi ? (
                  <ArtifactCompareView artifactKind={group.kind} artifactIds={group.items.map(a => a.id)} />
                ) : (
                  <ArtifactPanel artifactKind={group.kind} artifactId={first.id} />
                )}
                <ArtifactChaining
                  producedDatatype={group.kind}
                  artifactId={first.id}
                  producedByAnalysisId={producedByAnalysisId}
                />
              </div>
            </Card>
          )
        })}
      </div>

      <Separator />

      {/* The compact inputs → run → outputs lineage (ITEM-25). */}
      <ArtifactLineage runId={runId} outputs={artifacts} methodsText={methodsText} />
    </div>
  )
}
