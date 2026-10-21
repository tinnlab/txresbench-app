// annotateStoryKit.tsx — shared story helpers for the annotation-editor showcase (ITEM-15).
// NOT a story itself (registers nothing) — a small toolkit the annotate-* stories reuse, the
// same way `regionSelectFixture.ts` backs the spatial-roi stories:
//
//   • `WidthKnob` — every annotate surface is authored at DESKTOP and 390px (the `gate:ui`
//     requirement); this wrapper toggles the content between full width and a 390px column.
//   • `seedAnnotateStore` — load a seeded `AnnotateFixture` (classes + annotations) into a fresh
//     per-cell store via the SAME `add`/`commitResult` path a hand-drawn feature uses.
//   • `AnnotateEditorSurface` — a STANDALONE editable overlay: one OrthographicView `<DeckGL>`
//     rendering `buildAnnotationLayers` over the per-cell store, wired to `useAnnotateEditor`'s
//     pointer→gesture translation. This is the story-local analog of the composition GridWorkspace
//     owns (which the stories deliberately do NOT depend on), mirroring how `spatial-image.story`
//     renders `RasterImageView` directly.

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import {
  useAnnotate,
  useAnnotateStore,
} from '../../viz-core/annotate/AnnotateContext'
import { useAnnotateEditor } from '../../viz-core/annotate/useAnnotateEditor'
import { buildAnnotationLayers } from '../../viz-core/annotate/buildAnnotationLayers'
import type { AnnotateStore } from '../../viz-core/annotate/Annotate.store'
import type { AnnotateFixture } from '../../viz-core/annotate/annotateFixture'
import type { Vec2 } from '../../viz-core/annotate/annotationGestures'

/** Load a seeded fixture's classes + annotations into a store (idempotent-ish: call once on a
 *  fresh store). Uses the public `addClass` + `commitResult` actions so the seeded state is
 *  indistinguishable from hand-authored + fully undoable. */
export function seedAnnotateStore(store: AnnotateStore, fixture: AnnotateFixture): void {
  const st = store.getState()
  // Idempotent: React StrictMode double-invokes the seeding effect (mount → cleanup → mount) on
  // the SAME committed store, and `addClass` pushes unconditionally — so a naive re-seed would add
  // every class twice (duplicate stable ids → duplicate React keys in the class list). Skip when the
  // store is already seeded so a second invocation is a no-op.
  if (st.classes.length > 0 || st.ids.length > 0) return
  for (const cls of fixture.classes) st.addClass({ id: cls.id, name: cls.name, color: cls.color })
  st.commitResult(
    fixture.annotations.map(a => ({
      id: a.id,
      geometry: a.geometry,
      classId: a.classId,
      label: a.label,
    })),
  )
}

export interface WidthKnobProps {
  readonly testId: string
  readonly children: ReactNode
}

/** Toggle the wrapped content between desktop (stretch) and a 390px mobile column. */
export function WidthKnob({ testId, children }: WidthKnobProps) {
  const [narrow, setNarrow] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: 6, borderBottom: '1px solid rgba(128,128,128,0.25)' }}>
        <button
          type="button"
          data-testid={`${testId}-width`}
          aria-pressed={narrow}
          onClick={() => setNarrow(n => !n)}
        >
          {narrow ? 'Switch to desktop width' : 'Switch to mobile (390px)'}
        </button>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          width: narrow ? 390 : '100%',
          maxWidth: '100%',
          borderRight: narrow ? '1px dashed rgba(128,128,128,0.4)' : undefined,
        }}
      >
        {children}
      </div>
    </div>
  )
}

export interface AnnotateEditorSurfaceProps {
  /** the full-res image extent the annotations live in (INV-4). */
  readonly extent: number
  /** cell id used to namespace the deck layers (default `'story'`). */
  readonly cellId?: string
  /** viewport-cull the static tier against the visible bounds (demonstrates the DEC-B cull). */
  readonly cull?: boolean
  readonly 'data-testid'?: string
}

const ZOOM_MIN = -6
const ZOOM_MAX = 2

