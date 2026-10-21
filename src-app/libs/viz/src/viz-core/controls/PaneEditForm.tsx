// PaneEditForm.tsx — the per-pane EDIT FORM (shell redesign). Opened by a pane toolbar's ✎ Edit button;
// edits are made HERE (never inline on the plot), so the plot stays "what you see is what you export".
// Built on @ziee/kit + the workbench SchemaForm layout (flex-col gap-4, kit Input/Select/Slider/Switch).
// Sections adapt to the cell: Title (plot + x/y axis) · Legend (per-category recolor / rename / show-hide,
// categorical) · Color (colormap, continuous) · Marks (point size / opacity, dense) · Range (value filter,
// continuous). Presentational — every edit is a callback the grid wires to its stores.

import { useEffect, useState } from 'react'
import { Button, Input, Select, Slider, Switch } from '@ziee/kit'
import { X, Eye, EyeOff } from 'lucide-react'
import { CONTINUOUS_COLORMAPS, QUALITATIVE_PALETTE_NAMES, QUALITATIVE_PALETTES, QUALITATIVE_PALETTE_KEY_DEFAULT, type ContinuousColormap } from '../data/color'
import { BANNED_SEQUENTIAL } from '../data/pubreadyColor'
import { gradientCss } from './ColormapPicker'
import type { LegendEntry, LegendCorner } from './legendRender'
import { MARK_RADIUS_MIN, MARK_RADIUS_MAX, MARK_RADIUS_STEP } from './MarksControl'
import type { Typography, TextElement } from './typography'
import type { RasterChannelState } from '../spatial/RasterImageView'
import { CHANNEL_COLORMAPS, CHANNEL_COLORMAP_NONE, rgbToHex, colorPatch, contrastPatch, visiblePatch } from './channelControls'

