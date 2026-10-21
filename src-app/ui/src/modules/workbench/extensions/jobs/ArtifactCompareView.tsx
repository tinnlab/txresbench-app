// Multi-artifact COMPARE view (ITEM-39). Dispatches N artifact ids of the same produced
// kind: a registered compare renderer receives ALL ids in ONE dispatch (a merged /
// side-by-side view — N volcanoes, a clustree — expressible as one renderer); else the
// pane tiles N single `ArtifactPanel`s side-by-side (the modern form of the legacy
// pop-out-N-tabs compare), scrolling horizontally inside its own container. The
// dispatch decision is the pure, unit-tested `dispatchCompare`.

import { ScrollArea } from '@ziee/kit'
import { ArtifactPanel } from './ArtifactPanel'
import { dispatchCompare } from '../../core/contributions/artifactRegistry'

export interface ArtifactCompareViewProps {
  artifactKind: string
  artifactIds: string[]
  'data-testid'?: string
}

export function ArtifactCompareView({
  artifactKind,
  artifactIds,
  'data-testid': testid = 'workbench-artifact-compare',
}: ArtifactCompareViewProps) {
  const dispatch = dispatchCompare(artifactKind, artifactIds)

  if (dispatch.mode === 'named') {
    const Compare = dispatch.component
    return (
      <div className="min-h-0" data-testid={`${testid}-named`}>
        <Compare artifactIds={dispatch.artifactIds} />
      </div>
    )
  }

  // Tiled: N single artifact panes side-by-side. Each tile keeps a readable min width and
  // shares the free width; the row scrolls horizontally inside its own container.
  return (
    <ScrollArea axis="x" className="min-h-0" data-testid={`${testid}-tiled`}>
      <div className="flex min-h-0 gap-3">
        {dispatch.artifactIds.map(id => (
          <div key={id} className="min-w-80 flex-1" data-testid={`${testid}-tile-${id}`}>
            <ArtifactPanel artifactKind={artifactKind} artifactId={id} />
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
