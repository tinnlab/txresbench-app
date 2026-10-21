// LabelMaskView.tsx — the label-mask VIEW: a `<DeckGL>` (OrthographicView)
// rendering the GPU `LabelMaskLayer` over an integer label raster, colored by category
// in-shader, with a FILL ↔ OUTLINE toggle and a hover readout of the picked label id.
// Framework-agnostic (viz-core): depends only on @deck.gl/* + react — nothing here knows
// about any domain (a label is just a labelled region).

import { useMemo, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { LabelMaskLayer } from './LabelMaskLayer'
import type { LabelMask, Palette } from './labelMaskColor'

export interface LabelMaskViewProps {
  /** integer label raster, row-major, id per pixel (0 = background). */
  labelMask: LabelMask
  width: number
  height: number
  /** id→category code (index 0 = background); drives the in-shader color-by-category. */
  categoryForId: Uint16Array
  /** categorical palette for the categories (default the shared categorical palette). */
  palette?: Palette
  /** boundary stroke width in texels. */
  strokeWidth?: number
  /** start in outline mode instead of fill. */
  initialOutline?: boolean
  /** notified as the pointer moves over a labelled region (id) / background (null). */
  onHoverId?: (id: number | null) => void
  /** notified when a labelled region is clicked (id) / background cleared (null) — the selection. */
  onSelectId?: (id: number | null) => void
  /**
   * ITEM-11 — human label for a category code, shown alongside the cell id in the readout
   * (e.g. `c => classNames[c]`). Defaults to `Class {code}`.
   */
  categoryLabel?: (category: number) => string
  /** ITEM-11 — categories to hide (their ids get LUT alpha 0). */
  hiddenCategories?: Set<number> | null
  /** ITEM-11 — solo one category (only it is visible); overrides `hiddenCategories`. */
  soloCategory?: number | null
}

/** deck.gl types `modelMatrix`/pick info loosely; a tiny local alias keeps casts honest. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PickInfo = any

export function LabelMaskView({
  labelMask,
  width,
  height,
  categoryForId,
  palette,
  strokeWidth = 1.5,
  initialOutline = false,
  onHoverId,
  onSelectId,
  categoryLabel,
  hiddenCategories,
  soloCategory,
}: LabelMaskViewProps) {
  const [outline, setOutline] = useState(initialOutline)
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  // The category/class of the pixel currently under the readout (hovered, else selected).
  const readoutId = hoveredId ?? selectedId
  const readoutCategory =
    readoutId != null && readoutId > 0 && readoutId < categoryForId.length
      ? categoryForId[readoutId]
      : null
  const classText =
    readoutCategory == null
      ? '—'
      : categoryLabel
        ? categoryLabel(readoutCategory)
        : `Class ${readoutCategory}`

  const view = useMemo(() => new OrthographicView({ id: 'label-mask', flipY: true }), [])

  // The label raster shares the image coordinate space: BitmapLayer bounds are
  // [minX, minY, maxX, maxY] = [0, height, width, 0] (flipY) so pixel (x,y) maps to
  // world (x,y). Center the ortho camera on the raster.
  const bounds = useMemo<[number, number, number, number]>(
    () => [0, height, width, 0],
    [width, height],
  )
  const initialViewState = useMemo<OrthographicViewState>(
    () => ({ target: [width / 2, height / 2, 0], zoom: 0 }) as OrthographicViewState,
    [width, height],
  )

  const layers = useMemo(() => {
    return [
      new LabelMaskLayer({
        id: 'label-mask-layer',
        labelMask,
        width,
        height,
        categoryForId,
        palette,
        bounds,
        // FILL: solid color-by-category fills, no stroke. OUTLINE: region boundaries only
        // (transparent fills via fillOpacity 0 + the in-shader stroke).
        stroked: outline,
        fillOpacity: outline ? 0 : 1,
        strokeWidth,
        // ITEM-11: class hide/solo (LUT alpha) + in-shader selection highlight.
        hiddenCategories,
        soloCategory,
        selectedId,
        pickable: true,
        onHover: (info: PickInfo) => {
          const id: number | null = info?.id ?? null
          setHoveredId(id)
          onHoverId?.(id)
        },
        onClick: (info: PickInfo) => {
          const id: number | null = info?.id ?? null
          setSelectedId(id)
          onSelectId?.(id)
        },
      }),
    ]
  }, [
    labelMask,
    width,
    height,
    categoryForId,
    palette,
    bounds,
    outline,
    strokeWidth,
    hiddenCategories,
    soloCategory,
    selectedId,
    onHoverId,
    onSelectId,
  ])

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      data-testid="viz-label-mask-view"
    >
      <DeckGL views={view} controller initialViewState={initialViewState} layers={layers} />
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          background: 'rgba(255,255,255,0.82)',
          padding: '4px 8px',
          borderRadius: 4,
          fontSize: 12,
        }}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={outline}
            onChange={e => setOutline(e.target.checked)}
            data-testid="viz-label-mask-outline-toggle"
          />
          Outline
        </label>
        <span data-testid="viz-label-mask-hover-readout">
          Cell: {readoutId == null || readoutId <= 0 ? '—' : readoutId} · {classText}
        </span>
        {selectedId != null && selectedId > 0 && (
          <span data-testid="viz-label-mask-selected-readout">Selected: {selectedId}</span>
        )}
      </div>
    </div>
  )
}
