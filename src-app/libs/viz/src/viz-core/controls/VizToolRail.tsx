// VizToolRail.tsx — the GLOBAL left tool rail for a viz grid (Photoshop / VS-Code activity-bar style),
// built on @ziee/kit + lucide to match the CytoAnalyst workbench chrome. ONE rail per grid, OCCUPYING
// the grid's left edge (not overlaid). Holds the EXCLUSIVE active tool (Select / Zoom) + global
// toggles (show cell toolbars, link-zoom) + the whole-grid export. When Select is active it EXPANDS,
// revealing the selection SHAPE sub-tools (rectangle / polygon / move + finish / clear) directly beneath
// it, separated from the rest of the rail by a divider. Presentational: every action is a callback prop.

import type { ReactNode } from 'react'
import { Button } from '@ziee/kit'
// BLIND-AUDIT M12: this rail's export is the WHOLE GRID; the pane toolbar's registered
// `pane.export` is ONE pane. Both are visible at once, so they are two different actions and must
// not wear the same mark — `Download` is the registered pane-export glyph, so the grid-scope export
// takes `Package` (bundle everything) instead.
import { PanelTop, Link2, Package, Check, Eraser, Layers, Copy, MessageSquare } from 'lucide-react'
import { toolsForSurface } from '../tools/registry'
import type { ToolKeyFor, ToolKeyOfKind } from '../tools/vocabulary'

/** The exclusive active rail mode — DERIVED from the one registry (INV-14), never declared here.
 *  Resolves to `'pan' | 'select'`. Scroll-zoom + space-drag-pan stay available regardless
 *  (grid-level), so the camera mode is just "not selecting" — one mode covers both pan and zoom.
 *
 *  VIEW-LEVEL ONLY (finding #14). The rail no longer exposes Annotate / Segment at all: a GLOBAL mode
 *  toggle that opened every capable pane at once is the "one global control acting across panes" shape
 *  the owner rejected, and it made annotating a SINGLE pane impossible. Their entry point is now the
 *  per-pane `PaneToolbar` buttons, siblings of Edit. No bulk toggle, no open-on-all secondary action,
 *  no compatibility shim — `view.annotate` / `view.segment` are deleted from the vocabulary. */
export type VizTool = ToolKeyFor<'view'>

/** The active selection sub-tool: the drawing SHAPES plus the `move` ACTION.
 *  `move` is deliberately not a shape (DEC-4) — `rect`/`polygon` describe HOW a region is drawn,
 *  `move` operates on a region that already EXISTS. The old `SelShape = 'rect'|'polygon'|'move'`
 *  typed an operation as a shape, which is exactly what put them in one undifferentiated row. */
export type SelTool = ToolKeyFor<'select'>
/** Just the drawing shapes — excludes the `move` action by construction. */
export type SelShapeKey = ToolKeyOfKind<'select', 'shape'>

/** Rendered in registry order, with registry labels + glyphs (INV-14). */
const VIEW_TOOLS = toolsForSurface('view')
const SELECT_TOOLS = toolsForSurface('select')

export interface VizToolRailProps {
  readonly activeTool: VizTool
  readonly onToolChange: (tool: VizTool) => void
  /** Whether the per-pane top toolbars are shown. */
  readonly cellToolbars: boolean
  readonly onToggleCellToolbars: () => void
  /** Whether the hover TOOLTIP is shown on scatter points (default ON). Sits ABOVE the link toggle. */
  readonly tooltipsEnabled?: boolean
  readonly onToggleTooltips?: () => void
  /** Whether linked cells zoom/pan in lockstep. */
  readonly linkZoom: boolean
  readonly onToggleLinkZoom: () => void
  /** Export the WHOLE grid. */
  readonly onExportGrid: () => void
  /** PARENT-INJECTED rail slots (the host app adds its own buttons — e.g. "save plot state to server"):
   *  `afterLinkZoom` renders directly BELOW the link-zoom toggle (in the top group); `aboveExport`
   *  renders directly ABOVE the whole-grid export button (in the bottom group). Both absent ⇒ unchanged.
   *  Pass kit `<Button size="icon" variant="ghost" tooltipSide="right">` to match the rail's chrome. */
  readonly afterLinkZoom?: ReactNode
  readonly aboveExport?: ReactNode
  // ── selection sub-tools (shown beneath Select when it's the active tool + selection is available) ──
  /** True when the Select tool's shape sub-tools should be shown (Select active + a selectable surface). */
  readonly selectExpanded?: boolean
  readonly selShape?: SelTool
  readonly onSelShapeChange?: (s: SelTool) => void
  /** Whether a committed selection exists. The `move` ACTION is disabled without one (DEC-4) —
   *  moving a selection that does not exist is not a meaningful state. */
  readonly hasSelection?: boolean
  /** In-progress polygon vertex count (drives the Finish affordance). */
  readonly polyDraftCount?: number
  readonly onFinishPolygon?: () => void
  readonly onClearSelection?: () => void
  /** Whether a new region ADDS to the selection (multiple) vs REPLACES it (single). */
  readonly selMulti?: boolean
  readonly onToggleSelMulti?: () => void
  readonly 'data-testid'?: string
}

