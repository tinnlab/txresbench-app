// annotate-draw.story.tsx (ITEM-15, P1) — the editable vector overlay (ITEM-3): draw / select /
// select (with vertex handles) polygons + points over an image cell. Composes the STANDALONE editor
// (`AnnotateEditorSurface`) + the `AnnotateControls` tool rail against a per-cell
// `createAnnotateStore()`, mirroring how `spatial-image.story` renders its view directly (no
// GridWorkspace). States: empty / few-features / many-features (viewport-culled). Pick a tool in
// the rail and draw on the canvas; Undo/Redo live in the rail. Authored at desktop + 390px.

import { useEffect, useMemo, useState } from 'react'
import { AnnotateProvider } from '../../viz-core/annotate/AnnotateContext'
import { AnnotateControls } from '../../viz-core/annotate/AnnotateControls'
import { createAnnotateStore } from '../../viz-core/annotate/Annotate.store'
import { makeAnnotateFixture, ANNOTATE_FIXTURE_CLASSES } from '../../viz-core/annotate/annotateFixture'
import { AnnotateEditorSurface, WidthKnob, seedAnnotateStore } from './annotateStoryKit'
import { registerStory } from '../registry'

type Mode = 'empty' | 'few' | 'many'
const EXTENT = 4096

function AnnotateDrawStory() {
  const [mode, setMode] = useState<Mode>('few')

  // A fresh per-cell store per state (remounting the subtree by key re-seeds cleanly).
  const store = useMemo(() => createAnnotateStore(), [mode])
  useEffect(() => {
    if (mode === 'empty') {
      // Idempotent under StrictMode's double-invoked effect (see `seedAnnotateStore`): only add the
      // classes when the store is fresh, else the second invocation duplicates the stable ids.
      if (store.getState().classes.length === 0) {
        for (const cls of ANNOTATE_FIXTURE_CLASSES)
          store.getState().addClass({ id: cls.id, name: cls.name, color: cls.color })
      }
      store.getState().setActiveClass(ANNOTATE_FIXTURE_CLASSES[0].id)
      return
    }
    const fixture =
      mode === 'many'
        ? makeAnnotateFixture({ polygons: 240, points: 160, extent: EXTENT })
        : makeAnnotateFixture({ polygons: 12, points: 8, extent: EXTENT })
    seedAnnotateStore(store, fixture)
    store.getState().setActiveClass(fixture.classes[0].id)
  }, [store, mode])

  return (
    <div
      data-testid="viz-annotate-draw"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        {(['empty', 'few', 'many'] as Mode[]).map(m => (
          <button
            key={m}
            type="button"
            data-testid={`annotate-draw-mode-${m}`}
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            style={{ fontWeight: mode === m ? 700 : 400 }}
          >
            {m === 'empty' ? 'Empty' : m === 'few' ? 'Few features' : 'Many (culled)'}
          </button>
        ))}
        <span style={{ opacity: 0.55 }}>
          Pick a tool in the rail (Polygon / Point / Select / Reshape) and draw on the canvas.
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WidthKnob testId="annotate-draw">
          <AnnotateProvider key={mode} store={store}>
            {/* BLIND-AUDIT M16 — WRAP at narrow widths. The controls' class panel carries `min-w-40`
                (160px) and the rail another 36px, so a rigid row forced 456px of content into a
                390px viewport and the PAGE scrolled sideways. `flexWrap` + `minWidth: 0` lets the
                aside drop below the canvas on a phone instead. DRIFT-3.4 claimed all six stories
                measured 0 overflow; these two never did. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', flex: 1, minWidth: 0, minHeight: 0 }}>
              <AnnotateControls data-testid="annotate-draw-controls" />
              <AnnotateEditorSurface extent={EXTENT} cull={mode === 'many'} data-testid="annotate-draw-surface" />
            </div>
          </AnnotateProvider>
        </WidthKnob>
      </div>
    </div>
  )
}

registerStory({
  id: 'annotate-draw',
  category: 'Overlays',
  title: 'Annotate — editable vector overlay (draw / select · empty / few / culled)',
  covers: 'annotate-draw',
  Component: AnnotateDrawStory,
})
