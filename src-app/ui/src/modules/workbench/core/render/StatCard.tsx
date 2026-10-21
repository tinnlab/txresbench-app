// The KPI / stat-card renderer (ITEM-9) for scalar-ish artifact kinds (metrics,
// QC scores, counts). No dedicated scalar endpoint exists yet, so this draws an
// HONEST headline from the artifact record itself — its DECLARED dimensions
// (`structure`, ITEM-7) + byte size — via kit Statistic inside a Card. A
// `metric`/`stat` kind that carries no numbers degrades to a graceful Empty rather
// than a fabricated figure.

import { Card, Empty, ErrorState, Spinner, Statistic, Tag } from '@ziee/kit'
import { declaredDimsForDisplay } from '@/core/workstore'
import { useArtifact } from './useArtifact'

const DIM_LABELS = ['Rows', 'Columns', 'Depth', 'Dim 4', 'Dim 5']

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export interface StatCardProps {
  artifactId: string
  /** The produced kind (used as the card title when present). */
  artifactKind?: string
  'data-testid'?: string
}

export function StatCard({
  artifactId,
  artifactKind,
  'data-testid': testid = 'workbench-artifact-stat',
}: StatCardProps) {
  const { artifact, loading, error, reload } = useArtifact(artifactId)

  if (loading) {
    return (
      <div className="flex items-center justify-center p-6">
        <Spinner label="Loading metric…" data-testid={`${testid}-loading`} />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        resource="metric"
        description="This artifact could not be loaded."
        details={error}
        onRetry={reload}
        data-testid={`${testid}-error`}
      />
    )
  }

  if (!artifact) {
    return <Empty title="No metric to display" data-testid={`${testid}-empty`} />
  }

  // ITEM-7: the DECLARED dimensions, off `structure`. An artifact whose declaration this
  // client cannot read contributes none — the card's contract is "degrades to a graceful
  // Empty rather than a fabricated figure", and a `Rows: 0` statistic is precisely a
  // fabricated figure.
  //
  // `Size` obeys the SAME rule, which it previously did not. It used to render
  // `size_bytes` unconditionally, justified as "a scalar the server records without
  // opening a byte" — true of a stored artifact, and false of a GATHERED one, whose
  // stored-byte count is 0 because it owns no blob. So this card put
  // `Rows: 500000 · Cols: 1 · Size: 0 Bytes` on screen: the one statistic that was
  // fabricated was the one exempted from the no-fabrication rule.
  //
  // `logical_bytes` is the size the data represents, and it is OPTIONAL on the wire
  // precisely so that "unknown" cannot be silently spelled `0`. Absent ⇒ the Size
  // statistic is omitted, exactly as an unreadable dimension is omitted. Never read
  // `stored_bytes` here: that column answers a storage question (it exists for the
  // provenance export's size cap) and is not a display size.
  const d = declaredDimsForDisplay(artifact.id, artifact.structure)
  const logicalBytes = artifact.logical_bytes

  return (
    <div className="p-4" data-testid={testid}>
      <Card
        title={artifactKind ?? artifact.datatype}
        extra={
          <Tag tone="info" data-testid={`${testid}-type`}>
            {artifact.datatype}
          </Tag>
        }
        data-testid={`${testid}-card`}
      >
        <div className="flex flex-wrap gap-6">
          {d.map((n, i) => (
            <Statistic
              key={i}
              title={DIM_LABELS[i] ?? `Dim ${i + 1}`}
              value={n}
              data-testid={`${testid}-dim-${i}`}
            />
          ))}
          {logicalBytes !== undefined && logicalBytes !== null && (
            <Statistic
              title="Size"
              value={formatBytes(logicalBytes)}
              data-testid={`${testid}-size`}
            />
          )}
        </div>
      </Card>
    </div>
  )
}
