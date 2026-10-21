// annotate-brush.story.tsx (ITEM-15, P1) — the freehand / brush region tool (ITEM-4). Same
// standalone editor + tool rail as `annotate-draw`, but the Brush tool is pre-selected: drag a
// freehand stroke and it is captured → RDP-simplified → stamped into a bounded scratch raster →
// marching-squares boundary → committed as a polygon (the mask-brush-fix path, INV-6). Seeded with
// a few existing regions so a brushed addition reads against real content. Authored at desktop + 390px.

import { useEffect, useMemo } from 'react'
import { AnnotateProvider } from '../../viz-core/annotate/AnnotateContext'
import { AnnotateControls } from '../../viz-core/annotate/AnnotateControls'
import { createAnnotateStore } from '../../viz-core/annotate/Annotate.store'
import { makeAnnotateFixture } from '../../viz-core/annotate/annotateFixture'
import { AnnotateEditorSurface, WidthKnob, seedAnnotateStore } from './annotateStoryKit'
import { registerStory } from '../registry'

const EXTENT = 4096

function AnnotateBrushStory() {
  const store = useMemo(() => createAnnotateStore(), [])
  useEffect(() => {
    const fixture = makeAnnotateFixture({ polygons: 8, points: 4, extent: EXTENT })
    seedAnnotateStore(store, fixture)
    store.getState().setActiveClass(fixture.classes[0].id)
    // Pre-select the Brush tool so the surface is ready to freehand.
    store.getState().setTool('brush')
  }, [store])

  return (
    <div
      data-testid="viz-annotate-brush"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, fontSize: 13, opacity: 0.6 }}>
        Brush region — drag a freehand stroke on the canvas; it captures → simplifies → traces a
        closed region and commits it (mask-brush-fix path). Switch tools in the rail.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WidthKnob testId="annotate-brush">
          <AnnotateProvider store={store}>
            {/* BLIND-AUDIT M16 — WRAP at narrow widths. The controls' class panel carries `min-w-40`
                (160px) and the rail another 36px, so a rigid row forced 456px of content into a
                390px viewport and the PAGE scrolled sideways. `flexWrap` + `minWidth: 0` lets the
                aside drop below the canvas on a phone instead. DRIFT-3.4 claimed all six stories
                measured 0 overflow; these two never did. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', flex: 1, minWidth: 0, minHeight: 0 }}>
              <AnnotateControls data-testid="annotate-brush-controls" />
              <AnnotateEditorSurface extent={EXTENT} data-testid="annotate-brush-surface" />
            </div>
          </AnnotateProvider>
        </WidthKnob>
      </div>
    </div>
  )
}

registerStory({
  id: 'annotate-brush',
  category: 'Overlays',
  title: 'Annotate — freehand / brush region tool (capture → simplify → trace → commit)',
  covers: 'annotate-brush',
  Component: AnnotateBrushStory,
})
