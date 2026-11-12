// The unknown-kind FALLBACK renderer (ITEM-9). When no `ArtifactRendererContribution`
// matches a produced artifact-kind and the built-in heuristic can't map it either,
// the host still shows SOMETHING honest: a "no specialized view" Empty plus a raw,
// JSON-ish read of the artifact record via Descriptions — never a crash, never a
// blank panel.

import { FileQuestion } from 'lucide-react'
import { Descriptions, Empty, ErrorState, ScrollArea, Spinner, type DescriptionsItem } from '@txresbench/kit'
import { useArtifact } from './useArtifact'

/** Pretty-print an opaque value for the raw read (never throws). */
function stringify(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export interface GenericResultProps {
  artifactId: string
  /** The produced kind (shown in the empty-state title when the artifact is unknown). */
  artifactKind?: string
  'data-testid'?: string
}

export function GenericResult({
  artifactId,
  artifactKind,
  'data-testid': testid = 'workbench-artifact-generic',
}: GenericResultProps) {
  const { artifact, loading, error, reload } = useArtifact(artifactId)

  if (loading) {
    return (
      <div className="flex items-center justify-center p-6">
        <Spinner label="Loading artifact…" data-testid={`${testid}-loading`} />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        resource="artifact"
        description="This artifact could not be loaded."
        details={error}
        onRetry={reload}
        data-testid={`${testid}-error`}
      />
    )
  }

  const items: DescriptionsItem[] = artifact
    ? [
        { key: 'datatype', label: 'Type', children: <code className="text-xs">{artifact.datatype}</code> },
        { key: 'output', label: 'Output', children: artifact.output_id },
        { key: 'created', label: 'Created', children: new Date(artifact.created_at).toLocaleString() },
        // ITEM-7 replaced the `shape` + `params` rows with the two producer declarations
        // that succeeded them. This renderer is the RAW-RECORD fallback, so it shows both
        // verbatim rather than picking fields out of them: `structure` is how the bytes
        // decode, `meta` is what the producer said they mean. Neither has a schema this
        // renderer is entitled to assume — that is the point of a raw read.
        {
          key: 'structure',
          label: 'Structure',
          children: (
            <ScrollArea className="max-h-40">
              <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {stringify(artifact.structure)}
              </pre>
            </ScrollArea>
          ),
        },
        {
          key: 'meta',
          label: 'Meta',
          children: (
            <ScrollArea className="max-h-40">
              <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {stringify(artifact.meta)}
              </pre>
            </ScrollArea>
          ),
        },
      ]
    : []

  return (
    <div className="flex flex-col gap-4 p-4" data-testid={testid}>
      <Empty
        icon={<FileQuestion />}
        title={`No specialized view for “${artifactKind ?? artifact?.datatype ?? 'this artifact'}”`}
        description="Showing the raw artifact record below."
        data-testid={`${testid}-empty`}
      />
      {artifact && (
        <Descriptions items={items} column={1} bordered size="sm" data-testid={`${testid}-raw`} />
      )}
    </div>
  )
}
