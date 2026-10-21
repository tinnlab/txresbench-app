// mask-review.story.tsx (ITEM-15, P3) — the label-mask REVIEW controls (ITEM-11). Wires
// `MaskReviewControls` (hide / solo a class · picked-cell readout) straight into `LabelMaskView`'s
// `hiddenCategories` / `soloCategory` / hover→id / click→selectedId props over the seeded
// `makeLabelMaskFixture`. Hide/solo is an O(numLabels) LUT rebuild (never a pixel re-upload); hover
// is a free GPU pick. States: all-visible / one-class-solo / hovering-a-cell / cell-selected.
// Presentational (viz-core). Authored at desktop + 390px.

import { useMemo, useState } from 'react'
import { LabelMaskView } from '../../viz-core/spatial/LabelMaskView'
import { makeLabelMaskFixture } from '../../viz-core/spatial/labelMaskFixture'
import { MaskReviewControls, type MaskCategory, type MaskTool } from '../../viz-core/annotate/MaskReviewControls'
import { WidthKnob } from './annotateStoryKit'
import { registerStory } from '../registry'

/** A stable-ish rgb swatch per category code (matches the LabelMaskView default palette closely
 *  enough for the review list — the exact colors come from the shared categorical palette). */
function categoryColor(code: number): [number, number, number] {
  const hue = (code * 47) % 360
  const h = hue / 60
  const x = 1 - Math.abs((h % 2) - 1)
  const [r, g, b] =
    h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x]
  return [Math.round(r * 200 + 40), Math.round(g * 200 + 40), Math.round(b * 200 + 40)]
}

function MaskReviewStory() {
  const fixture = useMemo(() => makeLabelMaskFixture({ seed: 7 }), [])
  const categories = useMemo<MaskCategory[]>(
    () =>
      Array.from({ length: fixture.categoryCount }, (_, code) => ({
        code,
        label: `Class ${code}`,
        color: categoryColor(code),
      })),
    [fixture.categoryCount],
  )

  const [hidden, setHidden] = useState<Set<number>>(() => new Set())
  const [solo, setSolo] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [activeTool, setActiveTool] = useState<MaskTool | null>(null)

  const selectedCategory =
    selectedId != null && selectedId > 0 && selectedId < fixture.categoryForId.length
      ? fixture.categoryForId[selectedId]
      : null

  const toggleHidden = (code: number) =>
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })

  return (
    <div
      data-testid="viz-mask-review"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, fontSize: 13, opacity: 0.6 }}>
        Review a segmentation mask — hide / solo a class (LUT-only, no re-upload); hover or click a
        cell for its id + class.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WidthKnob testId="mask-review">
          <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
            <div style={{ flex: '0 0 auto', borderRight: '1px solid rgba(128,128,128,0.25)', overflow: 'auto' }}>
              <MaskReviewControls
                categories={categories}
                hiddenCategories={hidden}
                soloCategory={solo}
                onToggleHidden={toggleHidden}
                onSolo={setSolo}
                activeTool={activeTool}
                onSelectTool={setActiveTool}
                selectedId={selectedId}
                selectedCategory={selectedCategory}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
              <LabelMaskView
                labelMask={fixture.labelMask}
                width={fixture.width}
                height={fixture.height}
                categoryForId={fixture.categoryForId}
                hiddenCategories={hidden}
                soloCategory={solo}
                onSelectId={setSelectedId}
              />
            </div>
          </div>
        </WidthKnob>
      </div>
    </div>
  )
}

registerStory({
  id: 'mask-review',
  category: 'Overlays',
  title: 'Mask review — hide / solo classes · hover → cell id + class',
  covers: 'mask-review',
  Component: MaskReviewStory,
})
