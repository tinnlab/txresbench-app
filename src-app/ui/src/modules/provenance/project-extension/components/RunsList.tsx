import { Badge, Empty, Pagination, Table, Tooltip, type TableColumn } from '@ziee/kit'
import { Provenance } from '@/modules/provenance/stores/Provenance.store'
import type { RunNodeDto } from '@/api-client/types'
import { ORIGIN_AUTO } from '@/modules/workbench/core'
import { criteriaPreview, criteriaText } from './criteriaPreview'

const STATUS_TONE: Record<string, 'success' | 'error' | 'warning' | 'neutral'> = {
  succeeded: 'success',
  completed: 'success',
  failed: 'error',
  error: 'error',
  running: 'warning',
  pending: 'neutral',
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/**
 * How many of a run's recorded inputs the SYSTEM bound rather than a person
 * (ITEM-21 / INV-3).
 *
 * Matched on the exact recorded value with `===`, which is what makes an unrecognised
 * `bound_by` — a future origin this build has never heard of, a hand-edited row — count as
 * neither. An input with NO `bound_by` is in the same position: UNSTATED. Every run recorded
 * before the origin was carried is in that state and there is deliberately no backfill
 * (DEC-7).
 *
 * There is no parse guard here, and the earlier draft that added one was WRONG in a way worth
 * recording: `isBindingOrigin(v) && v === ORIGIN_AUTO` is identical to `v === ORIGIN_AUTO` for
 * every possible value, so it was a provable no-op wearing an eighteen-line comment about an
 * egress boundary that did not exist. The comment even argued against a bare `!== 'auto'`
 * sorting unknowns into the reviewed pile — but this counts autos with `===`, so unknowns were
 * never in that pile. A guard that cannot change an outcome is not defence in depth; it is a
 * claim a future reader will trust.
 *
 * The direction that WOULD be dangerous — inferring `user` from "not auto" — is not
 * expressible here, because this function returns a count of autos and its caller renders
 * nothing about who reviewed anything (INV-4).
 */
export function autoBoundInputCount(r: RunNodeDto): number {
  return r.inputs.filter(e => e.bound_by === ORIGIN_AUTO).length
}

/**
 * The Inputs column: the count, plus — when the system bound some of them — how many,
 * ON SCREEN.
 *
 * The mark is a rendered badge, never a hover: a marker seen only on hover is a
 * disclaimer nobody sees, which is the failure this whole change replaces. A run
 * with no auto-bound inputs, and a run that recorded no origins at all, both render
 * exactly the plain count — neither is ever described as reviewed.
 */
export function RunInputsSummary({ run }: { run: RunNodeDto }) {
  const auto = autoBoundInputCount(run)
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="tabular-nums">{run.inputs.length}</span>
      {auto > 0 && (
        <Badge tone="warning" data-testid={`provenance-run-auto-bound-${run.run_id}`}>
          {auto} bound automatically
        </Badge>
      )}
    </span>
  )
}

const COLUMNS: TableColumn<RunNodeDto>[] = [
  {
    key: 'kind',
    title: 'Kind',
    render: r => <span className="font-medium">{r.kind}</span>,
  },
  {
    key: 'generator',
    title: 'Tool / version',
    render: r => (
      <span className="text-sm">
        {r.generator_id}
        <span className="text-muted-foreground"> · {r.generator_version}</span>
      </span>
    ),
  },
  {
    // ITEM-9 / DEC-5 — the reviewer's "what was filtered on?" column. Derived
    // text, so the kit's `ellipsis` native-title fallback (which reads the raw
    // record field) cannot supply the hover: the explicit Tooltip does.
    key: 'filter',
    title: 'Filter',
    width: 220,
    ellipsis: true,
    render: r => {
      const full = criteriaText(r)
      if (!full) return <span className="text-muted-foreground">—</span>
      return (
        <Tooltip content={full}>
          <span className="text-xs" data-testid={`provenance-run-filter-${r.run_id}`}>
            {criteriaPreview(r)}
          </span>
        </Tooltip>
      )
    },
  },
  {
    key: 'seed',
    title: 'Seed',
    numeric: true,
    render: r =>
      r.seed == null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="tabular-nums">{r.seed}</span>
      ),
  },
  {
    key: 'inputs',
    title: 'Inputs',
    numeric: true,
    render: r => <RunInputsSummary run={r} />,
  },
  {
    key: 'acting_user',
    title: 'Run by',
    render: r => (
      <span className="text-sm text-muted-foreground">{r.acting_user ?? 'system'}</span>
    ),
  },
  {
    key: 'captured_at',
    title: 'Captured',
    render: r => (
      <span className="text-xs text-muted-foreground">{formatWhen(r.captured_at)}</span>
    ),
  },
  {
    key: 'status',
    title: 'Status',
    render: r => (
      <Badge tone={STATUS_TONE[r.status] ?? 'neutral'} data-testid={`provenance-run-status-${r.run_id}`}>
        {r.status}
      </Badge>
    ),
  },
]

/**
 * The paginated run trust-view (ITEM-30) — every recorded run with its
 * generator/version, seed, input count, acting user, and capture time. This is
 * the "can I trust this result" table; pagination shows "Showing N of M".
 */
export function RunsList() {
  const { runs, total, page, perPage } = Provenance

  if (runs.length === 0) {
    return (
      <Empty
        description="No runs recorded yet — provenance is captured as analyses run."
        data-testid="provenance-runs-empty"
      />
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="provenance-runs">
      {/* The 8-column trust view scrolls horizontally inside its OWN container
          (never the page) at narrow widths — the kit Table's shadcn container is
          itself `overflow-x-auto`; this wrapper makes the intent explicit. */}
      <div className="w-full overflow-x-auto">
        <Table
          columns={COLUMNS}
          dataSource={runs}
          rowKey="run_id"
          data-testid="provenance-runs-table"
        />
      </div>
      <Pagination
        total={total}
        pageSize={perPage}
        current={page}
        onChange={p => void Provenance.setPage(p)}
        aria-label="Provenance runs pages"
        previousLabel="Previous page"
        nextLabel="Next page"
        pageLabel={p => `Go to page ${p}`}
        showTotal={(t, [from, to]) => `Showing ${from}–${to} of ${t}`}
        data-testid="provenance-runs-pagination"
      />
    </div>
  )
}
