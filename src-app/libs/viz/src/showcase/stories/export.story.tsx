// export.story.tsx — the Export showcase story (DEC-31/36). Renders a fixture-seeded
// DeckScatterCanvas next to an ExportDialog wired to it, so a human can export a PNG
// (and a sample spec as JSON). The dialog resolves the deck.gl <canvas> lazily out of
// the wrapper via a ref-based getter.

import { useEffect, useMemo, useRef, useState } from 'react'
import { DeckScatterCanvas } from '../../viz-core/DeckScatterCanvas'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, type ColorBy } from '../../viz-core/data/engine'
import { ExportDialog } from '../../viz-core/export/ExportDialog'
import type { WorkspaceSpec } from '../../viz-core/export/spec'
import { registerStory } from '../registry'

const SAMPLE_SPEC: WorkspaceSpec = {
  version: 1,
  layout: {
    type: 'split',
    direction: 'row',
    sizes: [0.5, 0.5],
    children: [
      { type: 'leaf', cellId: 'a' },
      { type: 'leaf', cellId: 'b' },
    ],
  },
  cells: [
    { id: 'a', kind: 'scatter', colorBy: 'categorical:group' },
    { id: 'b', kind: 'scatter', colorBy: 'continuous:score' },
  ],
}

function ExportStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 50_000 }), [])
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)

  const colorBy = useMemo<ColorBy>(
    () => ({
      mode: 'categorical',
      key: 'group',
      colormap: 'viridis',
      scale: 'linear',
      hidden: new Set(),
    }),
    [],
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const c = await computeColoring(source, colorBy)
      if (!alive) return
      setPositions(pos.positions)
      setColors(c.colors)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source, colorBy])

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div ref={wrapperRef} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {positions && colors ? (
          <DeckScatterCanvas positions={positions} colors={colors} colorEpoch={colorEpoch} />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
      <div style={{ borderLeft: '1px solid rgba(128,128,128,0.3)' }}>
        <ExportDialog
          canvas={() => wrapperRef.current?.querySelector('canvas') ?? null}
          spec={SAMPLE_SPEC}
          filename="scatter"
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'export-basic',
  category: 'Export',
  title: 'Export — PNG raster / CSV data / JSON spec',
  covers: 'export',
  Component: ExportStory,
})
