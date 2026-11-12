import { useState } from 'react'
import type { ArtifactNodeDto } from '@/api-client/types'
import { Button, Empty, ErrorState, Spinner, Tag, message } from '@txresbench/kit'
import { DatasetDetail } from '@/modules/datasets/stores/DatasetDetail.store'
import { useNavigate } from 'react-router-dom'
import { ArrowUpFromLine, Database, GitCommitVertical, Package } from 'lucide-react'
import { datatypeLabel, shortHash } from '@/modules/datasets/lib/format'

/**
 * The dataset's FORWARD provenance lineage (DEC-20): dataset → derived runs →
 * their output artifacts/intermediates, from `GET /provenance/forward?dataset_id=`.
 * An output `artifact` can be PROMOTED into a new owned dataset (DEC-7); a
 * byte-preserving promote records a `promote` run node so the chain crosses the
 * boundary. Reproducibility export is project-scoped, so it lives on the project side
 * once the dataset is attached (DEC-5) — not offered here.
 */
export function LineageView({ datasetName }: { datasetName: string }) {
  const { dataset, forward, lineageLoading, lineageError, promoting } = DatasetDetail
  const navigate = useNavigate()
  const [promotingId, setPromotingId] = useState<string | null>(null)

  const promote = async (output: ArtifactNodeDto) => {
    setPromotingId(output.id)
    try {
      const created = await DatasetDetail.promote(output.id, `${datasetName} — ${output.output_id}`)
      message.success('Promoted to a new dataset')
      if (created) navigate(`/datasets/${created.id}`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to promote')
    } finally {
      setPromotingId(null)
    }
  }

  if (lineageError) {
    return (
      <ErrorState
        resource="lineage"
        description={lineageError}
        onRetry={() => dataset && DatasetDetail.loadLineage(dataset.id)}
        data-testid="dataset-lineage-error"
      />
    )
  }
  if (lineageLoading && !forward) {
    return (
      <div className="flex justify-center py-12" data-testid="dataset-lineage-loading">
        <Spinner label="Loading lineage" />
      </div>
    )
  }
  // The empty state has to name a surface the user can actually reach. It used to say
  // "run a processor on the Pipeline tab"; `e4ac4af7` removed that tab on purpose
  // ("processing lives in the workbench/analysis flow"), so the instruction pointed at
  // nothing. The live path is: attach the dataset to a project, open that project's
  // workbench, and launch from its "Analyses" panel — the launcher pane
  // `tests/e2e/14-workbench/analysis-launcher.spec.ts` drives.
  if (!forward || (forward.runs.length === 0 && forward.outputs.length === 0)) {
    return (
      <Empty
        description="No derivations yet — attach this dataset to a project, then launch an analysis from the workbench's Analyses panel to build lineage."
        data-testid="dataset-lineage-empty"
      />
    )
  }

  return (
    <div className="flex flex-col gap-4" data-testid="dataset-lineage">
      {/* Dataset root */}
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Database className="size-4" aria-hidden />
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-medium">{datasetName}</span>
          <span className="text-xs text-muted-foreground">{shortHash(forward.content_hash)}</span>
        </div>
      </div>

      {/* Runs */}
      {forward.runs.length > 0 ? (
        <div className="ms-4 flex flex-col gap-2 border-s border-border ps-6" data-testid="dataset-lineage-runs">
          <span className="text-xs font-medium text-muted-foreground">Derived runs</span>
          {forward.runs.map(run => (
            <div
              key={run.run_id}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              data-testid={`dataset-lineage-run-${run.run_id}`}
            >
              <span className="flex items-center gap-2 text-sm">
                <GitCommitVertical className="size-4 text-muted-foreground" aria-hidden />
                {run.generator_id}
                <span className="text-xs text-muted-foreground">v{run.generator_version}</span>
              </span>
              <Tag
                tone={run.status === 'completed' ? 'success' : run.status === 'failed' ? 'error' : 'info'}
                variant="soft"
                data-testid={`dataset-lineage-run-status-${run.run_id}`}
              >
                {run.kind === 'promote' ? 'promote' : run.status}
              </Tag>
            </div>
          ))}
        </div>
      ) : null}

      {/* Outputs */}
      {forward.outputs.length > 0 ? (
        <div className="ms-4 flex flex-col gap-2 border-s border-border ps-6" data-testid="dataset-lineage-outputs">
          <span className="text-xs font-medium text-muted-foreground">Outputs</span>
          {forward.outputs.map(output => (
            <div
              key={output.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2"
              data-testid={`dataset-lineage-output-${output.id}`}
            >
              <span className="flex items-center gap-2 text-sm">
                <Package className="size-4 text-muted-foreground" aria-hidden />
                <span className="font-medium">{output.output_id}</span>
                <Tag variant="outline" tone="primary" data-testid={`dataset-lineage-output-type-${output.id}`}>
                  {datatypeLabel(output.datatype)}
                </Tag>
              </span>
              {/* Promote is offered ONLY for a dataset-INPUT artifact (server-computed
                  `promotable` = some contributed on-ingest converter ACCEPTS this
                  datatype, so the upload pipeline can expand it into a whole dataset).
                  A COMPONENT datatype — one such an expansion PRODUCES rather than
                  consumes — is a piece inside a dataset, not a standalone dataset, so
                  it offers no Promote. */}
              {output.promotable ? (
                <Button
                  variant="outline"
                  loading={promoting && promotingId === output.id}
                  disabled={promoting}
                  onClick={() => promote(output)}
                  data-testid={`dataset-lineage-promote-${output.id}`}
                >
                  <ArrowUpFromLine className="mr-1 size-4" /> Promote
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
