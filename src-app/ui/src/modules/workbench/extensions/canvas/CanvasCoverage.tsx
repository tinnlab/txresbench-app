// CanvasCoverage.tsx — ITEM-19. The canvas load-coverage indicator.
//
// ── WHAT IT IS FED BY, AND WHY NOT viz's `onProgress` ─────────────────────────────────────────
//
// The APP's own `WorkbenchStreamingSource.onProgress`. viz's `onProgress` prop is plumbed only on
// the `<Viz data>` path; the GRID — which is what the canvas renders — has no such channel, so
// routing it out would have opened another viz source file for a number this source already knows.
//
// ── THE HONEST LIMITS, WHICH ARE IN THE COPY AND NOT ONLY IN THIS COMMENT ─────────────────────
//
// 1. It is CANVAS/ARTIFACT-level, not per-pane. Per-pane would need viz to surface progress for
//    each grid pane — a viz file this round does not have and does not want.
// 2. **It cannot appear below ~8k rows, and that is correct rather than a gap.** The producer
//    writes row-chunked columns with an INNER CHUNK of 8,192 rows
//    (`src-app/packages/_lib/cyto_columns.py:75`, applied at `:358`), so a 3,460-row layout — the
//    live shape — arrives as ONE chunk and can NEVER fill progressively no matter what the read
//    does. An indicator that appeared for it would be an
//    affordance lying about the system: a bar that flashes 0→100 in one frame implies incremental
//    arrival that did not happen.
//
//    The gate is therefore `arrived >= 2`: the indicator appears only once a SECOND chunk has
//    landed, which by construction a single-chunk read never reaches. Not "hidden at 100%", not
//    "hidden when fast" — ABSENT, because there was no progress to show. The copy says so.

import { useEffect, useState } from 'react'
import type { StreamProgress, WorkbenchStreamingSource } from '../data'

/** Only the POSITIONS channel drives the indicator: it is the read whose arrival the user is
 *  waiting on to see points, and mixing channels into one bar would report a number that means
 *  nothing ("62% of positions and a colour column"). */
const POSITIONS_PREFIX = 'positions\n'

/** A read must have delivered at least this many chunks before anything is shown. See the header:
 *  a single-chunk read has no progress to display, and showing one would misrepresent the system. */
const MIN_CHUNKS_TO_SHOW = 2

export interface CanvasCoverageProps {
  /** The app streaming source whose reads are being watched. `null` on the pull-only path (an
   *  injected fixture source / the declarative resolver), where there is nothing to observe. */
  source: WorkbenchStreamingSource | null
}

interface Shown {
  readonly pct: number
  readonly rowsSeen: number
  readonly totalRows: number
}

export function CanvasCoverage({ source }: CanvasCoverageProps) {
  const [shown, setShown] = useState<Shown | null>(null)

  useEffect(() => {
    if (!source) {
      setShown(null)
      return
    }
    const off = source.onProgress((p: StreamProgress) => {
      if (!p.key.startsWith(POSITIONS_PREFIX)) return
      // Finished ⇒ gone. Never a bar left sitting at 100%.
      if (p.done) {
        setShown(null)
        return
      }
      // Below the chunk threshold, or with no denominator, there is nothing HONEST to report.
      if (p.chunks < MIN_CHUNKS_TO_SHOW) return
      if (p.rowsSeen == null || p.totalRows == null || p.totalRows <= 0) return
      const rowsSeen = Math.min(p.rowsSeen, p.totalRows)
      setShown({
        pct: Math.min(99, Math.floor((rowsSeen / p.totalRows) * 100)),
        rowsSeen,
        totalRows: p.totalRows,
      })
    })
    return () => {
      off()
      setShown(null)
    }
  }, [source])

  if (!shown) return null

  return (
    <div
      data-testid="workbench-canvas-coverage"
      data-coverage-pct={String(shown.pct)}
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute end-3 top-3 z-10 flex flex-col gap-1 rounded-md border border-border bg-popover/90 px-3 py-2 text-xs text-popover-foreground shadow-sm"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">Loading points… {shown.pct}%</span>
        <span className="text-muted-foreground">
          {shown.rowsSeen.toLocaleString()} of {shown.totalRows.toLocaleString()} rows
        </span>
      </div>
      <div
        aria-hidden
        className="h-1 w-40 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-primary" style={{ width: `${shown.pct}%` }} />
      </div>
      {/* The two limits, stated to the user rather than only to the reader of this file. The
          second one is why this indicator is absent on the common small-artifact load, and
          saying so is what stops its absence reading as a bug. */}
      <span className="text-muted-foreground">
        Whole canvas, all panes · shown only while a read arrives in more than one 8,192-row chunk
      </span>
    </div>
  )
}
