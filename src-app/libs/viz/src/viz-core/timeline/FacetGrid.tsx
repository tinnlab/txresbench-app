// FacetGrid.tsx — small-multiples of a base GPU scatter (ITEM-46). Renders a row/grid of
// mini-views, one per `Facet`, each showing ONLY that facet's points and all SHARING one
// view domain (common scales). Framework-agnostic viz-core: depends only on @deck.gl/* +
// react (no @ziee/*).
//
// The per-facet filtering is done ENTIRELY ON THE GPU via `DataFilterExtension`: every
// mini-view is fed the SAME shared `positions` + `facetValue` (per-point categorical code
// as float) + `colors` buffers (zero-copy — one upload, referenced by all cells), and
// differs only in a per-view `filterRange` uniform `[code-0.5, code+0.5]`. There is NO
// CPU per-point loop and NO per-facet subarray copy on the hot path.

import { useEffect, useMemo, useRef, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScatterplotLayer } from '@deck.gl/layers'
import { DataFilterExtension } from '@deck.gl/extensions'
import { LIGHT_THEME, type VizTheme } from '../theme'
import { facetGridLayout, type Facet } from './faceting'
import {
  buildViews,
  buildViewStates,
  cellLayerId,
  makeLayerFilter,
  type CellViewState,
  type PaneRect,
} from '../layers/multiView'

/** Fill color for the GPU-filter path when no per-point `colors` buffer is supplied. */
const DEFAULT_RGBA: [number, number, number, number] = [90, 120, 210, 255]

export interface FilteredScatterProps {
  /** interleaved xy Float32Array, length N*2 (SHARED, zero-copy across views). */
  readonly positions: Float32Array
  /** per-point filter value, length N (SHARED). GPU keeps points inside `filterRange`. */
  readonly filterValue: Float32Array
  /** the GPU `DataFilterExtension` range — the ONLY thing that varies per view / per scrub. */
  readonly filterRange: readonly [number, number]
  /** optional per-point RGBA, length N*4 (SHARED). Omit for a flat fill. */
  readonly colors?: Uint8Array
  /** bump when `colors` CONTENTS change so the layer re-uploads. */
  readonly colorEpoch?: number
  readonly radius?: number
  readonly initialViewState?: Partial<OrthographicViewState>
  readonly onViewStateChange?: (viewState: OrthographicViewState) => void
  /** enable pan/zoom (timeline scatter = true; small-multiples = false). Default true. */
  readonly controller?: boolean
  readonly 'data-testid'?: string
}

/**
 * A single GPU-filtered scatter view. Points are shown iff `filterValue[i] ∈ filterRange`,
 * evaluated in the shader by `DataFilterExtension` — changing `filterRange` swaps only a
 * uniform (no attribute re-upload, no CPU loop). The heavy buffers are passed by reference
 * so many of these can share one upload (small-multiples) at zero copy.
 */
export function FilteredScatter({
  positions,
  filterValue,
  filterRange,
  colors,
  colorEpoch = 0,
  radius = 2,
  initialViewState,
  onViewStateChange,
  controller = true,
  'data-testid': testId,
}: FilteredScatterProps) {
  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])
  const filterExt = useMemo(() => new DataFilterExtension({ filterSize: 1 }), [])
  const hasColors = !!colors && colors.length > 0

  const layer = useMemo(() => {
    const n = positions.length / 2
    const attributes: Record<string, unknown> = {
      getPosition: { value: positions, size: 2 },
      getFilterValue: { value: filterValue, size: 1 },
    }
    if (hasColors) attributes.getFillColor = { value: colors, size: 4, normalized: true }
    return new ScatterplotLayer({
      id: 'facet-scatter',
      data: { length: n, attributes },
      ...(hasColors ? {} : { getFillColor: DEFAULT_RGBA }),
      radiusUnits: 'pixels',
      getRadius: radius,
      radiusMinPixels: 1,
      radiusMaxPixels: 8,
      stroked: false,
      filled: true,
      pickable: false,
      extensions: [filterExt],
      // the sliding/per-facet window — a uniform swap, NOT a data change.
      filterRange: [filterRange[0], filterRange[1]],
      // getFilterValue is STATIC (uploaded once); only re-upload on a colors change.
      updateTriggers: { getFillColor: colorEpoch },
    } as never)
    // filterRange is a scalar pair → listing it re-runs the memo (deck diffs the uniform,
    // no re-upload); positions/filterValue references stay stable across scrub.
  }, [positions, filterValue, colors, hasColors, colorEpoch, radius, filterExt, filterRange])

  const initial = useMemo(
    () => ({ target: [0, 0, 0], zoom: 4, ...initialViewState }) as OrthographicViewState,
    [initialViewState],
  )

  return (
    <div data-testid={testId} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <DeckGL
        views={view}
        controller={controller}
        initialViewState={initial}
        onViewStateChange={
          onViewStateChange
            ? (((p: { viewState: OrthographicViewState }) => onViewStateChange(p.viewState)) as never)
            : undefined
        }
        layers={[layer]}
      />
    </div>
  )
}

