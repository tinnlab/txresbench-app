// The compact in-artifact LINEAGE view (ITEM-25) — the linear inputs → run → outputs
// chain for one run, read from `Provenance.run`, with the methods/params detail reused
// from `ProvenanceView`. This is the per-artifact view; the project-wide interactive
// artifact-lineage DAG is ITEM-61 (a separate pane, not built here). Loading / error /
// empty states are honest, never a crash.

import { ArrowRight } from 'lucide-react'
import { Empty, ErrorState, Spinner, Tag } from '@ziee/kit'
import type { Artifact } from '@/api-client/types'
// The run node comes from the app-level `@/core/provenance` read, not from the `jobs`
// extension that used to own it: a hook three extensions consume is not one extension's
// internal, and reaching for it there was a layer-boundary violation this file carried.
import { useRunNode } from '@/core/provenance'
import { ProvenanceView } from './ProvenanceView'

export interface ArtifactLineageProps {
  runId: string
  /** the run's produced artifacts (already loaded by the review) — the RIGHT side. */
  outputs: Artifact[]
  /** an optional methods paragraph (the analysis' `methodsText(params)`). */
  methodsText?: string
  'data-testid'?: string
}

/** A short id for a chain node label. */
function short(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}

export function ArtifactLineage({
  runId,
  outputs,
  methodsText,
  'data-testid': testid = 'workbench-artifact-lineage',
}: ArtifactLineageProps) {
  const { run, loading, error, reload } = useRunNode(runId)

  if (loading) {
    return (
      <div className="flex items-center justify-center p-4">
        <Spinner label="Loading lineage…" data-testid={`${testid}-loading`} />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        resource="lineage"
        description="This run's lineage could not be loaded."
        details={error}
        onRetry={reload}
        data-testid={`${testid}-error`}
      />
    )
  }

  if (!run) {
    return <Empty title="No lineage recorded" data-testid={`${testid}-empty`} />
  }

  const inputs = run.inputs ?? []
  // The primary output drives the reused ProvenanceView (methods/hash), and the run
  // node above drives its Parameters section.
  const primary = outputs[0]

  return (
    <div className="flex flex-col gap-3 p-1" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid={`${testid}-chain`}>
        {/* inputs → run → outputs */}
        <div className="flex flex-wrap items-center gap-1" data-testid={`${testid}-inputs`}>
          {inputs.length === 0 ? (
            <Tag tone="default" variant="soft" data-testid={`${testid}-no-inputs`}>
              no inputs
            </Tag>
          ) : (
            inputs.map(inp => (
              <Tag
                key={`${inp.slot}:${inp.ref_id ?? inp.content_hash}`}
                tone="info"
                variant="soft"
                data-testid={`${testid}-input-${inp.slot}`}
              >
                {inp.slot}: {short(inp.ref_id ?? inp.content_hash)}
              </Tag>
            ))
          )}
        </div>
        <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
        <Tag tone="primary" variant="soft" data-testid={`${testid}-run`}>
          {run.generator_id} · {run.status}
        </Tag>
        <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
        <div className="flex flex-wrap items-center gap-1" data-testid={`${testid}-outputs`}>
          {outputs.length === 0 ? (
            <Tag tone="default" variant="soft" data-testid={`${testid}-no-outputs`}>
              no outputs
            </Tag>
          ) : (
            outputs.map(a => (
              <Tag key={a.id} tone="success" variant="soft" data-testid={`${testid}-output-${a.id}`}>
                {a.datatype}
              </Tag>
            ))
          )}
        </div>
      </div>

      {primary && (
        // The run is ALREADY loaded here (it is what this view draws), so hand it down
        // rather than letting the detail view re-read the same node for its Parameters
        // section: one `Provenance.run` request per rendered run.
        <ProvenanceView
          artifactId={primary.id}
          methodsText={methodsText}
          run={run}
          data-testid={`${testid}-detail`}
        />
      )}
    </div>
  )
}