export interface PaneEditFormProps {
  /**
   * THE ID A READER ADDRESSES THIS PANE BY — `cellTestId(cell)`, i.e. the id the DECLARING author
   * wrote, not the composing host's grid key. Every `data-testid` and every announced name below is
   * built from it, so a spec, a screenshot diff or a screen reader never has to know the host's
   * composition separator nor which declaration happened to contribute the pane.
   *
   * It is deliberately NOT unique in the document: namespacing exists precisely because two
   * declarations may name a pane the same thing. Anything that must be unique uses `domIdScope`.
   */
  readonly paneId: string
  /**
   * THE DOCUMENT-UNIQUE SCOPE for the `id=` / `htmlFor=` LABEL WIRING — the grid's own key.
   *
   * An `id` attribute has to be unique in the DOCUMENT, and INV-8 puts several panes' edit forms on
   * screen AT ONCE, so with two composed panes both named `emb` a `paneId`-derived `id` would
   * collide. A duplicate `id` fails silently: the browser resolves `htmlFor` to whichever node came
   * first, so clicking pane B's "Plot title" label would focus pane A's input, with no visible
   * symptom at all. Same reasoning as `blockedAction`'s `whyId` in the pane toolbar.
   *
   * It never reaches a `data-testid`. Never derive one from it.
   */
  readonly domIdScope: string
  /**
   * HOSTED: this form is portaled into a host-provided container (`editFormContainer`) whose pane
   * already draws a title bar and a close for it. Its own title + close row therefore stands down —
   * two titles one row apart is a duplicate, not chrome. A PROP rather than a CSS hide, because a
   * hidden header still occupies the accessibility tree and the duplicate would survive there.
   * Absent/false ⇒ the internal-panel form, which owns its own chrome exactly as before.
   */
  readonly hosted?: boolean
  readonly plotTitle: string
  readonly axisX: string
  readonly axisY: string
  /** current legend title (the color/group legend header). */
  readonly legendTitle: string
  /** placeholder shown when the legend title is empty (the colorBy / group column name). */
  readonly legendTitlePlaceholder?: string
  /** whether this cell HAS a legend to title (categorical or continuous). */
  readonly hasLegend: boolean
  readonly showLegend: boolean
  /** which corner the legend sits in. */
  readonly legendCorner: LegendCorner
  /** legend layout mode: true = beside the plot (plot shrinks), false = overlay over the plot. */
  readonly legendBeside: boolean
  /** whether this cell type draws chart-frame GRID LINES (box/violin/bar/histogram/volcano). */
  readonly hasGrid: boolean
  readonly showGrid: boolean
  /** categorical legend: entries (code/label/hex) + raw names for stable-identity overrides. */
  readonly categoryEntries?: readonly LegendEntry[]
  readonly categoryNames?: readonly string[]
  readonly hidden: ReadonlySet<number>
  /** continuous: colormap + domain + current filter window. */
  readonly colormap?: ContinuousColormap
  readonly domain?: readonly [number, number]
  readonly range?: readonly [number, number]
  /** dense marks. */
  readonly showMarks: boolean
  readonly radius: number
  readonly opacity: number
  // ── callbacks ──
  /** per-cell typography (figure font + per-element overrides). */
  readonly typography: Typography
  readonly onClose: () => void
  readonly onSetPlotTitle: (v: string) => void
  readonly onSetAxisTitle: (axis: 'x' | 'y', v: string) => void
  readonly onSetLegendTitle: (v: string) => void
  readonly onSetShowLegend: (v: boolean) => void
  readonly onSetLegendCorner: (v: LegendCorner) => void
  readonly onSetLegendBeside: (v: boolean) => void
  readonly onSetShowGrid: (v: boolean) => void
  readonly onSetTypography: (patch: Partial<Typography>) => void
  readonly onSetColormap: (c: ContinuousColormap) => void
  readonly onSetRadius: (v: number) => void
  readonly onSetOpacity: (v: number) => void
  readonly onSetCategoryColor: (name: string, hex: string) => void
  readonly onSetCategoryLabel: (name: string, label: string) => void
  /** apply a qualitative palette (by name) to auto-populate all group colors. */
  readonly onSetPalette: (paletteName: string) => void
  readonly onToggleCategory: (code: number) => void
  /** Codes currently HIDDEN from the legend LIST (their marks still render) — the eye toggle per row. */
  readonly legendHidden: ReadonlySet<number>
  readonly onToggleLegendHidden: (code: number) => void
  readonly onSetRange: (range: [number, number]) => void
  /** Continuous legend: render the visual-map using the custom range as the full gradient (not a band). */
  readonly legendUseRange: boolean
  readonly onSetLegendUseRange: (on: boolean) => void
  /** ITEM-18 compare mode: whether this panel shares ONE color scale (vmin/vmax) with the other panels
   *  coloring by the same column, so comparable panels are visually comparable. */
  readonly linkColorScale: boolean
  readonly onToggleLinkColorScale: () => void
  /** Whether "Compare (shared color scale)" applies to THIS cell — false for matrix cells (heatmap/
   *  dotplot), whose colormap is the intrinsic matrix value scale, not a share-able colorBy scale, so
   *  the toggle would be a no-op. When false the toggle is hidden. Defaults to true (back-compat). */
  readonly compareApplicable?: boolean
  // ── ITEM-2: raster image channels (only present for an image cell) ──
  /** whether this cell is a raster IMAGE with a per-channel display model (gates the section). */
  readonly hasChannels?: boolean
  /** the live per-channel state (Viv XRLayer model), one entry per image channel. */
  readonly channels?: readonly RasterChannelState[]
  /** upper bound of the contrast sliders (255 for 8-bit, 65535 for 16-bit). Default 255. */
  readonly contrastMax?: number
  /** the active single-channel colormap name, or undefined for per-channel colors (mutually exclusive). */
  readonly channelColormap?: string
  /** patch ONE channel's display state (visible / color / contrastLimits). */
  readonly onSetChannel?: (i: number, patch: Partial<RasterChannelState>) => void
  /** set (or clear, with `undefined`) the single-channel colormap — clears per-channel colors when set. */
  readonly onSetChannelColormap?: (colormap: string | undefined) => void
  /** auto-contrast ONE channel from its low-res pixel stats (Viv `getChannelStats`). */
  readonly onAutoContrast?: (i: number) => void
}