const ICON = 'size-3.5'

export function VizToolRail({
  activeTool,
  onToolChange,
  cellToolbars,
  onToggleCellToolbars,
  tooltipsEnabled = true,
  onToggleTooltips,
  linkZoom,
  onToggleLinkZoom,
  onExportGrid,
  afterLinkZoom,
  aboveExport,
  selectExpanded = false,
  selShape = 'rect',
  onSelShapeChange,
  hasSelection = false,
  polyDraftCount = 0,
  onFinishPolygon,
  onClearSelection,
  selMulti = false,
  onToggleSelMulti,
  'data-testid': testId = 'viz-tool-rail',
}: VizToolRailProps) {
  // Active rail item: a ghost button + a straight (square, no-radius) bar at the rail's END edge —
  // the vertical twin of the link-filtering / data-table buttons' bottom-bar active-tab indicator (NOT
  // a filled variant). The wrapper is FULL-WIDTH so `end-0` sits flush against the container's `border-e`
  // with NO gap.
  const railItem = (active: boolean, node: ReactNode) => (
    <span className="relative flex w-full items-center justify-center">
      {node}
      {active && <span className="pointer-events-none absolute inset-y-0 end-0 w-0.5 bg-primary" />}
    </span>
  )
  /** Render one rail MODE from its registry descriptor. `data-testid` keeps the unprefixed key
   *  (`…-tool-select`), which is a projection of the namespaced id — not a second vocabulary. */
  const tool = (key: VizTool) => {
    const t = VIEW_TOOLS.find(e => e.key === key)!
    return railItem(
      activeTool === key,
      <Button
        size="icon"
        variant="ghost"
        tooltip={t.label}
        tooltipSide="right"
        aria-pressed={activeTool === key}
        data-testid={`${testId}-tool-${key}`}
        onClick={() => onToolChange(key)}
      >
        <t.Icon className={ICON} />
      </Button>,
    )
  }
  /** Render one selection sub-tool. The `move` ACTION is unavailable until a selection exists
   *  (DEC-4). It is `unavailableReason`, NOT `disabled`: a natively disabled button is
   *  pointer-events:none and out of the tab order, so the reason it carried
   *  (`… (select something first)`, folded into the tooltip) could never be read by anyone. The
   *  reason now shows on hover and in `aria-describedby`, while the NAME stays the registry
   *  label — a screen-reader user must still be able to tell WHICH control refused them. */
  const selTool = (entry: (typeof SELECT_TOOLS)[number]) => {
    const unavailable = entry.kind === 'action' && !hasSelection
    return railItem(
      selShape === entry.key && !unavailable,
      <Button
        size="icon"
        variant="ghost"
        tooltip={entry.label}
        tooltipSide="right"
        aria-pressed={selShape === entry.key && !unavailable}
        unavailableReason={unavailable ? 'Select something first' : undefined}
        data-testid={`${testId}-sel-${entry.key}`}
        onClick={() => onSelShapeChange?.(entry.key as SelTool)}
      >
        <entry.Icon className={ICON} />
      </Button>,
    )
  }
  return (
    <div
      data-testid={testId}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Visualization tools"
      className="flex h-full w-9 flex-col items-center gap-0.5 border-e border-border bg-muted/40 py-1"
    >
      {/* Pan/zoom (camera) sits ABOVE Select. It now wears ✥ — the universal pan affordance, which
          was previously mis-bound to Move-selection while this control wore a bare magnifier. */}
      {tool('pan')}

      {tool('select')}

      {/* NO Annotate / Segment here (finding #14) — those are PER-PANE, on each pane's own toolbar.
          A pane shows Annotate only if it is annotate-capable and Segment only if it is
          segment-capable, and pressing one opens THAT pane's dock and no other. */}

      {/* Selection SHAPE sub-tools — revealed beneath Select while it's active; the divider below
          separates the whole tool group from the rail toggles. */}
      {selectExpanded && (
        <>
          {/* Single (a new region REPLACES) vs MULTIPLE (a new region ADDS to the selection) — on top. */}
          {railItem(
            selMulti,
            <Button
              size="icon"
              variant="ghost"
              tooltip={selMulti ? 'Multiple regions (adding) — click for single' : 'Single region (replaces) — click for multiple'}
              tooltipSide="right"
              aria-pressed={selMulti}
              data-testid={`${testId}-sel-multi`}
              onClick={onToggleSelMulti}
            >
              {selMulti ? <Layers className={ICON} /> : <Copy className={ICON} />}
            </Button>,
          )}
          {/* Drawing SHAPES first, then the `move` ACTION — separated by a rule because it operates
              on an existing selection rather than describing how one is drawn (DEC-4). */}
          {SELECT_TOOLS.filter(e => e.kind === 'shape').map(e => (
            <span key={e.id} className="contents">{selTool(e)}</span>
          ))}
          <div className="my-0.5 h-px w-4 shrink-0 bg-foreground/15" />
          {SELECT_TOOLS.filter(e => e.kind === 'action').map(e => (
            <span key={e.id} className="contents">{selTool(e)}</span>
          ))}
          {selShape === 'polygon' && (
            <Button
              size="icon"
              variant="ghost"
              // The count is in the NAME while the control is live ("Finish polygon (4)"); below
              // the threshold the hover text becomes the THRESHOLD, which is the thing a user
              // staring at a greyed check actually needs and previously could not get at all —
              // the old tooltip said "Finish polygon (1)" and, being on a natively `disabled`
              // button, said it to nobody.
              tooltip={polyDraftCount < 3 ? 'Finish polygon' : `Finish polygon (${polyDraftCount})`}
              tooltipSide="right"
              unavailableReason={
                polyDraftCount < 3
                  ? `A polygon needs at least 3 points — ${polyDraftCount} so far`
                  : undefined
              }
              data-testid={`${testId}-sel-finish`}
              onClick={onFinishPolygon}
            >
              <Check className={ICON} />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            tooltip="Clear selection"
            tooltipSide="right"
            data-testid={`${testId}-sel-clear`}
            onClick={onClearSelection}
          >
            <Eraser className={ICON} />
          </Button>
        </>
      )}

      <div className="my-1 h-px w-6 shrink-0 bg-foreground/25" />

      {/* Hover TOOLTIP toggle — sits directly ABOVE the link toggle; default ON. */}
      {onToggleTooltips &&
        railItem(
          tooltipsEnabled,
          <Button
            size="icon"
            variant="ghost"
            tooltip={tooltipsEnabled ? 'Hide hover tooltips' : 'Show hover tooltips'}
            tooltipSide="right"
            aria-pressed={tooltipsEnabled}
            data-testid={`${testId}-toggle-tooltips`}
            onClick={onToggleTooltips}
          >
            <MessageSquare className={ICON} />
          </Button>,
        )}

      {railItem(
        linkZoom,
        <Button
          size="icon"
          variant="ghost"
          tooltip={linkZoom ? 'Unlink zoom' : 'Link zoom across cells'}
          tooltipSide="right"
          aria-pressed={linkZoom}
          data-testid={`${testId}-toggle-link-zoom`}
          onClick={onToggleLinkZoom}
        >
          <Link2 className={ICON} />
        </Button>,
      )}

      {/* PARENT SLOT — directly below the link-zoom toggle (top group). */}
      {afterLinkZoom}

      {railItem(
        cellToolbars,
        <Button
          size="icon"
          variant="ghost"
          tooltip={cellToolbars ? 'Hide cell toolbars' : 'Show cell toolbars'}
          tooltipSide="right"
          aria-pressed={cellToolbars}
          data-testid={`${testId}-toggle-cell-toolbars`}
          onClick={onToggleCellToolbars}
        >
          <PanelTop className={ICON} />
        </Button>,
      )}

      <div className="flex-1" />

      {/* PARENT SLOT — directly above the whole-grid export (bottom group). */}
      {aboveExport}

      <Button
        size="icon"
        variant="ghost"
        tooltip="Export whole grid"
        tooltipSide="right"
        data-testid={`${testId}-export-grid`}
        onClick={onExportGrid}
      >
        <Package className={ICON} />
      </Button>
    </div>
  )
}
