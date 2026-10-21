// faceting.story.tsx — FACETING / small-multiples: split the fixture by a categorical
// column into a grid of mini-views, each showing ONLY that facet's points, all sharing
// one view domain (common scales). The per-facet filtering is on the GPU (each mini-view
// filters the SHARED positions/codes buffers to its own categorical code via a
// `filterRange` uniform) — zero-copy, no per-facet CPU subarray on the hot path.

import { useEffect, useMemo, useState } from 'react'
import { FacetGrid, sharedViewFromPositions } from '../../viz-core/timeline/FacetGrid'
import { partitionByCategorical, type Facet } from '../../viz-core/timeline/faceting'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import { DARK_THEME } from '../../viz-core/theme'
import type { OrthographicViewState } from '@deck.gl/core'
import { registerStory } from '../registry'

type FacetKey = 'batch' | 'group'

function FacetingStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 200_000 }), [])
  const [facetKey, setFacetKey] = useState<FacetKey>('batch')
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [facetValue, setFacetValue] = useState<Float32Array | null>(null)
  const [facets, setFacets] = useState<Facet[] | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [view, setView] = useState<OrthographicViewState | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      if (alive) {
        setPositions(pos.positions)
        setView(sharedViewFromPositions(pos.positions, 260))
      }
    })()
    return () => {
      alive = false
    }
  }, [source])

  useEffect(() => {
    let alive = true
    void (async () => {
      const cat = await source.categorical(facetKey)
      const { colors: c } = await computeColoring(source, {
        mode: 'categorical',
        key: facetKey,
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      // codes → Float32 GPU-filter attribute (one allocation at load; shared by all cells).
      setFacetValue(Float32Array.from(cat.codes))
      setFacets(partitionByCategorical(cat.codes, cat.categories))
      setColors(c)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source, facetKey])

  const ready = positions && facetValue && facets && colors && view

  return (
    <div data-testid="viz-faceting" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <label>
          Facet by:{' '}
          <select
            data-testid="faceting-key"
            value={facetKey}
            onChange={e => setFacetKey(e.target.value as FacetKey)}
          >
            <option value="batch">Batch</option>
            <option value="group">Group</option>
          </select>
        </label>
        <span style={{ opacity: 0.6 }}>
          {facets ? `${facets.length} facets · shared scales · GPU per-facet filter` : 'loading…'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 8 }}>
        {ready ? (
          <FacetGrid
            positions={positions}
            facetValue={facetValue}
            facets={facets}
            colors={colors}
            colorEpoch={colorEpoch}
            radius={2}
            maxCols={4}
            viewState={view}
            theme={DARK_THEME}
            data-testid="viz-faceting-grid"
          />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'facet-grid',
  category: 'View kinds',
  title: 'Faceting — small-multiples by a categorical (shared scales)',
  covers: 'faceting',
  Component: FacetingStory,
})
