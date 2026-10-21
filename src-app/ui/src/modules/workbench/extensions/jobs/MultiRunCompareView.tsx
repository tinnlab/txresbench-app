// Multi-run compare view (ITEM-65) — PRESENTATIONAL. Aligns N runs' params→outcomes
// into a shared metric×run table (the multi-resolution / clustree-style compare) with a
// shared run→color legend and cross-highlight (selecting a run in the legend emphasizes
// its whole column). Below the table, when the runs' primary outputs share a produced
// kind, it composes the EXISTING `ArtifactCompareView` (ITEM-39) so the per-kind compare
// renderer (overlaid volcano / clustree) draws the plot side — reusing the compare spine
// rather than a new renderer. Alignment logic is the pure, unit-tested
// `buildMultiRunCompare` (TEST-536).
//
// SHARED COLOR / SELECTION: the legend fixes each run's color (chart tokens) above BOTH
// the table and the plot, and the selected run emphasizes its table column. The plot
// side reuses the same run ORDER; driving a per-run highlight INTO a module's compare
// renderer needs a renderer-side prop it doesn't expose yet (follow-on).

import { useState } from 'react'
import { Button, Empty, SectionHeader, Table, Tag, type TableColumn } from '@ziee/kit'
import { ArtifactCompareView } from './ArtifactCompareView'
import { buildMultiRunCompare, type CompareCell, type CompareRow, type RunObservablesEntry } from './multiRunCompare'

export interface MultiRunCompareViewProps {
  entries: RunObservablesEntry[]
  /** The runs' primary outputs of a shared produced kind → the plot compare (overlaid
   *  volcano / clustree) via the existing per-kind compare seam. Omitted → table only. */
  compare?: { kind: string; artifactIds: string[] }
  'data-testid'?: string
}

/** Cycle the sanctioned data-viz series tokens for the run swatches (never a raw hue). */
const CHART_BG = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'] as const
function runColor(i: number): string {
  return CHART_BG[i % CHART_BG.length]
}

function fmtCell(v: CompareCell): string {
  if (v === null) return '—'
  return typeof v === 'number' ? v.toLocaleString() : v
}

export function MultiRunCompareView({
  entries,
  compare,
  'data-testid': testid = 'workbench-multi-run-compare',
}: MultiRunCompareViewProps) {
  const [selectedRun, setSelectedRun] = useState<number | null>(null)

  if (entries.length === 0) {
    return (
      <Empty
        title="No runs to compare"
        description="Select two or more completed runs to compare their params and outcomes."
        data-testid={`${testid}-empty`}
      />
    )
  }

  const model = buildMultiRunCompare(entries)

  const columns: TableColumn<CompareRow>[] = [
    {
      key: 'metric',
      title: 'Metric',
      render: r => (
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm">{r.key}</span>
          <Tag tone={r.kind === 'param' ? 'default' : 'info'} variant="soft" data-testid={`${testid}-kind-${r.key}`}>
            {r.kind}
          </Tag>
          {r.varies && (
            <Tag tone="warning" variant="soft" data-testid={`${testid}-varies-${r.key}`}>
              varies
            </Tag>
          )}
        </span>
      ),
    },
    ...model.runs.map((run, i) => ({
      key: `run-${run.runId}`,
      title: (
        <span className="flex items-center justify-end gap-1.5">
          <span aria-hidden className={`inline-block size-2 rounded-full ${runColor(i)}`} />
          <span className="truncate">{run.label}</span>
        </span>
      ),
      numeric: true,
      render: (r: CompareRow) => (
        <span
          className={`tabular-nums text-sm ${selectedRun === i ? 'font-medium text-foreground' : ''}`}
          data-testid={`${testid}-cell-${r.key}-${i}`}
        >
          {fmtCell(r.values[i])}
        </span>
      ),
    })),
  ]

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid={testid}>
      <SectionHeader
        data-testid={`${testid}-header`}
        title={<span className="text-sm font-medium">Compare {model.runs.length} runs</span>}
        description="Swept params and their outcomes, aligned. Rows tagged “varies” are the ones your tweak moved."
      />

      {/* Shared run→color legend — the selection control (emphasizes the run's column). */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Runs">
        {model.runs.map((run, i) => {
          const active = selectedRun === i
          return (
            <Button
              key={run.runId}
              variant="outline"
              onClick={() => setSelectedRun(active ? null : i)}
              aria-pressed={active}
              className={active ? 'ring-2 ring-ring' : 'text-muted-foreground'}
              data-testid={`${testid}-legend-${i}`}
            >
              <span aria-hidden className={`inline-block size-2 rounded-full ${runColor(i)}`} />
              <span className="max-w-40 truncate">{run.label}</span>
            </Button>
          )
        })}
      </div>

      <Table columns={columns} dataSource={model.rows} rowKey={r => `${r.kind}:${r.key}`} data-testid={`${testid}-table`} />

      {/* The plot side (overlaid volcano / clustree) via the existing compare seam. */}
      {compare && compare.artifactIds.length > 0 && (
        <div className="flex min-h-0 flex-col gap-1.5" data-testid={`${testid}-plot`}>
          <span className="text-xs text-muted-foreground">Outputs · {compare.kind}</span>
          <ArtifactCompareView artifactKind={compare.kind} artifactIds={compare.artifactIds} />
        </div>
      )}
    </div>
  )
}