/** A standalone editable annotation overlay over a per-cell store — the story-local editor. */
export function AnnotateEditorSurface({
  extent,
  cellId = 'story',
  cull = false,
  'data-testid': testId = 'annotate-editor-surface',
}: AnnotateEditorSurfaceProps) {
  const store = useAnnotateStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const view = useMemo(() => new OrthographicView({ id: 'annot', flipY: true }), [])

  // Track the camera as plain numbers (the deck `zoom` type is a `number | Deprecated2DZoom`
  // union that doesn't arithmetic cleanly); derive the `OrthographicViewState` from them.
  const [zoomLevel, setZoomLevel] = useState(-3)
  const viewState = useMemo<OrthographicViewState>(
    () => ({ target: [extent / 2, extent / 2, 0], zoom: zoomLevel }) as OrthographicViewState,
    [extent, zoomLevel],
  )

  // Reactive store reads — the layers rebuild whenever the collection / draft / selection change.
  const byId = useAnnotate(s => s.byId)
  const ids = useAnnotate(s => s.ids)
  const selection = useAnnotate(s => s.selection)
  const activeTool = useAnnotate(s => s.activeTool)

  const unproject = useCallback(
    (clientX: number, clientY: number): Vec2 | null => {
      const el = containerRef.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      const vp = view.makeViewport({ width: rect.width, height: rect.height, viewState })
      if (!vp) return null
      const w = vp.unproject([clientX - rect.left, clientY - rect.top])
      return [w[0], w[1]]
    },
    [view, viewState],
  )

  const editor = useAnnotateEditor({ store, unproject })

  const viewport = useMemo(() => {
    if (!cull) return null
    // Approximate the visible full-res bounds from the current camera (a generous window).
    const half = extent / Math.pow(2, zoomLevel + 3)
    const cx = extent / 2
    const cy = extent / 2
    return { bounds: [cx - half, cy - half, cx + half, cy + half] as [number, number, number, number] }
  }, [cull, extent, zoomLevel])

  const layers = useMemo(
    () =>
      buildAnnotationLayers({
        collection: { byId, ids },
        editDraft: editor.editDraft,
        selection,
        viewport,
        cellId,
      }),
    [byId, ids, editor.editDraft, selection, viewport, cellId],
  )

  const zoom = (delta: number) =>
    setZoomLevel(z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta)))

  return (
    <div
      data-testid={testId}
      style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, background: 'rgb(24,26,32)' }}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
        <DeckGL views={view} controller={false} viewState={viewState as never} layers={layers as never} />
        {/* gesture overlay — captures pointer for the active tool (deck controller stays off so
            the overlay owns the pointer, exactly like the region-draw overlay in spatial-roi). */}
        <div
          data-testid={`${testId}-overlay`}
          onPointerDown={editor.pointerHandlers.onPointerDown}
          onPointerMove={editor.pointerHandlers.onPointerMove}
          onPointerUp={editor.pointerHandlers.onPointerUp}
          style={{ position: 'absolute', inset: 0, cursor: editor.cursor, touchAction: 'none' }}
        />
      </div>
      {/* camera + finish affordances (a headless gallery can't drag; these keep it navigable). */}
      <div
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          display: 'flex',
          gap: 6,
          background: 'rgba(255,255,255,0.85)',
          borderRadius: 4,
          padding: 4,
          fontSize: 12,
        }}
      >
        <button type="button" data-testid={`${testId}-zoom-out`} aria-label="Zoom out" title="Zoom out" onClick={() => zoom(-0.5)}>
          −
        </button>
        <button type="button" data-testid={`${testId}-zoom-in`} aria-label="Zoom in" title="Zoom in" onClick={() => zoom(0.5)}>
          +
        </button>
        {activeTool === 'polygon' && (
          <button
            type="button"
            data-testid={`${testId}-finish`}
            disabled={editor.polyDraftLength < 3}
            onClick={editor.finishPolygon}
          >
            Finish ({editor.polyDraftLength})
          </button>
        )}
      </div>
    </div>
  )
}
