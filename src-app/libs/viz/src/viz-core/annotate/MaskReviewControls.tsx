// MaskReviewControls.tsx — the review + correction control panel over a `LabelMaskLayer` (ITEM-11
// + ITEM-12). Presentational only: every edit is a callback the host wires to the layer props /
// the `maskCorrectController` (CODING §12 — no store / deck / GL here). Three sections:
//   • Classes — a hide/solo checkbox list (drives the layer's `hiddenCategories` / `soloCategory`,
//     an O(numLabels) LUT rebuild, never a pixel re-upload).
//   • Correction tools — relabel / split / merge / brush buttons (the active tool the host feeds
//     to its gesture handler, which calls `maskCorrectController.{relabel,split,merge,brush}`).
//   • Readout — the picked cell id + its class (promoted from the free hover→id pick).
//
// Framework-agnostic (viz-core): plain React + raw elements only, matching `LabelMaskView.tsx`.
// ITEM-4 adds ICONS from the shared registry (the corrections were text-only, which read as a lesser
// part of the app beside the two icon rails). Per DEC-6 the panel does NOT convert to `@ziee/kit` —
// importing an icon component is not an architectural change (lucide is already a viz dependency),
// converting the panel's raw elements to kit would be.

import { useId, type CSSProperties } from 'react'
import { toolsForSurface } from '../tools/registry'
import type { ToolKeyFor } from '../tools/vocabulary'

/** The four first-class mask corrections (INV-6). `null` = no active correction tool.
 *  DERIVED from the one registry (INV-14) — resolves to `'relabel' | 'split' | 'merge' | 'brush'`,
 *  so this module's PUBLIC type is byte-identical while the declaration moved. */
export type MaskTool = ToolKeyFor<'mask'>

/** A reviewable category/class: its code + an optional human name + swatch color. */
export interface MaskCategory {
  /** category code (matches `categoryForId[id]`). */
  readonly code: number
  /** human label (defaults to `Class {code}`). */
  readonly label?: string
  /** `[r,g,b]` swatch color (0–255), usually the palette color for this category. */
  readonly color?: readonly [number, number, number]
}

export interface MaskReviewControlsProps {
  /** the categories to list for hide/solo. */
  readonly categories: readonly MaskCategory[]
  /** currently-hidden category codes (drives the layer `hiddenCategories`). */
  readonly hiddenCategories: ReadonlySet<number>
  /** the soloed category, or null (drives the layer `soloCategory`; overrides hide). */
  readonly soloCategory: number | null
  /** toggle a category's hidden state. */
  readonly onToggleHidden: (code: number) => void
  /** set (or clear, with null) the soloed category. */
  readonly onSolo: (code: number | null) => void
  /** the active correction tool (null = review-only). */
  readonly activeTool: MaskTool | null
  /** select (or clear, with null) the active correction tool. */
  readonly onSelectTool: (tool: MaskTool | null) => void
  /** the picked cell id (0/null = none). */
  readonly selectedId?: number | null
  /** the picked cell's category code (null = none). */
  readonly selectedCategory?: number | null
  /** undo/redo affordances (from the `maskCorrectController`). */
  readonly canUndo?: boolean
  readonly canRedo?: boolean
  readonly onUndo?: () => void
  readonly onRedo?: () => void
}

/** The correction tools, in registry order with registry labels + glyphs. The private
 *  `[{tool,label}]` table this replaces was one of the six drifted vocabularies. */
const MASK_TOOLS = toolsForSurface('mask')

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 12,
  fontSize: 12,
  minWidth: 200,
}
const sectionTitleStyle: CSSProperties = { fontWeight: 600, marginBottom: 4 }
/** Icon + label correction button. Theme tokens (never a hardcoded hue) so it tracks the accent and
 *  dark mode like the two kit rails it now sits beside. */
const toolButtonStyle = (active: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontWeight: active ? 700 : 400,
  color: active ? 'var(--primary, #2563eb)' : 'inherit',
  // BLIND-AUDIT L7: `borderColor` ALONE never rendered — Tailwind's preflight sets `border-width: 0`
  // on every element, so a colour with no width is invisible and the ACTIVE correction tool was
  // indistinguishable from the inactive ones. Declare width + style so the active state actually paints.
  borderStyle: 'solid',
  borderWidth: 1,
  borderColor: active ? 'var(--primary, #2563eb)' : 'var(--border, rgba(0,0,0,0.2))',
  borderRadius: 4,
  padding: '2px 6px',
  background: active ? 'var(--accent, rgba(37,99,235,0.08))' : 'transparent',
})
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
const swatchStyle = (color?: readonly [number, number, number]): CSSProperties => ({
  width: 12,
  height: 12,
  borderRadius: 2,
  flex: '0 0 auto',
  background: color ? `rgb(${color[0]},${color[1]},${color[2]})` : 'transparent',
  border: '1px solid rgba(0,0,0,0.2)',
})

function categoryLabel(cat: MaskCategory): string {
  return cat.label ?? `Class ${cat.code}`
}

/**
 * The review + correction panel. Wire `hiddenCategories`/`soloCategory` straight into the
 * `LabelMaskLayer` props, feed `activeTool` to the host's gesture handler, and drive undo/redo
 * from the `maskCorrectController`.
 */
