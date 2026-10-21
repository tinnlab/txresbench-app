// chunked.story.tsx — the 10M+ multi-chunk scale story (ITEM-62). Renders ChunkedScatter
// over a large FixtureSource: the dataset is split into N ScatterplotLayers (one per chunk)
// under a per-layer GPU-memory budget, each fed a ZERO-COPY subarray of the shared
// positions/colors buffers. Default 1M points (headless swiftshader can render that); pass
// `?points=10000000` in the URL to push toward the 10M tier. A readout shows
// {total, chunks, bytesEstimate}; the plan is mirrored to window.__VIZ_TEST__.chunkPlan.

import { useEffect, useMemo, useState } from 'react'
import { ChunkedScatter, type ChunkRenderPlan } from '../../viz-core/scale/ChunkedScatter'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import { registerStory } from '../registry'
import { usePointCount } from '../pointCountControl'

const DEFAULT_POINTS = 1_000_000
// A tight per-layer budget so even the 1M default splits into several chunks (proves the
// multi-chunk path visibly): 250k points × 12 B = 3 MB/layer.
const DEMO_GPU_BYTE_BUDGET = 250_000 * 12

function readPointCount(): number {
  if (typeof window === 'undefined') return DEFAULT_POINTS
  const raw = new URLSearchParams(window.location.search).get('points')
  const n = raw ? Number.parseInt(raw, 10) : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_POINTS
  // clamp to a sane ceiling so a fat-fingered URL can't OOM the fixture generator.
  return Math.min(n, 20_000_000)
}

// Optional `?maxChunks=` shrinks the aggregate VRAM capacity (maxChunks × pointsPerChunk) so
// a modest `?points=` overshoots it and exercises the over-budget → LOD path within the 20M
// clamp — e.g. `?points=2000000&maxChunks=4` (cap = 4 × 250k = 1M < 2M → LOD applied).
function readMaxChunks(): number | undefined {
  if (typeof window === 'undefined') return undefined
  const raw = new URLSearchParams(window.location.search).get('maxChunks')
  if (!raw) return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n
}

function ChunkedScatterStory() {
  const [pointCount, pointControl] = usePointCount(readPointCount()) // #12: interface control (URL-seeded)
  const maxChunks = useMemo(readMaxChunks, [])
  const source = useMemo(
    () => new FixtureSource({ seed: 42, pointCount }),
    [pointCount],
  )
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [render, setRender] = useState<ChunkRenderPlan | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const coloring = await computeColoring(source, {
        mode: 'categorical',
        key: 'group',
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      setPositions(pos.positions)
      setColors(coloring.colors)
    })()
    return () => {
      alive = false
    }
  }, [source])

  // Mirror the chunk plan to the test-hook inspector (DEC-36) so a headless run can assert
  // the chunking — AND the over-budget → LOD downsampling — without pixels. `chunkPlan.chunks`
  // is the EFFECTIVE (post-LOD) layer count actually rendered; `lodApplied` / `shownTotal`
  // make the over-budget path render-verifiable (a big `?points=` + small `?maxChunks=` trips it).
  useEffect(() => {
    if (!render) return
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      chunkPlan: {
        total: render.plan.total,
        chunks: render.renderPlan.chunkCount,
        pointsPerChunk: render.renderPlan.pointsPerChunk,
        bytesEstimate: render.plan.bytesEstimate,
        verdict: render.plan.verdict,
        lodStride: render.plan.lodStride,
      },
      lodApplied: render.lodApplied,
      shownTotal: render.shownTotal,
    }
  }, [render])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
        {pointControl}
        <span data-testid="chunked-readout" style={{ opacity: 0.7, fontSize: 13 }}>
          {render
            ? render.lodApplied
              ? `${render.sourceTotal.toLocaleString()} points → LOD ${render.lodStride}× → ` +
                `${render.shownTotal.toLocaleString()} shown · ${render.renderPlan.chunkCount} chunks`
              : `${render.plan.total.toLocaleString()} points · ${render.renderPlan.chunkCount} chunks · ` +
                `${(render.plan.bytesEstimate / (1024 * 1024)).toFixed(1)} MB`
            : 'building fixture…'}
        </span>
        <span style={{ opacity: 0.5, fontSize: 12 }}>
          append <code>?points=10000000</code> to push toward 10M
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {positions && colors ? (
          <ChunkedScatter
            positions={positions}
            colors={colors}
            gpuByteBudget={DEMO_GPU_BYTE_BUDGET}
            maxChunks={maxChunks}
            onPlan={setRender}
          />
        ) : (
          <div style={{ padding: 16 }}>Generating {pointCount.toLocaleString()}-point fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'chunked-scatter',
  category: 'Scale / perf',
  title: 'Chunked scatter — 10M+ tier (N layers under a GPU-memory budget)',
  covers: 'chunking',
  Component: ChunkedScatterStory,
})
