// MobileShell (ITEM-16 / ITEM-55) — the narrow-viewport (<768px) degradation of the dock
// frame: the center canvas stays the permanent hero; the edge docks become kit `Sheet`s
// opened from a bottom bar. ITEM-55: the region→component `dockBody` SWITCH is gone — each
// sheet body now renders `placeViews(area)` via the shared `PlacedArea` (left/right), and
// the bottom sheet keeps the analyses-rail `BottomAnalysesDock` (its analyses experience is
// not a placed view). The center hero is `PlacedArea('center')` (the registered canvas
// view). The bottom-bar TRIGGERS keep a small static area label/icon (a button must be
// labeled before its lazy sheet contents exist).

import { useState } from 'react'
import { Button, Sheet } from '@txresbench/kit'
import { PanelLeft, PanelRight, PanelBottom } from 'lucide-react'
import { PlacedArea } from './PlacedArea'
import { SectionStack } from './SectionStack'
import { BottomAnalysesDock } from './BottomAnalysesDock'
import type { DockArea } from './types'

/** The mobile sheet triggers. Only the button label/icon is static (a trigger can't be
 *  labeled by its lazy contents); the BODY is registry-driven (`PlacedArea` / bottom dock).
 *
 *  The `right` entry SURVIVES the deletion of the `selection` pane: it opens the right dock
 *  AREA — the same `placeViews('right')` the desktop right region shows — and that area is
 *  where every `control`/`run` analysis surface lands (DEC-15). Deleting it would strand those
 *  surfaces with no mobile entry point at all. Its LABEL does not survive: "Selection" named the
 *  retired inspector, not the area, and would have been the last live surface still teaching
 *  users that vocabulary. "Controls" says what the area holds, and stays distinct from the bottom
 *  sheet's "Analysis" (the analyses run rail). */
const MOBILE_SHEETS: { area: DockArea; label: string; icon: typeof PanelLeft; side: 'left' | 'right' | 'bottom' }[] = [
  { area: 'left', label: 'Visualize', icon: PanelLeft, side: 'left' },
  { area: 'bottom', label: 'Analysis', icon: PanelBottom, side: 'bottom' },
  { area: 'right', label: 'Controls', icon: PanelRight, side: 'right' },
]

function sheetBody(area: DockArea) {
  // Bottom keeps the analyses-rail dock (its run rail is not a placed view).
  if (area === 'bottom') return <BottomAnalysesDock />
  // LEFT is the Visualize pane, and on mobile as on desktop it is a SECTION STACK, not a
  // placed area (visualize-pane ITEM-5). One branch inside this one function, deliberately:
  // the three sheets share ONE body renderer (`MOBILE_SHEETS` at the top of this file), so
  // "the left sheet renders SectionStack" is a branch here rather than a second component —
  // and the sheet's own flex-column wrapper (below) is what gives the stack's `min-h-0
  // flex-1` scroll track something to resolve against.
  //
  // RIGHT keeps `PlacedArea`: it is the `control`/`run` analysis area (DEC-15), which is
  // still views, still docked, still tabbed.
  if (area === 'left') return <SectionStack pane="visualize" />
  return <PlacedArea area={area} />
}

export function MobileShell() {
  const [open, setOpen] = useState<DockArea | null>(null)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="workbench-shell" data-workbench-mobile="true">
      <div className="min-h-0 flex-1">
        <PlacedArea area="center" />
      </div>
      <nav
        className="flex shrink-0 items-stretch gap-1 border-t border-border bg-card p-1"
        aria-label="Workbench panels"
        data-testid="workbench-mobile-bar"
      >
        {MOBILE_SHEETS.map(d => (
          <Button
            key={d.area}
            variant="ghost"
            block
            icon={<d.icon className="size-4" />}
            onClick={() => setOpen(d.area)}
            data-testid={`workbench-mobile-open-${d.area}`}
          >
            {d.label}
          </Button>
        ))}
      </nav>
      {MOBILE_SHEETS.map(d => (
        <Sheet
          key={d.area}
          open={open === d.area}
          onOpenChange={o => setOpen(o ? d.area : null)}
          side={d.side}
          title={d.label}
          data-testid={`workbench-sheet-${d.area}`}
        >
          {/* A FLEX COLUMN, not a bare block. `PlacedArea` — and every pane under it — states
              its height with `min-h-0 flex-1`, which is inert in a block parent: the area then
              sized to its CONTENT and the sheet's own `overflow-y-auto` scrolled the whole pane
              instead. That is not a cosmetic difference. It means a pane with an internal scroll
              structure has none on a phone: the analysis pane's pinned run band (see
              `DeclarativeRegion::DeclarativeStack`) had nothing to be pinned INSIDE, so the
              feedback for pressing Run went back below the fold at exactly the width where
              scrolling costs most. Measured by `14-declarative-qc/analysis-run-list-narrow.spec.ts`,
              whose precondition — the form track scrolls — was FALSE here before this line.
              `h-full` resolves against the sheet body, which is `flex-1` of a definite-height
              sheet, so the height is real.

              That last clause was only true of the LEFT and RIGHT sheets until the kit fix: the
              BOTTOM sheet was `h-auto`, so its body's `flex-1` was itself inert and this `h-full`
              resolved to auto — the wrapper made the area a flex column but there was no bounded
              height to hand it, and the whole sheet grew off the top of the phone instead. The
              cap now lives where it belongs (`shadcn/sheet.tsx` `max-h-[85svh]`), so this line
              means the same thing on all three sides. It is still
              REQUIRED — `PlacedArea` needs a flex-column parent, which the sheet body is not. */}
          <div className="flex h-full min-h-0 flex-col">{sheetBody(d.area)}</div>
        </Sheet>
      ))}
    </div>
  )
}
