// spatial-transcripts.story.tsx — the TRANSCRIPT-POINTS view showcase: ~500k individual
// transcript dots across ~30 genes, colored by gene, with per-gene show/hide driven by the
// GPU filter (a uniform toggle) + a legend + a live visible-transcript count.
//
// The count is mirrored onto `window.__VIZ_TEST__.visibleTranscripts` so a harness/e2e can
// assert that toggling a gene changes the visible count WITHOUT any positions/colors
// re-upload (the filter is a uniform update). Follows the async-free fixture pattern (the
// synthetic fixture is pure + synchronous, so no useEffect load is needed).

import { useMemo, useState } from 'react'
import { CategoricalPointsView } from '../../viz-core/spatial/CategoricalPointsView'
import { makeCategoricalPointsFixture } from '../../viz-core/spatial/categoricalPointsFixture'
import { countByCategory, topCategoriesByCount, visibleCount } from '../../viz-core/spatial/categoryFilter'
import { registerStory } from '../registry'

function SpatialTranscriptsStory() {
  const fixture = useMemo(
    () => makeCategoricalPointsFixture({ count: 500_000, categoryCount: 30, seed: 7 }),
    [],
  )
  const counts = useMemo(
    () => countByCategory(fixture.categoryCodes, fixture.categoryCount),
    [fixture],
  )

  // Visible-set state. Start with EVERY gene visible; the legend hides/shows individual
  // genes, and "Top 10" seeds a sensible default view via topCategoriesByCount.
  const [visible, setVisible] = useState<Set<number>>(
    () => new Set(Array.from({ length: fixture.categoryCount }, (_, i) => i)),
  )

  const toggle = (code: number, show: boolean) => {
    setVisible(prev => {
      const next = new Set(prev)
      if (show) next.add(code)
      else next.delete(code)
      return next
    })
  }

  const visibleTranscripts = visibleCount(counts, visible)
  // Mirror the count for the test harness — a per-toggle O(K) readout, not the GPU filter.
  const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
  w.__VIZ_TEST__ = {
    ...(w.__VIZ_TEST__ ?? {}),
    visibleTranscripts,
    totalTranscripts: fixture.count,
    visibleGeneCount: visible.size,
  }

  return (
    <div
      data-testid="viz-spatial-transcripts"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Transcript points</strong>
        <span data-testid="viz-transcript-count" style={{ opacity: 0.75 }}>
          {visibleTranscripts.toLocaleString()} / {fixture.count.toLocaleString()} transcripts ·{' '}
          {visible.size} / {fixture.categoryCount} genes
        </span>
        <button
          type="button"
          onClick={() =>
            setVisible(new Set(Array.from({ length: fixture.categoryCount }, (_, i) => i)))
          }
        >
          Show all
        </button>
        <button
          type="button"
          onClick={() => setVisible(new Set())}
        >
          Hide all
        </button>
        <button
          type="button"
          onClick={() => setVisible(new Set(topCategoriesByCount(fixture.categoryCodes, 10, fixture.categoryCount)))}
        >
          Top 10 genes
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <CategoricalPointsView
          positions={fixture.positions}
          categoryCodes={fixture.categoryCodes}
          categoryCount={fixture.categoryCount}
          categoryNames={fixture.categoryNames}
          visibleCategories={visible}
          onToggleCategory={toggle}
          initialViewState={{ target: [0, 0, 0], zoom: -1 } as never}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'spatial-transcripts',
  category: 'View kinds',
  title: 'Transcript points — per-gene GPU show/hide (10–100M scatter + DataFilterExtension)',
  covers: 'transcripts',
  Component: SpatialTranscriptsStory,
})
