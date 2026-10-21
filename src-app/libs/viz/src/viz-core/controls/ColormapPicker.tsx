// ColormapPicker.tsx — plot-editing (ITEM-3): a compact continuous-COLORMAP picker for the in-cell
// visual-map, built on the @ziee/kit `Select` (design-system component; the dropdown portals to body,
// so it lands above the deck canvas). A gradient-preview swatch renders in the trigger + each row.
// `editable:false` renders a read-only label (no Select). The gradient swatch stays an inline style
// (a genuine data-driven color, exempt from the token rule).

import { Select } from '@ziee/kit'
import { colorbarDescriptor, CONTINUOUS_COLORMAPS, type ContinuousColormap } from '../data/color'
import { BANNED_SEQUENTIAL } from '../data/pubreadyColor'

export interface ColormapPickerProps {
  readonly value: ContinuousColormap
  readonly onChange: (next: ContinuousColormap) => void
  /** When false, render the current colormap as static text (read-only). Default true. */
  readonly editable?: boolean
  readonly domain?: readonly [number, number]
  readonly 'data-testid'?: string
}

/** A left→right CSS gradient string previewing a colormap's evenly-spaced color stops. EXPORTED for
 *  unit testing (the node test env can't render the component). */
export function gradientCss(colormap: ContinuousColormap, domain: readonly [number, number]): string {
  const stops = colorbarDescriptor(colormap, [domain[0], domain[1]]).stops
  if (stops.length === 0) return 'transparent'
  if (stops.length === 1) return stops[0]
  const parts = stops.map((color, i) => `${color} ${Math.round((i / (stops.length - 1)) * 100)}%`)
  return `linear-gradient(to right, ${parts.join(', ')})`
}

/** The gradient preview swatch for a colormap. */
function Swatch({ colormap, domain }: { colormap: ContinuousColormap; domain: readonly [number, number] }) {
  return (
    <span
      aria-hidden
      data-allow-custom-color
      className="inline-block h-3 w-10 shrink-0 rounded-sm outline outline-border"
      style={{ background: gradientCss(colormap, domain) }}
    />
  )
}

export function ColormapPicker({
  value,
  onChange,
  editable = true,
  domain = [0, 1],
  'data-testid': testId = 'viz-colormap-picker',
}: ColormapPickerProps) {
  if (!editable) {
    return (
      <div data-testid={testId} className="flex items-center gap-1.5 text-[11px] text-foreground">
        <Swatch colormap={value} domain={domain} />
        <span data-testid={`${testId}-label`} className="text-muted-foreground">
          {value}
        </span>
      </div>
    )
  }
  // ITEM-10: drop non-monotonic rainbow maps (turbo/jet) from the picker — they distort data + fail CVD.
  const options = CONTINUOUS_COLORMAPS.filter(c => !BANNED_SEQUENTIAL.includes(c)).map(c => ({ value: c, label: c }))
  const rowFor = (cm: ContinuousColormap) => (
    <span className="flex items-center gap-1.5">
      <Swatch colormap={cm} domain={domain} />
      <span className="capitalize">{cm}</span>
    </span>
  )
  return (
    <Select
      data-testid={testId}
      aria-label="Colormap"
      size="sm"
      value={value}
      onValueChange={v => onChange(v as ContinuousColormap)}
      options={options}
      optionRender={o => rowFor(o.value as ContinuousColormap)}
      labelRender={o => rowFor((o?.value as ContinuousColormap) ?? value)}
    />
  )
}
