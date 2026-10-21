// RegionBody (shared) — the READABLE FORM COLUMN every non-center `DeclarativeRegion` wraps its
// widget list in. Before this, `DeclarativeRegion` returned a bare `<WidgetList>` and the only
// wrapper was `ViewHost`'s scroller — so a fanned form had NO inter-widget rhythm and NO width
// cap: in a wide (bottom-dock) pane the controls + the action buttons stretched edge-to-edge
// across the whole page.
//
// The column supplies:
//   • `gap-3`             — vertical rhythm between top-level widgets (each control adds its own
//                           internal `Field` gap).
//   • `max-w-lg`          — a readable column cap, so a wide pane doesn't stretch the form; the
//                           column is `w-full` below that, so a narrow (~360px) dock fills cleanly.
//   • `items-start`       — action buttons stay CONTENT-sized instead of spanning the pane (the
//                           "Add criterion button spans the page" bug); width-capped `Field`s
//                           still fill their own cap because they set `w-full` on themselves.
//
// ── IT NO LONGER SCROLLS, AND IT NO LONGER PADS ─────────────────────────────────────────────
//
// It used to be one element carrying THREE concerns:
//
//     flex min-h-0 w-full max-w-lg flex-col items-start gap-3 overflow-y-auto p-4
//
// …the readable-width cap, the scroll container, and the pane's padding. A scroll container's
// scrollbar is drawn on ITS OWN right edge, so making the capped box the scroller put the bar
// 512px from the left of any wider pane — floating mid-pane with empty pane beside it. That was
// the reported defect (an analysis pane's scrollbar rendered mid-pane), and it was
// structural, not cosmetic: the two concerns cannot be separated while they are one element.
//
//   · SCROLL moved OUT, to the full-width `ScrollArea` track `DeclarativeStack` wraps this in —
//     so the bar renders at the pane's edge. Width cap in, scroller out.
//   · PADDING moved OUT, to the pane body (`RegionShell::PaneBody`, `paneContentClass`), which is
//     now the ONE owner of a pane's content inset for every pane kind.
//
// What is left here is exactly the readable column: cap, rhythm, content-sized actions.

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface RegionBodyProps {
  className?: string
  'data-testid'?: string
  children: React.ReactNode
}

export function RegionBody({
  className,
  'data-testid': testid,
  children,
}: RegionBodyProps): React.ReactElement {
  return (
    <div
      data-testid={testid}
      className={cn('flex w-full max-w-lg flex-col items-start gap-3', className)}
    >
      {children}
    </div>
  )
}
