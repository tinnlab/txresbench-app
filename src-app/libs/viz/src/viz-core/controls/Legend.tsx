// Legend.tsx — the interactive categorical legend (DEC-30 / ELEMENT_VOCABULARY legend).
// A swatch list with per-category show/hide toggle (click) + solo/isolate (double-click),
// emitting the hidden-set of category codes. Pure list DOM (no library, no @txresbench/*). The
// consumer feeds the hidden set into `categoricalColors({hidden})` (attribute swap) or a
// deck.gl `filterCategories` — the legend itself only owns the hidden set.

import { useContext, useState } from 'react'
import type { CategoricalColumn } from '../data/wire'
import { rgbToHex, resolveEffectivePalette, displayCategory, type CategoricalOverrides } from '../data/color'
import { LIGHT_THEME, type VizTheme } from '../theme'
import { VizEventBusContext } from '../events/EventBusContext'

/** Toggle one category's hidden state, returning a NEW set (pure). */
export function toggleHidden(hidden: ReadonlySet<number>, code: number): Set<number> {
  const next = new Set(hidden)
  if (next.has(code)) next.delete(code)
  else next.add(code)
  return next
}

/**
 * Solo (isolate) one category: if it is already the ONLY visible category, clear the
 * hidden set (show all); otherwise hide every other category. Returns a NEW set (pure).
 */
export function soloHidden(
  codes: readonly number[],
  code: number,
  hidden: ReadonlySet<number>,
): Set<number> {
  const isolated = codes.length > 0 && codes.every(c => (c === code ? !hidden.has(c) : hidden.has(c)))
  if (isolated) return new Set()
  return new Set(codes.filter(c => c !== code))
}

export interface LegendProps {
  /** The categorical column this legend covers (its `categories` label the swatches). */
  readonly column: Pick<CategoricalColumn, 'categories'>
  readonly hidden: ReadonlySet<number>
  readonly onChange: (hidden: ReadonlySet<number>) => void
  /**
   * OPTIONAL color-by column id (EVENT_API_PLAN Phase 2 `legend`). When set AND a `<Viz>` event bus
   * is in context, every hidden-set change ALSO fans a typed `legend` event `{ column, hidden }`
   * (the codes ascending). Absent / no bus ⇒ no event (byte-identical to the pre-event legend). The
   * imperative `onChange` fires unconditionally either way.
   */
  readonly columnId?: string
  readonly title?: string
  /** Theme-aware chrome colors (label text, swatch outline). Default LIGHT_THEME. */
  readonly theme?: VizTheme
  /**
   * OPTIONAL categorical overrides — a custom/by-name palette drives the swatch colors and
   * `categoryLabels` renames the swatch labels. Absent ⇒ the built-in palette + raw names
   * (byte-identical to the pre-override legend). Because these live on the RENDERED legend,
   * an export of the legend/plot picks them up with no export-path change.
   */
  readonly overrides?: CategoricalOverrides
  /**
   * OPTIONAL per-swatch COLOR editor. When set, each swatch renders a native `<input type="color">`
   * (kit-free DOM — viz-core takes no @txresbench dep) bound to the swatch's EFFECTIVE color; on change it
   * fires `onEditColor(code, '#rrggbb')`. The host maps `code → column.categories[code]` (the raw
   * category NAME) and writes the by-name override (e.g. into `colorOverride.store`), then feeds the
   * store's overrides back through `overrides` so the plot + legend re-render. Omitted ⇒ the swatch
   * is a static color chip (read-only legend, byte-identical to before).
   */
  readonly onEditColor?: (code: number, hex: string) => void
  /**
   * OPTIONAL per-swatch LABEL editor. When set, clicking a swatch's label opens a small text input;
   * committing (Enter / blur) fires `onEditLabel(code, text)`. The host maps `code → the raw category
   * NAME` and writes the by-name `categoryLabels` override. Omitted ⇒ the label is static text
   * (byte-identical to before). Escape cancels without emitting.
   */
  readonly onEditLabel?: (code: number, label: string) => void
  readonly 'data-testid'?: string
}