export interface FacetGridProps {
  /** interleaved xy Float32Array, length N*2 (SHARED across all facets). */
  readonly positions: Float32Array
  /** per-point categorical code as float, length N (SHARED) — the facet key. */
  readonly facetValue: Float32Array
  /** the facets to render (from `partitionByCategorical`). */
  readonly facets: readonly Facet[]
  /** optional per-point RGBA, length N*4 (SHARED). */
  readonly colors?: Uint8Array
  readonly colorEpoch?: number
  readonly radius?: number
  readonly maxCols?: number
  /** the SHARED view domain — every mini-view mounts with this (common scales). */
  readonly viewState?: Partial<OrthographicViewState>
  readonly theme?: VizTheme
  readonly 'data-testid'?: string
}

const FACET_GAP_PX = 8

/**
 * A grid of small-multiples: one GPU-filtered scatter per facet, all rendered in a SINGLE
 * `<DeckGL>` as N `OrthographicView`s (one WebGL context regardless of facet count — the
 * `layers/multiView` pattern). Previously each facet mounted its OWN `<DeckGL>`, so faceting a
 * high-cardinality column spawned N contexts and tripped deck.gl's "Too many active WebGL
 * contexts. Oldest context will be lost." (ITEM-5). All facets reference the same
 * `positions`/`facetValue`/`colors` buffers (zero copy) and share one `viewState` (common
 * scales); only each facet-layer's `filterRange` uniform differs.
 */
