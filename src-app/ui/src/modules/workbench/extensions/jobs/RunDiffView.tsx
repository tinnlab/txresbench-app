// Before/after run-diff view (ITEM-63) — PRESENTATIONAL. Given two runs' extracted
// observables (the predecessor + the re-run), it renders the key observables
// side-by-side with the delta highlighted, so the user immediately sees which
// observable moved after a param tweak. The data-loading wrapper
// (`RerunPane`) fetches each run's artifacts and passes the entries here; the gallery
// mounts it directly with seeded entries (backend-free). Diff logic is the pure,
// unit-tested `buildRunDiff` (TEST-532).

import { Alert, Button, SectionHeader, Table, Tag, type TableColumn } from '@txresbench/kit'
import { buildRunDiff, type DiffRow, type RunObservablesEntry } from './runDiff'

export interface RunDiffViewProps {
  before: RunObservablesEntry
  after: RunObservablesEntry
  /** When present, a "Compare runs" action opens the N-run compare on these two runs
   *  (the host wires it to the dock; the gallery omits it to stay presentational). */
  onCompare?: () => void
  'data-testid'?: string
}

function fmt(n: number | null): string {
  return n === null ? '—' : n.toLocaleString()
}

function fmtDelta(d: number | null): string {
  if (d === null) return '—'
  if (d === 0) return '0'
  return d > 0 ? `+${d.toLocaleString()}` : d.toLocaleString()
}

/** Tone for a diff row's Δ tag — neutral about "good/bad" (a smaller extent isn't
 *  inherently better): `changed` is emphasized (warning-soft = "this moved"), `added`
 *  is info, `removed`/`same` stay quiet. */
function statusTone(status: DiffRow['status']): 'info' | 'warning' | 'default' {
  if (status === 'changed') return 'warning'
  if (status === 'added') return 'info'
  return 'default'
}

export function RunDiffView({ before, after, onCompare, 'data-testid': testid = 'workbench-run-diff' }: RunDiffViewProps) {
  const diff = buildRunDiff(before.observables, after.observables)

  const columns: TableColumn<DiffRow>[] = [
    { key: 'metric', title: 'Observable', render: r => <span className="text-sm">{r.key}</span> },
    { key: 'before', title: before.label, numeric: true, render: r => <span className="tabular-nums text-sm">{fmt(r.before)}</span> },
    { key: 'after', title: after.label, numeric: true, render: r => <span className="tabular-nums text-sm">{fmt(r.after)}</span> },
    {
      key: 'delta',
      title: 'Δ',
      numeric: true,
      render: r =>
        r.status === 'same' ? (
          <span className="text-xs text-muted-foreground">0</span>
        ) : (
          <Tag tone={statusTone(r.status)} variant="soft" data-testid={`${testid}-delta-${r.status}`}>
            {r.status === 'added' ? 'new' : r.status === 'removed' ? 'removed' : fmtDelta(r.delta)}
          </Tag>
        ),
    },
  ]

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid={testid}>
      <SectionHeader
        data-testid={`${testid}-header`}
        title={<span className="text-sm font-medium">Before / after</span>}
        actions={
          <span className="flex items-center gap-2">
            <Tag tone={diff.identical ? 'default' : 'info'} variant="soft" data-testid={`${testid}-summary`}>
              {diff.identical
                ? 'identical outputs'
                : `${diff.changed.length} changed · ${diff.added.length} new · ${diff.removed.length} removed`}
            </Tag>
            {onCompare && (
              <Button variant="outline" onClick={onCompare} data-testid={`${testid}-compare`}>
                Compare runs
              </Button>
            )}
          </span>
        }
      />
      {diff.identical && (
        <Alert
          tone="info"
          title="No observable change"
          description="The re-run produced the same key observables — the tweak did not change the compared metrics (record counts, output count, or width). (Values that need reading the data itself aren't compared here.)"
          data-testid={`${testid}-identical`}
        />
      )}
      <Table columns={columns} dataSource={diff.rows} rowKey={r => r.key} data-testid={`${testid}-table`} />
    </div>
  )
}
