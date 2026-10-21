// spatial.story.tsx — the `image` + `density-grid` view-kind showcase stories
// (ITEM-10 / ITEM-23). Both seed from the fixture `DataSource`: the image story
// composites the fixture's raster underlay under affine-aligned spots; the density
// story bins the primary layout's points on the GPU. Follows scatter.story.tsx
// (async fixture load in a useEffect).

import { useEffect, useMemo, useState } from 'react'
import { ImageCanvas } from '../../viz-core/layers/ImageCanvas'
import { DensityCanvas } from '../../viz-core/layers/DensityCanvas'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import type { ImageUnderlay } from '../../viz-core/data/wire'
import { registerStory } from '../registry'

// ── image (spatial) view-kind ────────────────────────────────────────────────
function ImageStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 60_000 }), [])
  const [underlay, setUnderlay] = useState<ImageUnderlay | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      const img = await source.imageUnderlay()
      const pos = await source.positions('image')
      const c = await computeColoring(source, {
        mode: 'categorical',
        key: 'group',
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      setUnderlay(img)
      setPositions(pos.positions)
      setColors(c.colors)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, opacity: 0.6 }}>Image underlay + affine-aligned spots</div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {underlay && positions && colors ? (
          <ImageCanvas
            underlay={underlay}
            positions={positions}
            colors={colors}
            affine={underlay.affine}
            colorEpoch={colorEpoch}
          />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

// ── density-grid view-kind ───────────────────────────────────────────────────
function DensityStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 200_000 }), [])
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [weights, setWeights] = useState<Float32Array | null>(null)
  const [hexagon, setHexagon] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const cont = await source.continuous('pseudo')
      if (!alive) return
      setPositions(pos.positions)
      setWeights(cont.value)
    })()
    return () => {
      alive = false
    }
  }, [source])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
        <label>
          <input
            data-testid="density-hexagon"
            type="checkbox"
            checked={hexagon}
            onChange={e => setHexagon(e.target.checked)}
          />{' '}
          Hexbin
        </label>
        <span style={{ opacity: 0.6 }}>GPU-binned density grid</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {positions ? (
          <DensityCanvas
            positions={positions}
            weights={weights ?? undefined}
            hexagon={hexagon}
          />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'image-underlay',
  category: 'View kinds',
  title: 'Image — raster underlay + affine-aligned spots',
  covers: 'image',
  Component: ImageStory,
})

registerStory({
  id: 'density-grid',
  category: 'View kinds',
  title: 'Density grid — GPU count/mean binning (square / hexbin)',
  covers: 'grid',
  Component: DensityStory,
})
