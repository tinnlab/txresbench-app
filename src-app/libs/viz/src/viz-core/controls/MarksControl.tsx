// MarksControl.tsx — plot-editing (ITEM-5): the in-cell MARKS control for a dense scatter cell — point
// SIZE (radius, px) + OPACITY (0..1) — built on the @ziee/kit `Slider` (design-system component). A
// change fires `onChange({ radius?, opacity? })`; the host writes it to the cell's `style` (persisted →
// series.style). When `editable` is false the values render as read-only text (no sliders).

import { Slider } from '@ziee/kit'

export interface MarksControlProps {
  /** current point radius (px). */
  readonly radius: number
  /** current mark opacity (0..1). */
  readonly opacity: number
  readonly onChange: (next: { radius?: number; opacity?: number }) => void
  /** When false, render read-only values (no sliders). Default true. */
  readonly editable?: boolean
  readonly 'data-testid'?: string
}

/** Point-size slider bounds (px) — a sensible authoring range for scatter marks. */
export const MARK_RADIUS_MIN = 0.5
export const MARK_RADIUS_MAX = 12
export const MARK_RADIUS_STEP = 0.5

/** base-ui Slider reports `number | number[]`; take the first thumb. */
function firstThumb(v: number | readonly number[]): number {
  return Array.isArray(v) ? v[0] : (v as number)
}

export function MarksControl({
  radius,
  opacity,
  onChange,
  editable = true,
  'data-testid': testId = 'viz-marks-control',
}: MarksControlProps) {
  const Row = ({
    label,
    valueText,
    slider,
  }: {
    label: string
    valueText: string
    slider: React.ReactNode
  }) => (
    <div className="flex items-center gap-2 text-[11px] text-foreground">
      <span className="w-10 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{slider}</span>
      <span className="w-7 shrink-0 text-end tabular-nums">{valueText}</span>
    </div>
  )
  return (
    <div data-testid={testId} className="flex flex-col gap-2">
      <Row
        label="Size"
        valueText={radius.toFixed(1)}
        slider={
          editable ? (
            <Slider
              data-testid={`${testId}-size`}
              aria-label="Point size"
              min={MARK_RADIUS_MIN}
              max={MARK_RADIUS_MAX}
              step={MARK_RADIUS_STEP}
              value={[radius]}
              onValueChange={v => onChange({ radius: firstThumb(v) })}
            />
          ) : null
        }
      />
      <Row
        label="Opacity"
        valueText={opacity.toFixed(2)}
        slider={
          editable ? (
            <Slider
              data-testid={`${testId}-opacity`}
              aria-label="Mark opacity"
              min={0}
              max={1}
              step={0.05}
              value={[opacity]}
              onValueChange={v => onChange({ opacity: firstThumb(v) })}
            />
          ) : null
        }
      />
    </div>
  )
}
