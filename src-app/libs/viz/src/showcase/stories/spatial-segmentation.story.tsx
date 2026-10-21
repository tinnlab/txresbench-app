// spatial-segmentation.story.tsx — the GPU label-mask view-kind showcase.
// Renders the synthetic label-mask fixture (blobby, distinctly-labelled regions) with
// the `LabelMaskLayer`: color-by-category in-shader, a FILL ↔ OUTLINE toggle, and a
// hover readout of the picked label id (mirrored to window.__VIZ_TEST__.hoveredCellId for
// the visual/e2e harness — key kept for e2e compat). Follows spatial.story.tsx / scatter.story.tsx conventions.

import { useEffect, useMemo, useState } from 'react'
import { LabelMaskView } from '../../viz-core/spatial/LabelMaskView'
import { makeLabelMaskFixture } from '../../viz-core/spatial/labelMaskFixture'
import { registerStory } from '../registry'

function SegmentationStory() {
  const fixture = useMemo(() => makeLabelMaskFixture({ seed: 7 }), [])
  const [hoveredId, setHoveredId] = useState<number | null>(null)

  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), hoveredCellId: hoveredId }
  }, [hoveredId])

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      data-testid="viz-spatial-segmentation"
    >
      <div style={{ padding: 8, opacity: 0.6 }}>
        GPU label-mask overlay — {fixture.labelCount} regions, {fixture.categoryCount} categories ·
        color-by-category in-shader · toggle fill/outline · hover a region for its id
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <LabelMaskView
          labelMask={fixture.labelMask}
          width={fixture.width}
          height={fixture.height}
          categoryForId={fixture.categoryForId}
          onHoverId={setHoveredId}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'spatial-segmentation',
  category: 'View kinds',
  title: 'Segmentation — GPU label-mask overlay (color-by-type · fill/outline · hover→cell id)',
  covers: 'segmentation',
  Component: SegmentationStory,
})
