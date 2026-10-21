// tiled-scatter.story.tsx — the GPU UNBOUNDED-SCALE tiling showcase (PERFORMANCE_PLAN.md Phase 3 /
// B1). A large categorical point cloud renders through `CategoricalPointsView`; a "tiling" toggle
// forces the `tiling` override ON/OFF. ON → a CLIENT quadtree (`scale/tilePyramid.ts`) draws only
// the viewport's tiles at a zoom-matched budget via {@link TiledPointsView} — so drawnPoints ≪
// totalPoints and per-frame cost decouples from N; OFF → the normal single/chunked GPU point path.
//
// The story mirrors `window.__VIZ_TEST__ = { tilingActive, visibleTiles, drawnPoints, totalPoints,
// level }` so the e2e can assert the tiled render actually SELECTED a viewport subset (drawnPoints
// ≪ totalPoints), rendered non-blank, and re-selected on pan — not merely that a control flipped.
// The override (not ambient auto) is used because the e2e harness must force the mode deterministically.

import { useEffect, useMemo, useState } from 'react'
import { CategoricalPointsView } from '../../viz-core/spatial/CategoricalPointsView'
import { makeCategoricalPointsFixture } from '../../viz-core/spatial/categoricalPointsFixture'
import { registerStory } from '../registry'
import { usePointCount } from '../pointCountControl'

const DEFAULT_POINTS = 2_000_000

function TiledScatterStory() {
  const [points, pointControl] = usePointCount(DEFAULT_POINTS)
  const fixture = useMemo(
    () => makeCategoricalPointsFixture({ count: points, categoryCount: 12, seed: 13 }),
    [points],
  )
  const [visible] = useState<Set<number>>(
    () => new Set(Array.from({ length: fixture.categoryCount }, (_, i) => i)),
  )
  const [tilingOn, setTilingOn] = useState(true)
  const [sel, setSel] = useState<{ visibleTiles: number; drawnPoints: number; level: number }>({
    visibleTiles: 0,
    drawnPoints: 0,
    level: 0,
  })

  // Mirror the active mode + last selection for the harness. tilingOn ⇒ TiledPointsView draws only a
  // viewport subset (drawnPoints ≪ totalPoints); off ⇒ the full GPU point path (drawn == total).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      tilingActive: tilingOn,
      visibleTiles: sel.visibleTiles,
      drawnPoints: tilingOn ? sel.drawnPoints : fixture.count,
      totalPoints: fixture.count,
      level: sel.level,
      loaded: true,
    }
  }, [tilingOn, sel, fixture.count])

  return (
    <div
      data-testid="viz-tiled-scatter-story"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Tiled scatter</strong>
        {pointControl}
        <span style={{ opacity: 0.7 }}>
          {fixture.count.toLocaleString()} points ·{' '}
          {tilingOn
            ? `${sel.drawnPoints.toLocaleString()} drawn · ${sel.visibleTiles} tiles · L${sel.level}`
            : 'full GPU points'}
        </span>
        <button
          type="button"
          aria-pressed={tilingOn}
          data-testid="viz-tiled-scatter-toggle"
          onClick={() => setTilingOn(v => !v)}
          style={{
            padding: '2px 10px',
            borderRadius: 4,
            border: '1px solid #ccc',
            cursor: 'pointer',
            background: tilingOn ? '#3355dd' : '#f2f2f2',
            color: tilingOn ? '#fff' : '#222',
          }}
        >
          Tiling: {tilingOn ? 'on' : 'off'}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <CategoricalPointsView
          positions={fixture.positions}
          categoryCodes={fixture.categoryCodes}
          categoryCount={fixture.categoryCount}
          categoryNames={fixture.categoryNames}
          visibleCategories={visible}
          showLegend={false}
          initialViewState={{ target: [0, 0, 0], zoom: 2 } as never}
          tiling={{
            override: tilingOn,
            targetPoints: 200_000,
            onSelection: info =>
              setSel({
                visibleTiles: info.visibleTiles,
                drawnPoints: info.drawnPoints,
                level: info.level,
              }),
          }}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'tiled-scatter',
  category: 'Scale / perf',
  title: 'Tiled scatter — client quadtree + viewport LOD (draws only on-screen tiles)',
  covers: 'tiled-scatter',
  Component: TiledScatterStory,
})
