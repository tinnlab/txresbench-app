// BlendLegend.tsx — the 2D blend legend (BLEND_MODE_PLAN Phase 1). A grid of category HUE
// rows × a value RAMP (low → full): each row is a category's base hue, its horizontal strip
// running from the modulation floor (dim / faint) up to the full base hue, so a reader
// decodes BOTH "which cluster" (row hue) and "how much" (position along the ramp) at once.
//
// Pure list DOM (react only, no library, no @txresbench/*), domain-neutral, theme-aware, testid'd —
// mirrors the categorical `Legend.tsx`. It only RENDERS a `Blend2DLegend` descriptor (built by
// `data/blend.ts::buildBlend2DLegend`); it owns no state.

import type { Blend2DLegend } from '../data/blend'
import { categoryColor, scaleLightness, rgbToHex } from '../data/color'
import { LIGHT_THEME, type VizTheme } from '../theme'

/** Compact numeric label for the value axis (integers plain; else 3 sig-figs). */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (Number.isInteger(v)) return String(v)
  const abs = Math.abs(v)
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e5)) return v.toExponential(1)
  return String(Number(v.toPrecision(3)))
}

/** The CSS `linear-gradient` a category row's ramp draws (floor → full), per channel. */
function rampGradient(code: number, channel: Blend2DLegend['channel'], alphaFloor: number): string {
  const rgb = categoryColor(code)
  if (channel === 'alpha') {
    const [r, g, b] = rgb
    return `linear-gradient(to right, rgba(${r},${g},${b},${alphaFloor}), rgba(${r},${g},${b},1))`
  }
  // lightness: scale the base hue's L from the floor up to full.
  return `linear-gradient(to right, ${rgbToHex(scaleLightness(rgb, alphaFloor))}, ${rgbToHex(rgb)})`
}

export interface BlendLegendProps {
  readonly legend: Blend2DLegend
  readonly title?: string
  /** Theme-aware chrome colors (label text, strip outline). Default LIGHT_THEME. */
  readonly theme?: VizTheme
  /** figure font family (typography). */
  readonly family?: string
  readonly 'data-testid'?: string
}

/** The 2D blend legend: category hue rows × a value ramp (low → full). */
export function BlendLegend({
  legend,
  title,
  theme = LIGHT_THEME,
  family,
  'data-testid': testId = 'viz-blend-legend',
}: BlendLegendProps) {
  const [vmin, vmax] = legend.valueDomain
  const axisLo = legend.perGroupDomain ? 'low' : fmt(vmin)
  const axisHi = legend.perGroupDomain ? 'high' : fmt(vmax)
  return (
    <div
      data-testid={testId}
      data-channel={legend.channel}
      data-per-group={legend.perGroupDomain ? '1' : '0'}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: theme.fg, ...(family ? { fontFamily: family } : {}) }}
    >
      {title && <div style={{ fontWeight: 600, color: theme.muted }}>{title}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {legend.rows.map(row => (
          <div
            key={row.code}
            data-testid={`${testId}-row-${row.code}`}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span
              style={{
                width: 96,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: '0 0 auto',
              }}
              title={row.label}
            >
              {row.label}
            </span>
            <span
              data-testid={`${testId}-ramp-${row.code}`}
              style={{
                flex: 1,
                height: 12,
                minWidth: 80,
                borderRadius: 3,
                background: rampGradient(row.code, legend.channel, legend.alphaFloor),
                outline: `1px solid ${theme.border}`,
              }}
            />
          </div>
        ))}
      </div>
      {/* Value axis: the modulation runs low → high left → right along every ramp. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginInlineStart: 102,
          color: theme.muted,
          fontSize: 11,
        }}
      >
        <span data-testid={`${testId}-axis-lo`}>{axisLo}</span>
        <span style={{ opacity: 0.8 }}>{legend.channel}</span>
        <span data-testid={`${testId}-axis-hi`}>{axisHi}</span>
      </div>
    </div>
  )
}