export function MaskReviewControls({
  categories,
  hiddenCategories,
  soloCategory,
  onToggleHidden,
  onSolo,
  activeTool,
  onSelectTool,
  selectedId,
  selectedCategory,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: MaskReviewControlsProps) {
  const selCat = categories.find(c => c.code === selectedCategory)
  const selClass =
    selectedCategory == null ? null : selCat ? categoryLabel(selCat) : `Class ${selectedCategory}`

  return (
    <div style={panelStyle} data-testid="viz-mask-review-controls" role="group" aria-label="Mask review">
      {/* ── Classes: hide / solo ─────────────────────────────────────────────────────────── */}
      <div>
        <div style={sectionTitleStyle}>Classes</div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {categories.map(cat => {
            const soloed = soloCategory === cat.code
            const hidden = hiddenCategories.has(cat.code)
            const name = categoryLabel(cat)
            return (
              <li key={cat.code} style={rowStyle}>
                <input
                  type="checkbox"
                  checked={!hidden}
                  onChange={() => onToggleHidden(cat.code)}
                  aria-label={`Show ${name}`}
                  data-testid={`viz-mask-class-visible-${cat.code}`}
                />
                <span style={swatchStyle(cat.color)} aria-hidden="true" />
                <span style={{ flex: '1 1 auto' }}>{name}</span>
                <button
                  type="button"
                  onClick={() => onSolo(soloed ? null : cat.code)}
                  aria-pressed={soloed}
                  aria-label={soloed ? `Unsolo ${name}` : `Solo ${name}`}
                  data-testid={`viz-mask-class-solo-${cat.code}`}
                  style={{ fontWeight: soloed ? 700 : 400 }}
                >
                  Solo
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {/* ── Correction tools ─────────────────────────────────────────────────────────────── */}
      <div>
        <div style={sectionTitleStyle}>Correct</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {MASK_TOOLS.map(({ key, label, Icon }) => {
            const tool = key as MaskTool
            const active = activeTool === tool
            return (
              <button
                key={tool}
                type="button"
                onClick={() => onSelectTool(active ? null : tool)}
                aria-pressed={active}
                aria-label={label}
                title={label}
                data-testid={`viz-mask-tool-${tool}`}
                style={toolButtonStyle(active)}
              >
                <Icon width={13} height={13} aria-hidden="true" />
                <span>{label}</span>
              </button>
            )
          })}
        </div>
        {(onUndo || onRedo) && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            {/* THESE WERE `disabled={!canUndo}` — the un-migrated twin of `AnnotateControls`,
                which states both refusals ("Nothing to undo"/"Nothing to redo") one directory
                over. A natively disabled button is pointer-events:none AND out of the tab order,
                so on the panel most likely to leave a user mid-edit the refusal was unreadable to
                a pointer user and the control simply absent to a keyboard one.
                DEC-6 keeps this panel on raw elements, so the kit's `unavailableReason` contract
                is hand-built to the same shape: `aria-disabled` + a dropped handler (hoverable and
                focusable), the reason in `aria-describedby` AND in `title`, and the NAME left on
                `aria-label` so a screen-reader user can still tell which control refused them. */}
            <HistoryButton
              testid="viz-mask-undo"
              label="Undo correction"
              text="Undo"
              reason={canUndo ? undefined : 'Nothing to undo'}
              onActivate={onUndo}
            />
            <HistoryButton
              testid="viz-mask-redo"
              label="Redo correction"
              text="Redo"
              reason={canRedo ? undefined : 'Nothing to redo'}
              onActivate={onRedo}
            />
          </div>
        )}
      </div>

      {/* ── Readout: picked cell id + class ──────────────────────────────────────────────── */}
      <div data-testid="viz-mask-cell-readout" style={rowStyle}>
        <span style={sectionTitleStyle}>Cell</span>
        <span>
          {selectedId == null || selectedId <= 0 ? '—' : selectedId}
          {selClass ? ` · ${selClass}` : ''}
        </span>
      </div>
    </div>
  )
}

/**
 * One history affordance (Undo / Redo) that can state why it is unavailable.
 *
 * Extracted rather than inlined twice because the coupled parts have to agree — `aria-disabled`,
 * the dropped handler, the `aria-describedby` target and a DOCUMENT-UNIQUE id for it. That last
 * one is why `useId` is used instead of a literal: two hand-built reason nodes sharing an id makes
 * the browser resolve both descriptions to whichever came first, so Redo would announce Undo's
 * reason. The kit reaches for `useId` at its own reason nodes for exactly this.
 */
function HistoryButton({
  testid, label, text, reason, onActivate,
}: {
  testid: string
  label: string
  text: string
  reason?: string
  onActivate?: () => void
}) {
  const whyId = useId()
  const unavailable = reason != null && reason !== ''
  return (
    <>
      <button
        type="button"
        onClick={unavailable ? undefined : onActivate}
        aria-disabled={unavailable || undefined}
        aria-describedby={unavailable ? whyId : undefined}
        title={unavailable ? reason : undefined}
        data-testid={testid}
        aria-label={label}
        style={unavailable ? { cursor: 'not-allowed', opacity: 0.5 } : undefined}
      >
        {text}
      </button>
      {unavailable && (
        <span
          id={whyId}
          style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
        >
          {reason}
        </span>
      )}
    </>
  )
}
