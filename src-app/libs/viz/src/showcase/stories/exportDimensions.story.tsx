// exportDimensions.story.tsx — the EXPORT-DIMENSION showcase (scale factor +
// custom output size). Mounts an ExportDialog over a plain, FIXED-SIZE 2D canvas
// (deterministic — no WebGL/fixture timing), so the e2e can export at 1× / 2× /
// custom and assert the output pixel dimensions exactly. The canvas backing store
// is a known 400×300 with drawn content so a raster export is non-empty and its
// size is predictable.

import { useEffect, useRef } from 'react'
import { ExportDialog } from '../../viz-core/export/ExportDialog'
import { registerStory } from '../registry'

// Fixed backing-store size — the e2e asserts 2× ⇒ 800×600 and custom ⇒ exact box.
const CANVAS_W = 400
const CANVAS_H = 300

function ExportDimensionsStory() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    // Paint deterministic, non-uniform content so the PNG is non-empty and a
    // resize/letterbox is visually verifiable.
    ctx.fillStyle = '#0b3d91'
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
    ctx.fillStyle = '#f5a623'
    ctx.fillRect(40, 40, CANVAS_W - 80, CANVAS_H - 80)
    ctx.fillStyle = '#ffffff'
    ctx.font = '24px sans-serif'
    ctx.fillText('EXPORT', 120, 160)
  }, [])

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, padding: 16 }}>
        <canvas
          ref={canvasRef}
          data-testid="export-dim-canvas"
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ width: CANVAS_W, height: CANVAS_H, border: '1px solid #888' }}
        />
      </div>
      <div style={{ borderLeft: '1px solid rgba(128,128,128,0.3)' }}>
        {/* No paneRect → the whole (fixed-size) canvas is the export source, so
            the output dims are deterministic for the e2e assertions. */}
        <ExportDialog canvas={() => canvasRef.current} filename="dims" />
      </div>
    </div>
  )
}

registerStory({
  id: 'export-dimensions',
  category: 'Export',
  title: 'Export — scale factor & custom output size',
  covers: 'export',
  Component: ExportDimensionsStory,
})
