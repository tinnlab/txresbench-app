// Colorbar.tsx — a continuous colorbar (gradient strip + min/max labels) rendered from a
// `ColorbarDescriptor` (DEC-30 / ELEMENT_VOCABULARY colorbar). Pure display DOM: the same
// colormap `stops` that feed the shader LUT feed this CSS gradient, so bar and points
// never disagree (DEC-30 "one shared colormap array feeds widget + shader").

import type { ColorbarDescriptor } from '../data/color'
import { LIGHT_THEME, type VizTheme } from '../theme'

export interface ColorbarProps {
  readonly descriptor: ColorbarDescriptor
  readonly length?: number
  readonly orientation?: 'vertical' | 'horizontal'
  readonly title?: string
  /** Theme-aware chrome colors (labels, strip border). Default LIGHT_THEME. */
  readonly theme?: VizTheme
  readonly 'data-testid'?: string
}

function fmt(v: number): string {
  return Math.abs(v) >= 1000 ? v.toExponential(1) : v.toFixed(2)
}

/** A read-only continuous colorbar built from a `colorbarDescriptor`. */
export function Colorbar({
  descriptor,
  length = 160,
  orientation = 'vertical',
  title,
  theme = LIGHT_THEME,
  'data-testid': testId = 'viz-colorbar',
}: ColorbarProps) {
  const [min, max] = descriptor.domain
  const vertical = orientation === 'vertical'
  // vertical: max at the top → gradient runs "to top"; horizontal: min→max left→right.
  const gradient = `linear-gradient(${vertical ? 'to top' : 'to right'}, ${descriptor.stops.join(', ')})`

  const strip = (
    <div
      data-testid={`${testId}-strip`}
      style={{
        borderRadius: 3,
        border: `1px solid ${theme.border}`,
        background: gradient,
        ...(vertical ? { width: 16, height: length } : { height: 16, width: length }),
      }}
    />
  )

  const labels = (
    <div
      style={{
        display: 'flex',
        flexDirection: vertical ? 'column' : 'row',
        justifyContent: 'space-between',
        fontSize: 11,
        color: theme.muted,
        ...(vertical ? { height: length } : { width: length }),
      }}
    >
      <span data-testid={`${testId}-max`}>{fmt(max)}</span>
      <span data-testid={`${testId}-min`}>{fmt(min)}</span>
    </div>
  )

  return (
    <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: theme.fg }}>
      {title && <div style={{ fontWeight: 600, color: theme.muted }}>{title}</div>}
      <div style={{ display: 'flex', flexDirection: vertical ? 'row' : 'column', gap: 6, alignItems: vertical ? 'stretch' : 'flex-start' }}>
        {strip}
        {labels}
      </div>
    </div>
  )
}