const first = (v: number | readonly number[]): number => (Array.isArray(v) ? v[0] : (v as number))

/**
 * A text/number Input that keeps LOCAL state while typing and only COMMITS (calls the store) on BLUR or
 * Enter — so editing a title/axis/font/range doesn't recompute the plot on every keystroke (laggy). Syncs
 * back from the external `value` when it changes elsewhere.
 */
interface BlurInputProps {
  value: string
  onCommit: (v: string) => void
  id?: string
  size?: 'sm' | 'default' | 'lg'
  type?: string
  className?: string
  placeholder?: string
  'aria-label'?: string
  'data-testid'?: string
}
function BlurInput({ value, onCommit, ...rest }: BlurInputProps) {
  const [local, setLocal] = useState(value)
  useEffect(() => {
    setLocal(value)
  }, [value])
  // The kit Input's props are a `style`/`allowStyle`-gated union that resists inference from an
  // all-optional bag; build the props then cast (we pass no `style`).
  const props = {
    ...rest,
    value: local,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setLocal(e.target.value),
    onBlur: () => {
      if (local !== value) onCommit(local)
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
    },
  } as React.ComponentProps<typeof Input>
  return <Input {...props} />
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

export function PaneEditForm(props: PaneEditFormProps) {
  const {
    paneId,
    domIdScope,
    hosted = false,
    plotTitle,
    axisX,
    axisY,
    legendTitle,
    legendTitlePlaceholder,
    hasLegend,
    showLegend,
    legendCorner,
    legendBeside,
    hasGrid,
    showGrid,
    categoryEntries,
    categoryNames,
    hidden,
    colormap,
    domain,
    range,
    showMarks,
    radius,
    opacity,
    typography,
    onClose,
    onSetPlotTitle,
    onSetAxisTitle,
    onSetLegendTitle,
    onSetShowLegend,
    onSetLegendCorner,
    onSetLegendBeside,
    onSetShowGrid,
    onSetTypography,
    onSetColormap,
    linkColorScale,
    onToggleLinkColorScale,
    compareApplicable = true,
    onSetRadius,
    onSetOpacity,
    onSetCategoryColor,
    onSetCategoryLabel,
    onSetPalette,
    onToggleCategory,
    legendHidden,
    onToggleLegendHidden,
    onSetRange,
    legendUseRange,
    onSetLegendUseRange,
    hasChannels,
    channels,
    contrastMax = 255,
    channelColormap,
    onSetChannel,
    onSetChannelColormap,
    onAutoContrast,
  } = props
  const isCategorical = !!categoryEntries && !!categoryNames
  const isContinuous = !!domain && !!colormap
  // The colormap PICKER shows whenever a colormap is present; the value-range FILTER (Range) needs a
  // domain. A matrix chart (heatmap/dotplot) passes a colormap but NO domain → colormap editable, no filter.
  const hasColormap = !!colormap
  const lo = range?.[0] ?? domain?.[0] ?? 0
  const hi = range?.[1] ?? domain?.[1] ?? 1

  return (
    <div
      data-testid={`viz-edit-form-${paneId}`}
      className="flex h-full w-full min-w-64 flex-col gap-4 overflow-auto border-s border-border bg-background p-3 text-sm"
    >
      {hosted ? null : (
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Edit plot</h2>
          <Button size="icon" variant="ghost" tooltip="Close" data-testid={`viz-edit-form-close-${paneId}`} onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      <Section title="Title">
        <label className="text-xs text-muted-foreground" htmlFor={`edit-title-${domIdScope}`}>Plot title</label>
        <BlurInput
          id={`edit-title-${domIdScope}`}
          size="sm"
          data-testid={`viz-edit-title-${paneId}`}
          value={plotTitle}
          placeholder="Untitled plot"
          onCommit={onSetPlotTitle}
        />
      </Section>

      <Section title="Axis">
        <label className="text-xs text-muted-foreground" htmlFor={`edit-axisx-${domIdScope}`}>X axis</label>
        <BlurInput id={`edit-axisx-${domIdScope}`} size="sm" data-testid={`viz-edit-axisx-${paneId}`} value={axisX} onCommit={v => onSetAxisTitle('x', v)} />
        <label className="text-xs text-muted-foreground" htmlFor={`edit-axisy-${domIdScope}`}>Y axis</label>
        <BlurInput id={`edit-axisy-${domIdScope}`} size="sm" data-testid={`viz-edit-axisy-${paneId}`} value={axisY} onCommit={v => onSetAxisTitle('y', v)} />
        {hasGrid && (
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Grid lines</span>
            <Switch aria-label="Grid lines" data-testid={`viz-edit-grid-${paneId}`} checked={showGrid} onCheckedChange={onSetShowGrid} />
          </div>
        )}
      </Section>

      {hasLegend && (
        <Section title="Legend">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Show legend</span>
            <Switch aria-label="Show legend" data-testid={`viz-edit-showlegend-${paneId}`} checked={showLegend} onCheckedChange={onSetShowLegend} />
          </div>
          {showLegend && (
            <>
              {/* Placement: a 2×2 CORNER picker (top/bottom × left/right) — the label always faces INTO the
                  plot. `Beside` reserves a side gutter (plot shrinks); off = overlay over the plot. */}
              <label className="text-xs text-muted-foreground">Legend placement</label>
              <div className="grid grid-cols-2 gap-1" data-testid={`viz-edit-legend-corner-${paneId}`}>
                {([['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']] as const).map(([c, label]) => (
                  <Button
                    key={c}
                    variant={legendCorner === c ? 'default' : 'outline'}
                    className="h-7 text-xs"
                    data-testid={`viz-edit-legend-corner-${c}-${paneId}`}
                    aria-pressed={legendCorner === c}
                    onClick={() => onSetLegendCorner(c)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">Beside plot (shrinks it)</span>
                <Switch aria-label="Legend beside plot" data-testid={`viz-edit-legend-beside-${paneId}`} checked={legendBeside} onCheckedChange={onSetLegendBeside} />
              </div>
            </>
          )}
          <label className="text-xs text-muted-foreground" htmlFor={`edit-legend-title-${domIdScope}`}>Legend title</label>
          <BlurInput
            id={`edit-legend-title-${domIdScope}`}
            size="sm"
            data-testid={`viz-edit-legend-title-${paneId}`}
            value={legendTitle}
            placeholder={legendTitlePlaceholder ?? 'Legend'}
            onCommit={onSetLegendTitle}
          />
        </Section>
      )}

      <Section title="Typography">
        <label className="text-xs text-muted-foreground" htmlFor={`edit-font-family-${domIdScope}`}>Figure font</label>
        <BlurInput
          id={`edit-font-family-${domIdScope}`}
          size="sm"
          data-testid={`viz-edit-font-family-${paneId}`}
          value={typography.fontFamily ?? ''}
          placeholder="system-ui, sans-serif"
          onCommit={v => onSetTypography({ fontFamily: v || undefined })}
        />
        <div className="mt-1 flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs text-muted-foreground">Base size</span>
          <BlurInput
            size="sm"
            type="number"
            className="w-20"
            aria-label="Base font size"
            data-testid={`viz-edit-font-base-${paneId}`}
            value={typography.baseSize != null ? String(typography.baseSize) : ''}
            placeholder="12"
            onCommit={v => onSetTypography({ baseSize: v ? Number(v) : undefined })}
          />
        </div>
        {/* Per-element overrides — size + family; blank ⇒ inherit the figure font / element scale. */}
        {(['title', 'axis', 'tick', 'legend'] as const).map((el: TextElement) => {
          const label = el === 'title' ? 'Title' : el === 'axis' ? 'Axis' : el === 'tick' ? 'Ticks' : 'Legend'
          const ov = typography[el]
          return (
            <div key={el} className="mt-1 flex items-center gap-2">
              <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
              <BlurInput
                size="sm"
                type="number"
                className="w-16"
                aria-label={`${label} font size`}
                data-testid={`viz-edit-font-${el}-size-${paneId}`}
                value={ov?.size != null ? String(ov.size) : ''}
                placeholder="auto"
                onCommit={v => onSetTypography({ [el]: { size: v ? Number(v) : undefined } })}
              />
              <BlurInput
                size="sm"
                className="min-w-0 flex-1"
                aria-label={`${label} font family`}
                data-testid={`viz-edit-font-${el}-family-${paneId}`}
                value={ov?.family ?? ''}
                placeholder="inherit"
                onCommit={v => onSetTypography({ [el]: { family: v || undefined } })}
              />
            </div>
          )
        })}
      </Section>

      {hasColormap && (
        <Section title="Color">
          <label className="text-xs text-muted-foreground">Colormap</label>
          <Select
            size="sm"
            data-testid={`viz-edit-colormap-${paneId}`}
            aria-label="Colormap"
            value={colormap}
            onValueChange={v => onSetColormap(v as ContinuousColormap)}
            options={CONTINUOUS_COLORMAPS.filter(c => !BANNED_SEQUENTIAL.includes(c)).map(c => ({
              value: c,
              label: (
                <span className="flex items-center gap-2">
                  <span className="h-3 w-14 shrink-0 rounded-sm border border-border" style={{ background: gradientCss(c, [0, 1]) }} data-allow-custom-color />
                  <span>{c}</span>
                </span>
              ),
            }))}
          />
          {/* ITEM-18 compare mode: share one color scale across comparable panels. Hidden for matrix
              cells (heatmap/dotplot) where it is a no-op — see `compareApplicable`. */}
          {compareApplicable && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Compare (shared color scale)</span>
              <Switch
                aria-label="Compare — shared color scale"
                data-testid={`viz-edit-compare-${paneId}`}
                checked={linkColorScale}
                onCheckedChange={onToggleLinkColorScale}
              />
            </div>
          )}
        </Section>
      )}

      {isContinuous && (
        <Section title="Range">
          <div className="flex items-center gap-2">
            <BlurInput
              size="sm"
              type="number"
              className="w-24"
              data-testid={`viz-edit-range-lo-${paneId}`}
              aria-label="Range minimum"
              value={String(lo)}
              onCommit={v => onSetRange([Number(v), hi])}
            />
            <span className="text-muted-foreground">–</span>
            <BlurInput
              size="sm"
              type="number"
              className="w-24"
              data-testid={`viz-edit-range-hi-${paneId}`}
              aria-label="Range maximum"
              value={String(hi)}
              onCommit={v => onSetRange([lo, Number(v)])}
            />
            <Button variant="outline" data-testid={`viz-edit-range-reset-${paneId}`} onClick={() => domain && onSetRange([domain[0], domain[1]])}>
              Reset
            </Button>
          </div>
          {/* Render the LEGEND (visual-map) using this range as the FULL gradient, so a published plot
              with a custom range doesn't look "custom" (no in-band sub-range outline). */}
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Render legend using this range only</span>
            <Switch
              aria-label="Render legend using this range only"
              data-testid={`viz-edit-legend-use-range-${paneId}`}
              checked={legendUseRange}
              onCheckedChange={onSetLegendUseRange}
            />
          </div>
        </Section>
      )}

      {showMarks && (
        <Section title="Marks">
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-xs text-muted-foreground">Size</span>
            <Slider className="min-w-0 flex-1 px-2" data-testid={`viz-edit-size-${paneId}`} aria-label="Point size" min={MARK_RADIUS_MIN} max={MARK_RADIUS_MAX} step={MARK_RADIUS_STEP} value={[radius]} onValueChange={v => onSetRadius(first(v))} />
            <span className="w-8 shrink-0 text-end text-xs tabular-nums">{radius.toFixed(1)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-xs text-muted-foreground">Opacity</span>
            <Slider className="min-w-0 flex-1 px-2" data-testid={`viz-edit-opacity-${paneId}`} aria-label="Mark opacity" min={0} max={1} step={0.05} value={[opacity]} onValueChange={v => onSetOpacity(first(v))} />
            <span className="w-8 shrink-0 text-end text-xs tabular-nums">{opacity.toFixed(2)}</span>
          </div>
        </Section>
      )}

      {isCategorical && (
        <Section title="Categories">
          {/* Qualitative PALETTE picker — auto-populates every group's color from a matplotlib/scanpy
              palette (tab10/tab20/Set1…). Per-group tweaks below still win. */}
          <label className="text-xs text-muted-foreground">Palette</label>
          <Select
            size="sm"
            aria-label="Categorical palette"
            data-testid={`viz-edit-palette-${paneId}`}
            placeholder="Choose a palette…"
            onValueChange={v => onSetPalette(v)}
            options={QUALITATIVE_PALETTE_NAMES.map(p => ({
              value: p,
              label: (
                <span className="flex items-center gap-2">
                  <span className="flex overflow-hidden rounded-sm border border-border">
                    {QUALITATIVE_PALETTES[p].slice(0, 8).map((hex, i) => (
                      <span key={i} className="h-3 w-2.5" style={{ backgroundColor: hex }} data-allow-custom-color />
                    ))}
                  </span>
                  <span>{p === QUALITATIVE_PALETTE_KEY_DEFAULT ? `${p} (default)` : p}</span>
                </span>
              ),
            }))}
          />
          <ul className="mt-1 flex flex-col gap-1.5">
            {categoryEntries!.map(entry => {
              const name = categoryNames![entry.code] ?? entry.label
              const visible = !hidden.has(entry.code)
              // One string serves as BOTH the accessible name and the hover text.
              const legendToggleLabel = legendHidden.has(entry.code) ? `Show ${name} in legend` : `Hide ${name} from legend`
              return (
                <li key={entry.code} data-testid={`viz-edit-cat-${paneId}-${entry.code}`} className="flex items-center gap-2">
                  {/* A clean filled color SQUARE (rounded + border), with a transparent native color
                      input overlaid so a click still opens the OS picker — avoids the browser's boxed
                      "color inside a border" chrome. */}
                  <span className="relative inline-block size-5 shrink-0">
                    <span
                      className="block size-5 rounded-md border border-border"
                      style={{ backgroundColor: entry.hex }}
                      data-allow-custom-color
                    />
                    <input
                      type="color"
                      aria-label={`Color for ${name}`}
                      data-testid={`viz-edit-cat-color-${paneId}-${entry.code}`}
                      value={entry.hex}
                      onChange={e => onSetCategoryColor(name, e.target.value)}
                      className="absolute inset-0 size-5 cursor-pointer opacity-0"
                      data-allow-custom-color
                    />
                  </span>
                  <BlurInput
                    size="sm"
                    className="min-w-0 flex-1"
                    aria-label={`Rename ${name}`}
                    data-testid={`viz-edit-cat-label-${paneId}-${entry.code}`}
                    value={entry.label}
                    onCommit={v => onSetCategoryLabel(name, v)}
                  />
                  {/* Hide-from-LEGEND eye toggle — removes this entry from the legend list but keeps its
                      marks (distinct from the show/hide Switch, which hides the marks). */}
                  <button
                    type="button"
                    aria-label={legendToggleLabel}
                    title={legendToggleLabel}
                    aria-pressed={legendHidden.has(entry.code)}
                    data-testid={`viz-edit-cat-legendhide-${paneId}-${entry.code}`}
                    className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                    onClick={() => onToggleLegendHidden(entry.code)}
                  >
                    {legendHidden.has(entry.code) ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                  <Switch
                    aria-label={`Show ${name}`}
                    data-testid={`viz-edit-cat-toggle-${paneId}-${entry.code}`}
                    checked={visible}
                    onCheckedChange={() => onToggleCategory(entry.code)}
                  />
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {hasChannels && channels && (
        <Section title="Channels">
          {/* Single-channel COLORMAP — mutually exclusive with per-channel colors: choosing a
              colormap composites the whole image through it (Viv AdditiveColormapExtension);
              "Per-channel colors" restores independent per-channel RGB. */}
          {/* A BARE label, matching the Color section's identical picker four sections up: the kit
              `Select` renders no element carrying a caller `id`, so the `htmlFor` this used to
              declare pointed at nothing — a label wired to no control, which reads as an
              association to a checker and is none to a screen reader. The accessible name comes
              from the Select's own `aria-label`. Found by `dockDomIdentity`'s label-resolution
              clause, which walks every `label[for]` and requires a target. */}
          <label className="text-xs text-muted-foreground">Colormap</label>
          <Select
            size="sm"
            data-testid={`viz-edit-channel-colormap-${paneId}`}
            aria-label="Channel colormap"
            value={channelColormap && channelColormap.length > 0 ? channelColormap : CHANNEL_COLORMAP_NONE}
            onValueChange={v => onSetChannelColormap?.(v === CHANNEL_COLORMAP_NONE ? undefined : v)}
            options={[
              { value: CHANNEL_COLORMAP_NONE, label: 'Per-channel colors' },
              ...CHANNEL_COLORMAPS.map(c => ({ value: c, label: c })),
            ]}
          />
          <ul className="mt-1 flex flex-col gap-2">
            {channels.map((ch, i) => {
              const usingColormap = !!channelColormap && channelColormap.length > 0
              return (
                <li key={ch.name} data-testid={`viz-edit-channel-${paneId}-${i}`} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label={`${ch.name} visible`}
                      data-testid={`viz-edit-channel-visible-${paneId}-${i}`}
                      checked={ch.visible}
                      onCheckedChange={v => onSetChannel?.(i, visiblePatch(v))}
                    />
                    {/* Per-channel color swatch (mirrors the Categories swatch) — disabled while a
                        colormap is active, since the two are mutually exclusive. */}
                    {!usingColormap && (
                      <span className="relative inline-block size-5 shrink-0">
                        <span
                          className="block size-5 rounded-md border border-border"
                          style={{ backgroundColor: rgbToHex(ch.color) }}
                          data-allow-custom-color
                        />
                        <input
                          type="color"
                          aria-label={`${ch.name} color`}
                          data-testid={`viz-edit-channel-color-${paneId}-${i}`}
                          value={rgbToHex(ch.color)}
                          onChange={e => onSetChannel?.(i, colorPatch(e.target.value))}
                          className="absolute inset-0 size-5 cursor-pointer opacity-0"
                          data-allow-custom-color
                        />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{ch.name}</span>
                    <Button
                      variant="outline"
                      className="h-7 text-xs"
                      data-testid={`viz-edit-channel-auto-${paneId}-${i}`}
                      onClick={() => onAutoContrast?.(i)}
                    >
                      Auto
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-10 shrink-0 text-xs text-muted-foreground">Begin</span>
                    <Slider
                      className="min-w-0 flex-1 px-2"
                      data-testid={`viz-edit-channel-begin-${paneId}-${i}`}
                      aria-label={`${ch.name} contrast begin`}
                      min={0}
                      max={contrastMax}
                      step={1}
                      value={[ch.contrastLimits[0]]}
                      onValueChange={v => onSetChannel?.(i, contrastPatch(ch.contrastLimits, 'begin', first(v)))}
                    />
                    <span className="w-12 shrink-0 text-end text-xs tabular-nums">{ch.contrastLimits[0]}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-10 shrink-0 text-xs text-muted-foreground">End</span>
                    <Slider
                      className="min-w-0 flex-1 px-2"
                      data-testid={`viz-edit-channel-end-${paneId}-${i}`}
                      aria-label={`${ch.name} contrast end`}
                      min={0}
                      max={contrastMax}
                      step={1}
                      value={[ch.contrastLimits[1]]}
                      onValueChange={v => onSetChannel?.(i, contrastPatch(ch.contrastLimits, 'end', first(v)))}
                    />
                    <span className="w-12 shrink-0 text-end text-xs tabular-nums">{ch.contrastLimits[1]}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        </Section>
      )}
    </div>
  )
}
