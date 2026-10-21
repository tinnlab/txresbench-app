// ArtifactPanel (ITEM-9 / ITEM-58 / ITEM-35) — the host-owned artifact-panel DISPATCHER.
// A produced artifact's `artifactKind` is classified by the pure `defaultForKind` into one of
// the three host renderers: `StatCard` (stat/metric), `ProvenanceView` (provenance/methods)
// or the universal `GenericResult` fallback. Nothing crashes the panel, and an UNKNOWN
// datatype ALWAYS renders the generic fallback — the "must always render something"
// guarantee (TEST-523).
//
// ITEM-35 removed the `resultRenderers` contribution branch that used to win over the
// default: the registry had ZERO production contributors, so the branch was unreachable —
// and with it went ITEM-31's `StandardResultTable`, which that branch was the only path to.

import type { ReactNode } from 'react'
import { StatCard } from '../../core/render/StatCard'
import { ProvenanceView } from '../provenance/ProvenanceView'
import { GenericResult } from '../../core/render/GenericResult'
import { defaultForKind, type DefaultArtifactKind } from '../../core/contributions/artifactRegistry'

export interface ArtifactPanelProps {
  artifactKind: string
  artifactId: string
  'data-testid'?: string
}

/** Render the host renderer for a classified kind. StatCard + GenericResult receive
 *  `artifactKind` as extra context; ProvenanceView needs only the artifact. */
function renderDefault(kind: DefaultArtifactKind, artifactKind: string, artifactId: string): ReactNode {
  if (kind === 'stat') return <StatCard artifactId={artifactId} artifactKind={artifactKind} />
  if (kind === 'provenance') return <ProvenanceView artifactId={artifactId} />
  return <GenericResult artifactId={artifactId} artifactKind={artifactKind} />
}

export function ArtifactPanel({ artifactKind, artifactId, 'data-testid': testid }: ArtifactPanelProps) {
  const wrapperTestid = testid ?? `workbench-artifact-${artifactKind}`

  return (
    <div className="h-full min-h-0" data-testid={wrapperTestid}>
      {renderDefault(defaultForKind(artifactKind), artifactKind, artifactId)}
    </div>
  )
}