/** An interactive categorical legend; emits the hidden-set of category codes. */
export function Legend({
  column,
  hidden,
  onChange,
  columnId,
  title,
  theme = LIGHT_THEME,
  overrides,
  onEditColor,
  onEditLabel,
  'data-testid': testId = 'viz-legend',
}: LegendProps) {
  const codes = column.categories.map((_, code) => code)
  // When either editor is present the legend is INTERACTIVE (a color-picker + click-to-rename per
  // swatch); absent ⇒ the exact static button (byte-identical to the read-only legend).
  const editable = onEditColor != null || onEditLabel != null
  const [editingCode, setEditingCode] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const startLabelEdit = (code: number, current: string) => {
    setEditingCode(code)
    setDraft(current)
  }
  const commitLabel = () => {
    if (editingCode != null && onEditLabel) onEditLabel(editingCode, draft)
    setEditingCode(null)
  }
  // Commit a hidden-set change: the imperative `onChange` always fires; ADDITIVELY, when a `<Viz>`
  // bus + a `columnId` are present, fan a typed `legend` event carrying the codes ascending.
  const bus = useContext(VizEventBusContext)
  const commit = (next: ReadonlySet<number>) => {
    onChange(next)
    if (bus && columnId != null) {
      bus.emit({ type: 'legend', column: columnId, hidden: [...next].sort((a, b) => a - b) })
    }
  }
  // The EFFECTIVE swatch colors (by-name ∪ ordered palette ∪ auto-extend). No overrides ⇒
  // the built-in palette (byte-identical to `categoryColor(code)` for ≤20 groups).
  const palette = resolveEffectivePalette(column.categories, overrides)
  return (
    <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, color: theme.fg }}>
      {title && <div style={{ fontWeight: 600, marginBottom: 2, color: theme.muted }}>{title}</div>}
      {column.categories.map((rawLabel, code) => {
        const label = displayCategory(rawLabel, overrides?.categoryLabels)
        const isHidden = hidden.has(code)
        const hex = rgbToHex(palette[code] ?? [0, 0, 0])
        // ONE sentence, used as BOTH the accessible name and the hover text, for the show/hide
        // control in either of the two row layouts below.
        //
        // The interactive row draws that control as a bare `▣`/`▢`. A geometric shape is an ICON —
        // it just happens to be drawn as a codepoint rather than an `<svg>` — so it named the button
        // nothing a person could use: assistive tech announced "▣", and the previous
        // `title="Click: show/hide · Double-click: solo"` reached only a pointer, and only as hover
        // text (a `title` names a control ONLY when it has no content at all, and this one had the
        // glyph). Naming it after the CATEGORY is what makes a legend of twelve identical toggles
        // distinguishable, which is the whole job of a legend.
        //
        // The double-click affordance is carried in the name because nothing else documents it.
        const toggleLabel = `Show or hide ${label}; double-click to show only it`
        // ── Interactive row: color-picker swatch + click-to-rename label + a hide/solo toggle. ──
        if (editable) {
          return (
            <div
              key={code}
              data-testid={`${testId}-item-${code}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '2px 4px',
                opacity: isHidden ? 0.4 : 1,
              }}
            >
              {onEditColor ? (
                <input
                  type="color"
                  data-testid={`${testId}-color-${code}`}
                  aria-label={`Color for ${label}`}
                  value={hex}
                  onChange={e => onEditColor(code, e.target.value)}
                  style={{
                    width: 14,
                    height: 14,
                    padding: 0,
                    flex: '0 0 auto',
                    border: `1px solid ${theme.border}`,
                    borderRadius: 3,
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                />
              ) : (
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    flex: '0 0 auto',
                    background: hex,
                    outline: `1px solid ${theme.border}`,
                  }}
                />
              )}
              {onEditLabel && editingCode === code ? (
                <input
                  type="text"
                  autoFocus
                  data-testid={`${testId}-label-input-${code}`}
                  aria-label={`Rename ${label}`}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onBlur={commitLabel}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitLabel()
                    else if (e.key === 'Escape') setEditingCode(null)
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    font: 'inherit',
                    color: theme.fg,
                    background: theme.surface,
                    border: `1px solid ${theme.border}`,
                    borderRadius: 3,
                    padding: '0 2px',
                  }}
                />
              ) : (
                <button
                  type="button"
                  data-testid={`${testId}-label-${code}`}
                  title={onEditLabel ? 'Click to rename' : undefined}
                  onClick={() => onEditLabel && startLabelEdit(code, label)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: 'left',
                    border: 'none',
                    background: 'transparent',
                    font: 'inherit',
                    color: 'inherit',
                    cursor: onEditLabel ? 'text' : 'default',
                    textDecoration: isHidden ? 'line-through' : 'none',
                  }}
                >
                  {label}
                </button>
              )}
              <button
                type="button"
                data-testid={`${testId}-toggle-${code}`}
                aria-pressed={!isHidden}
                aria-label={toggleLabel}
                title={toggleLabel}
                onClick={() => commit(toggleHidden(hidden, code))}
                onDoubleClick={() => commit(soloHidden(codes, code, hidden))}
                style={{
                  flex: '0 0 auto',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  font: 'inherit',
                  color: 'inherit',
                  opacity: 0.7,
                }}
              >
                {isHidden ? '▢' : '▣'}
              </button>
            </div>
          )
        }
        return (
          <button
            key={code}
            type="button"
            data-testid={`${testId}-item-${code}`}
            aria-pressed={!isHidden}
            aria-label={toggleLabel}
            title={toggleLabel}
            onClick={() => commit(toggleHidden(hidden, code))}
            onDoubleClick={() => commit(soloHidden(codes, code, hidden))}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 4px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              opacity: isHidden ? 0.4 : 1,
              font: 'inherit',
              color: 'inherit',
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                flex: '0 0 auto',
                background: rgbToHex(palette[code] ?? [0, 0, 0]),
                outline: `1px solid ${theme.border}`,
              }}
            />
            <span style={{ textDecoration: isHidden ? 'line-through' : 'none' }}>{label}</span>
          </button>
        )
      })}
    </div>
  )
}
