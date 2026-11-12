// The methods / provenance renderer (ITEM-9). Reads how an artifact was produced:
// an optional methods paragraph (an analysis' `methodsText`), the provenance fields off
// the artifact record, and the PARAMETERS the producing run was given. A reference-grade
// deliverable answers "how was this computed?" — this is that read. Nothing to show → a
// graceful Empty, never a crash.
//
// ── ITEM-7: WHERE THE RUN PARAMETERS WENT ──────────────────────────────────────────
//
// This view used to fall back to `artifact.params`. That column is dropped and has NO
// successor on the artifact row: `meta` is what the bytes MEAN, not what was passed to
// the job that made them, and re-reading run inputs out of `meta` would restate in one
// column exactly what dropping `params` removed.
//
// The run's parameters live on the RUN, so the section is wired to the run rather than
// re-pointed at another artifact column: `artifact.run_id` → `Provenance.run({id})` →
// `RunNodeDto.params`, read through the SAME `@/core/provenance` `useRunNode` hook the
// sibling `ArtifactLineage` uses (the generated `ApiClient`, never a raw fetch). One
// artifact, one run read; `useRunNode` no-ops on a null id, so an artifact with no
// producing run issues no request at all.
//
// `ArtifactLineage` renders this view UNDER a run it has already loaded, so it passes
// that node down through the `run` prop and this view skips its own read — the run is
// fetched once per rendered run, not once per component that wants a field off it.
//
// ── FOUR DISTINCT ANSWERS, NEVER FOLDED (INV-2) ────────────────────────────────────
//
// "no parameters" is not one state, and rendering the four as one blank section is how a
// failed read ends up shown to a user as a fact about the data:
//
//   no `run_id`      a source/upload artifact was not produced by a run, so there are no
//                    run parameters to have. An ABSENCE, rendered as one — never `{}`.
//   read failed      we do not KNOW what the run was given (403 / 404 / network). Says
//                    so, and says why. Claiming "no parameters" here would be quietly
//                    wrong.
//   run, no params   the run itself recorded none. A fact about the run.
//   run with params  the rows.

import { Alert, Descriptions, Empty, ErrorState, Spinner, type DescriptionsItem } from '@txresbench/kit'
import type { RunNodeDto } from '@/api-client/types'
import { useRunNode } from '@/core/provenance'
import { useArtifact } from '../../core/render/useArtifact'

/**
 * Turn a run's recorded params value into label/value rows.
 *
 * A plain object becomes one row per key. A non-object — `RunNodeDto.params` is the
 * run's recorded JSON, so it is only CONVENTIONALLY an object — becomes ONE row carrying
 * the value verbatim rather than vanishing: a recorded parameter set this renderer
 * cannot shape into rows is still something the run was given, and dropping it silently
 * would report "no parameters" for a run that had some.
 */
function toParamItems(params: unknown): DescriptionsItem[] {
  if (params == null) return []
  if (typeof params !== 'object' || Array.isArray(params)) {
    return [
      {
        key: '__value__',
        label: 'params',
        children: <code className="text-xs [overflow-wrap:anywhere]">{JSON.stringify(params)}</code>,
      },
    ]
  }
  return Object.entries(params as Record<string, unknown>).map(([k, v]) => ({
    key: k,
    label: k,
    children: <code className="text-xs">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</code>,
  }))
}

export interface ProvenanceViewProps {
  artifactId: string
  /** Optional methods paragraph (e.g. an analysis' `methodsText`). */
  methodsText?: string
  /**
   * The producing run, when the CALLER already holds it (`ArtifactLineage` reads the
   * same node to draw its chain). Supplied ⇒ this view renders the parameters off it and
   * issues NO read of its own; omitted ⇒ it reads the run named by `artifact.run_id`.
   */
  run?: RunNodeDto | null
  'data-testid'?: string
}

export function ProvenanceView({
  artifactId,
  methodsText,
  run,
  'data-testid': testid = 'workbench-artifact-provenance',
}: ProvenanceViewProps) {
  const { artifact, loading, error, reload } = useArtifact(artifactId)
  // `undefined` = the caller supplied nothing, so this view owns the read. An explicit
  // `null` is a caller stating there is no run, which must not trigger one either.
  const runSupplied = run !== undefined
  const own = useRunNode(runSupplied ? null : (artifact?.run_id ?? null))
  const runNode = runSupplied ? run : own.run
  const runLoading = !runSupplied && own.loading
  const runError = runSupplied ? null : own.error

  if (loading) {
    return (
      <div className="flex items-center justify-center p-6">
        <Spinner label="Loading provenance…" data-testid={`${testid}-loading`} />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        resource="provenance"
        description="This artifact's provenance could not be loaded."
        details={error}
        onRetry={reload}
        data-testid={`${testid}-error`}
      />
    )
  }

  const provItems: DescriptionsItem[] = artifact
    ? [
        { key: 'datatype', label: 'Produced type', children: <code className="text-xs">{artifact.datatype}</code> },
        { key: 'run', label: 'Run', children: artifact.run_id ?? '—' },
        { key: 'created', label: 'Created', children: new Date(artifact.created_at).toLocaleString() },
        { key: 'hash', label: 'Content hash', children: <code className="text-xs [overflow-wrap:anywhere]">{artifact.content_hash}</code> },
      ]
    : []

  if (methodsText == null && provItems.length === 0) {
    return <Empty title="No provenance recorded" data-testid={`${testid}-empty`} />
  }

  const paramItems = toParamItems(runNode?.params)

  return (
    <div className="flex flex-col gap-4 p-4" data-testid={testid}>
      {methodsText != null && (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Methods</span>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{methodsText}</p>
        </div>
      )}
      {provItems.length > 0 && (
        <Descriptions title="Provenance" items={provItems} column={1} bordered size="sm" data-testid={`${testid}-prov`} />
      )}
      {artifact &&
        (paramItems.length > 0 ? (
          <Descriptions
            title="Parameters"
            items={paramItems}
            column={2}
            bordered
            size="sm"
            data-testid={`${testid}-params`}
          />
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Parameters</span>
            {artifact.run_id == null ? (
              <p className="text-sm text-muted-foreground" data-testid={`${testid}-params-no-run`}>
                Not produced by a run — this artifact has no run parameters.
              </p>
            ) : runLoading ? (
              <Spinner label="Loading parameters…" data-testid={`${testid}-params-loading`} />
            ) : runError != null ? (
              <Alert
                tone="warning"
                title="Parameters could not be read"
                description={runError}
                data-testid={`${testid}-params-error`}
              />
            ) : (
              <p className="text-sm text-muted-foreground" data-testid={`${testid}-params-empty`}>
                This run recorded no parameters.
              </p>
            )}
          </div>
        ))}
    </div>
  )
}
