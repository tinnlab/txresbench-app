// mask-correct.story.tsx (ITEM-15, P3) — the label-mask CORRECTION path (ITEM-12) driven through
// the real `createMaskCorrectController`: each op mutates the editable CPU raster (widened to
// `Uint32Array`, DEC-D) + the id→category LUT in place, reports a tight dirty rect, and is a single
// undoable atom. A headless gallery can't draw, so deterministic buttons apply a canned brush /
// relabel / merge / split against the seeded fixture (targets computed from blob centroids); Undo/Redo
// wire to the controller. Presentational. Authored at desktop + 390px.

import { useMemo, useState } from 'react'
import { LabelMaskView } from '../../viz-core/spatial/LabelMaskView'
import { makeLabelMaskFixture } from '../../viz-core/spatial/labelMaskFixture'
import { createMaskCorrectController } from '../../viz-core/annotate/maskCorrectController'
import { WidthKnob } from './annotateStoryKit'
import { registerStory } from '../registry'

function MaskCorrectStory() {
  const [resetKey, setResetKey] = useState(0)

  // Editable state: a Uint32Array raster (LabelRaster) + a Uint16Array id→category LUT, both
  // COPIES of the fixture so ops don't mutate the shared fixture. Re-created on reset.
  const edit = useMemo(() => {
    const fx = makeLabelMaskFixture({ seed: 7 })
    return {
      fx,
      mask: Uint32Array.from(fx.labelMask),
      cats: Uint16Array.from(fx.categoryForId),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // A render snapshot (fresh array refs) the view re-reads after each in-place edit.
  const [snap, setSnap] = useState(() => ({ mask: edit.mask.slice(), cats: edit.cats.slice(), v: 0 }))

  const controller = useMemo(
    () =>
      createMaskCorrectController({
        mask: edit.mask,
        width: edit.fx.width,
        height: edit.fx.height,
        categoryForId: edit.cats,
        // any op → snapshot fresh refs so the LabelMaskView re-uploads (showcase; the live layer
        // uses the dirty-rect sub-upload — here we just re-read to keep the story dependency-free).
        onPixels: () => setSnap(s => ({ mask: edit.mask.slice(), cats: Uint16Array.from(edit.cats), v: s.v + 1 })),
        onCategories: () => setSnap(s => ({ mask: edit.mask.slice(), cats: Uint16Array.from(edit.cats), v: s.v + 1 })),
      }),
    [edit],
  )

  // Blob centroids for canned targets (deterministic; a headless gallery can't draw).
  const targets = useMemo(() => {
    const { width, height, labelMask, labelCount, categoryForId, categoryCount } = edit.fx
    const sx = new Float64Array(labelCount + 1)
    const sy = new Float64Array(labelCount + 1)
    const n = new Uint32Array(labelCount + 1)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = labelMask[y * width + x]
        if (id > 0) {
          sx[id] += x
          sy[id] += y
          n[id]++
        }
      }
    }
    const centroid = (id: number): [number, number] => (n[id] > 0 ? [sx[id] / n[id], sy[id] / n[id]] : [width / 2, height / 2])
    return { c1: centroid(1), c2: centroid(2), cat1: categoryForId[1], categoryCount }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit])

  const doBrush = () => controller.brush({ x: targets.c1[0], y: targets.c1[1], r: 14, id: 2 })
  const doRelabel = () => controller.relabel(1, (targets.cat1 + 1) % Math.max(1, targets.categoryCount))
  const doMerge = () => controller.merge(2, 1)
  const doSplit = () =>
    controller.split({
      cellId: 1,
      cutLine: { x0: targets.c1[0], y0: targets.c1[1] - 40, x1: targets.c1[0], y1: targets.c1[1] + 40 },
    })

  const btn = (testId: string, label: string, onClick: () => void, disabled = false) => (
    <button type="button" data-testid={testId} onClick={onClick} disabled={disabled}>
      {label}
    </button>
  )

  return (
    <div
      data-testid="viz-mask-correct"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        {btn('mask-correct-brush', 'Brush', doBrush)}
        {btn('mask-correct-relabel', 'Relabel', doRelabel)}
        {btn('mask-correct-merge', 'Merge 2→1', doMerge)}
        {btn('mask-correct-split', 'Split 1', doSplit)}
        <span style={{ width: 1, height: 16, background: 'rgba(128,128,128,0.4)' }} />
        {btn('mask-correct-undo', 'Undo', () => controller.undo(), !controller.canUndo)}
        {btn('mask-correct-redo', 'Redo', () => controller.redo(), !controller.canRedo)}
        {btn('mask-correct-reset', 'Reset', () => setResetKey(k => k + 1))}
        <span data-testid="mask-correct-depth" style={{ opacity: 0.6 }}>
          history: {controller.historyDepth} (v{snap.v})
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WidthKnob testId="mask-correct">
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
            <LabelMaskView
              labelMask={snap.mask}
              width={edit.fx.width}
              height={edit.fx.height}
              categoryForId={snap.cats}
            />
          </div>
        </WidthKnob>
      </div>
    </div>
  )
}

registerStory({
  id: 'mask-correct',
  category: 'Overlays',
  title: 'Mask correct — brush / relabel / merge / split + undo (dirty-rect, single-atom)',
  covers: 'mask-correct',
  Component: MaskCorrectStory,
})