export function FacetGrid({
  positions,
  facetValue,
  facets,
  colors,
  colorEpoch = 0,
  radius = 2,
  maxCols = 4,
  viewState,
  theme = LIGHT_THEME,
  'data-testid': testId,
}: FacetGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const filterExt = useMemo(() => new DataFilterExtension({ filterSize: 1 }), [])
  const hasColors = !!colors && colors.length > 0

  // Measure the container so the per-facet view rects (deck positions views in PIXELS) track the
  // actual pane sizes; re-measure on resize.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { rows, cols } = facetGridLayout(facets.length, { maxCols })

  // One pixel rect per facet, laid out on the same row/col grid the old CSS grid used (gap
  // FACET_GAP_PX). Empty until the container is measured (deck renders nothing at 0×0).
  const panes = useMemo<PaneRect[]>(() => {
    if (size.w <= 0 || size.h <= 0) return []
    const nCols = Math.max(1, cols)
    const nRows = Math.max(1, rows)
    const cellW = (size.w - FACET_GAP_PX * (nCols - 1)) / nCols
    const cellH = (size.h - FACET_GAP_PX * (nRows - 1)) / nRows
    return facets.map((facet, i) => {
      const r = Math.floor(i / nCols)
      const c = i % nCols
      return {
        id: String(facet.code),
        x: c * (cellW + FACET_GAP_PX),
        y: r * (cellH + FACET_GAP_PX),
        width: Math.max(0, cellW),
        height: Math.max(0, cellH),
      }
    })
  }, [facets, cols, rows, size.w, size.h])

  // Facets share ONE viewState with the controller disabled at the Deck level
  // (common scales), so opt OUT of per-view controllers — otherwise a per-view
  // `controller: true` would override the top-level `controller={false}` and let
  // facets pan/zoom independently, breaking the shared-domain invariant.
  const views = useMemo(() => buildViews(panes, { controller: false }), [panes])

  // Every facet view mounts with the SAME shared view domain (common scales).
  const viewStates = useMemo(() => {
    const cell: CellViewState = {
      target: [viewState?.target?.[0] ?? 0, viewState?.target?.[1] ?? 0],
      zoom: typeof viewState?.zoom === 'number' ? viewState.zoom : 0,
    }
    const states: Record<string, CellViewState> = {}
    for (const pane of panes) states[pane.id] = cell
    return buildViewStates(panes, states)
  }, [panes, viewState])

  // One ScatterplotLayer per facet, id-prefixed with its facet code so `layerFilter` draws it
  // ONLY in its own viewport. Shared buffers (zero copy); only `filterRange` differs.
  const layers = useMemo(() => {
    const n = positions.length / 2
    const attributes: Record<string, unknown> = {
      getPosition: { value: positions, size: 2 },
      getFilterValue: { value: facetValue, size: 1 },
    }
    if (hasColors) attributes.getFillColor = { value: colors, size: 4, normalized: true }
    return facets.map(
      facet =>
        new ScatterplotLayer({
          id: cellLayerId(String(facet.code), 'scatter'),
          data: { length: n, attributes },
          ...(hasColors ? {} : { getFillColor: DEFAULT_RGBA }),
          radiusUnits: 'pixels',
          getRadius: radius,
          radiusMinPixels: 1,
          radiusMaxPixels: 8,
          stroked: false,
          filled: true,
          pickable: false,
          extensions: [filterExt],
          // categorical membership: keep exactly `code` (± 0.5 guards float codes).
          filterRange: [facet.code - 0.5, facet.code + 0.5],
          updateTriggers: { getFillColor: colorEpoch },
        } as never),
    )
  }, [positions, facetValue, colors, hasColors, colorEpoch, radius, facets, filterExt])

  const layerFilter = useMemo(() => makeLayerFilter({}), [])

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      // The single deck canvas clears transparent, so the container's surface shows behind every
      // facet's points — this is what carries the theme background now that per-pane opaque divs
      // (which would hide points over the shared canvas) are gone.
      style={{ position: 'relative', width: '100%', height: '100%', background: theme.surface }}
    >
      <DeckGL
        views={views}
        viewState={viewStates as never}
        controller={false}
        layers={layers}
        layerFilter={layerFilter as never}
      />
      {/* Per-facet chrome (border + label) as HTML overlays over each pane rect — one deck
          context draws all the points; these are just non-interactive decorations. */}
      {panes.map((pane, i) => {
        const facet = facets[i]
        if (!facet) return null
        return (
          <div
            key={facet.code}
            data-testid={testId ? `${testId}-facet-${facet.code}` : undefined}
            style={{
              position: 'absolute',
              left: pane.x,
              top: pane.y,
              width: pane.width,
              height: pane.height,
              border: `1px solid ${theme.border}`,
              borderRadius: 4,
              pointerEvents: 'none',
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 4,
                left: 6,
                fontSize: 12,
                color: theme.fg,
                textShadow: `0 1px 2px ${theme.surface}`,
              }}
            >
              {facet.label}{' '}
              <span style={{ color: theme.muted }}>
                ({facet.indices.length.toLocaleString()})
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * A SHARED orthographic view fit to ALL points' bounds — so every facet mini-view frames
 * the same domain (common scales). Pure: computes the bounding box centroid (`target`) +
 * a `zoom` that fits the larger span into `nominalPx` pixels. No per-point color/state.
 */
export function sharedViewFromPositions(
  positions: Float32Array,
  nominalPx = 260,
): OrthographicViewState {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i]
    const y = positions[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { target: [0, 0, 0], zoom: 4 } as OrthographicViewState
  }
  const spanX = Math.max(1e-6, maxX - minX)
  const spanY = Math.max(1e-6, maxY - minY)
  const span = Math.max(spanX, spanY)
  // orthographic zoom z ⇒ 2^z pixels per world unit; fit `span` into ~90% of nominalPx.
  const zoom = Math.log2((nominalPx * 0.9) / span)
  return {
    target: [(minX + maxX) / 2, (minY + maxY) / 2, 0],
    zoom,
  } as OrthographicViewState
}
