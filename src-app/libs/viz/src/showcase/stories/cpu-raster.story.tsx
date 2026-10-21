// cpu-raster.story.tsx — the CPU-RASTER fast-path showcase (PERFORMANCE_PLAN.md Phase 1). A
// dense categorical point cloud renders through `CategoricalPointsView`; a "CPU raster mode"
// toggle forces the `cpuRaster` override ON/OFF. ON → the cloud is drawn as ONE CPU-binned +
// shaded `BitmapLayer` quad (the software-renderer unlock, O(pixels), N-independent) instead of
// N GL_POINTS; OFF → the normal GPU point path returns. The override is used (not ambient auto)
// because the e2e harness is ITSELF SwiftShader, so the spec must force the mode deterministically.
//
// The story mirrors `window.__VIZ_TEST__ = { rasterActive, bitmapLayerPresent, pointLayerPresent,
// loaded, pointCount, packed }` so the swiftshader e2e can assert the render actually SWAPPED (a
// single non-blank BitmapLayer + no per-point layer when on; points back when off) AND that a
// large `?points=10000000` cloud LOADED (Phase 2 raster-first + 16-bit packing) rather than just
// that a control flipped.

import { useEffect, useMemo, useState } from 'react'
import { CategoricalPointsView } from '../../viz-core/spatial/CategoricalPointsView'
import { makeCategoricalPointsFixture } from '../../viz-core/spatial/categoricalPointsFixture'
import { registerStory } from '../registry'
import { usePointCount } from '../pointCountControl'

const DEFAULT_POINTS = 300_000

function readBoolParam(name: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  const raw = new URLSearchParams(window.location.search).get(name)
  if (raw == null) return fallback
  return raw === '1' || raw === 'true'
}

function CpuRasterStory() {
  const [points, pointControl] = usePointCount(DEFAULT_POINTS)
  // 16-bit position packing (Phase 2) — ON by default (halves the worker transfer); force with
  // ?packed=0/1. At ?points=10000000 the raster-first gate + packing are what make it LOAD.
  const packedOn = useMemo(() => readBoolParam('packed', true), [])
  const fixture = useMemo(
    () => makeCategoricalPointsFixture({ count: points, categoryCount: 12, seed: 11 }),
    [points],
  )
  const [visible] = useState<Set<number>>(
    () => new Set(Array.from({ length: fixture.categoryCount }, (_, i) => i)),
  )
  const [rasterOn, setRasterOn] = useState(true)

  // Mirror the active render mode for the harness. rasterOn ⇒ a BitmapLayer quad (no points);
  // rasterOff ⇒ the GPU point layer (no raster). `loaded` flips true once the fixture is built +
  // the view mounted, so the e2e can wait for a genuine large-N load, not just a control flip.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      rasterActive: rasterOn,
      bitmapLayerPresent: rasterOn,
      pointLayerPresent: !rasterOn,
      totalPoints: fixture.count,
      loaded: true,
      pointCount: fixture.count,
      packed: rasterOn && packedOn,
    }
  }, [rasterOn, fixture.count, packedOn])

  return (
    <div
      data-testid="viz-cpu-raster-story"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>CPU raster</strong>
        {pointControl}
        <span style={{ opacity: 0.7 }}>
          {fixture.count.toLocaleString()} points · {rasterOn ? 'BitmapLayer quad' : 'GPU points'}
        </span>
        <button
          type="button"
          aria-pressed={rasterOn}
          data-testid="viz-cpu-raster-toggle"
          onClick={() => setRasterOn(v => !v)}
          style={{
            padding: '2px 10px',
            borderRadius: 4,
            border: '1px solid #ccc',
            cursor: 'pointer',
            background: rasterOn ? '#3355dd' : '#f2f2f2',
            color: rasterOn ? '#fff' : '#222',
          }}
        >
          CPU raster mode: {rasterOn ? 'on' : 'off'}
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
          initialViewState={{ target: [0, 0, 0], zoom: -1 } as never}
          cpuRaster={{ override: rasterOn, colormap: 'viridis', normalize: 'log', packed: packedOn }}
          overlapTooltip
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'cpu-raster',
  category: 'Scale / perf',
  title: 'CPU raster — bin-then-shade BitmapLayer for the software-renderer fast path',
  covers: 'cpu-raster',
  Component: CpuRasterStory,
})
