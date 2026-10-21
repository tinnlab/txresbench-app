// timeline.story.tsx — a GPU scatter + a TimelineControl scrubbing the `pseudo`
// (pseudo-order) dimension. Dragging or playing the timeline slides a window over that
// ordered dimension; the visible points are filtered to the current frame's window
// ENTIRELY ON THE GPU (DataFilterExtension + a per-frame `filterRange` uniform over a
// STATIC per-point value attribute) — no CPU per-point loop on scrub.

import { useEffect, useMemo, useState } from 'react'
import { FilteredScatter, sharedViewFromPositions } from '../../viz-core/timeline/FacetGrid'
import { TimelineControl } from '../../viz-core/timeline/TimelineControl'
import {
  createTimeline,
  frameToRange,
  type TimelineModel,
} from '../../viz-core/timeline/timeline'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import { DARK_THEME } from '../../viz-core/theme'
import type { OrthographicViewState } from '@deck.gl/core'
import { registerStory } from '../registry'

const FRAME_COUNT = 24
const WINDOW = 0.15 // window width as a fraction of the pseudo span

function TimelineStory() {
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 200_000 }), [])
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [pseudo, setPseudo] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [view, setView] = useState<OrthographicViewState | null>(null)
  const [model, setModel] = useState<TimelineModel | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const col = await source.continuous('pseudo')
      const { colors: c } = await computeColoring(source, {
        mode: 'categorical',
        key: 'group',
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      // min/max reduction over the ORDERED dimension (once, at load — not per scrub).
      let lo = Infinity
      let hi = -Infinity
      const v = col.value
      for (let i = 0; i < v.length; i++) {
        if (v[i] < lo) lo = v[i]
        if (v[i] > hi) hi = v[i]
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
        lo = 0
        hi = 1
      }
      setPositions(pos.positions)
      setPseudo(v)
      setColors(c)
      setColorEpoch(e => e + 1)
      setView(sharedViewFromPositions(pos.positions, 520))
      setModel(createTimeline(lo, hi, FRAME_COUNT, { speed: 8 }))
    })()
    return () => {
      alive = false
    }
  }, [source])

  // expose the current frame to the Playwright test-hook inspector (DEC-36).
  useEffect(() => {
    if (!model) return
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), timelineFrame: Math.round(model.frame) }
  }, [model])

  // The ONLY per-scrub computation: frame → [lo,hi] filterRange (O(1), pure).
  const filterRange = useMemo<[number, number]>(
    () =>
      model
        ? frameToRange(model.frame, {
            min: model.min,
            max: model.max,
            frameCount: model.frameCount,
            window: WINDOW,
          })
        : [0, 1],
    [model],
  )

  const ready = positions && pseudo && colors && model && view

  return (
    <div data-testid="viz-timeline" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, opacity: 0.7, fontSize: 13 }}>
        Drag or <b>play</b> the timeline to scrub the <b>pseudo-order</b> dimension — the
        visible points are filtered to the current frame&apos;s window <i>on the GPU</i>{' '}
        (DataFilterExtension, no CPU loop).{' '}
        {model ? `window [${filterRange[0].toFixed(2)}, ${filterRange[1].toFixed(2)}]` : 'loading…'}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {ready ? (
          <FilteredScatter
            positions={positions}
            filterValue={pseudo}
            filterRange={filterRange}
            colors={colors}
            colorEpoch={colorEpoch}
            radius={2}
            initialViewState={view}
            data-testid="viz-timeline-canvas"
          />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
      {ready && (
        <TimelineControl
          model={model}
          onChange={setModel}
          window={WINDOW}
          theme={DARK_THEME}
          data-testid="viz-timeline-control"
        />
      )}
    </div>
  )
}

registerStory({
  id: 'timeline-scrub',
  category: 'Controls',
  title: 'Timeline — scrub an ordered dimension (GPU frame filter)',
  covers: 'timeline',
  Component: TimelineStory,
})
