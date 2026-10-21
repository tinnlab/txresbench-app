// a11yCategorical.story.tsx — proves the BUILT-IN keyboard accessibility of `CategoricalPointsView`
// (deferred item #4). Passing `accessibleLabel` makes the categorical point cloud keyboard-focusable
// (tabIndex=0 / role=application / aria-label) with arrow-pan / +-zoom / Enter-summary / Esc keyboard
// camera control + spoken ARIA-live announcements — while the category-toggle legend keeps its own
// keys (a focused checkbox's Space still toggles it, via `guardTarget`). The last announcement mirrors
// to `window.__VIZ_TEST__.lastAnnouncement` for the e2e.

import { useMemo, useState } from 'react'
import { CategoricalPointsView } from '../../viz-core/spatial/CategoricalPointsView'
import { makeCategoricalPointsFixture } from '../../viz-core/spatial/categoricalPointsFixture'
import { registerStory } from '../registry'

const POINT_COUNT = 40_000
const CATEGORY_COUNT = 6

function A11yCategoricalStory() {
  const fixture = useMemo(
    () => makeCategoricalPointsFixture({ count: POINT_COUNT, categoryCount: CATEGORY_COUNT, seed: 7 }),
    [],
  )
  const [visible, setVisible] = useState<Set<number>>(
    () => new Set(Array.from({ length: fixture.categoryCount }, (_, i) => i)),
  )
  const [last, setLast] = useState('')

  const announce = (m: string) => {
    setLast(m)
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), lastAnnouncement: m }
  }

  const toggle = (code: number, on: boolean) =>
    setVisible(prev => {
      const next = new Set(prev)
      if (on) next.add(code)
      else next.delete(code)
      return next
    })

  return (
    <div
      data-testid="viz-a11y-categorical"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, fontSize: 13, opacity: 0.8 }}>
        <b>Built-in categorical-points a11y</b> — Tab to the plot, then <kbd>←↑→↓</kbd> pan ·{' '}
        <kbd>+</kbd>/<kbd>−</kbd> zoom · <kbd>Enter</kbd> summary · <kbd>Esc</kbd> clear. The legend
        checkboxes keep their own keys.
        <span data-testid="viz-a11y-last" style={{ marginLeft: 8, opacity: 0.7 }}>
          {last}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <CategoricalPointsView
          positions={fixture.positions}
          categoryCodes={fixture.categoryCodes}
          categoryCount={fixture.categoryCount}
          categoryNames={fixture.categoryNames}
          visibleCategories={visible}
          onToggleCategory={toggle}
          initialViewState={{ target: [0, 0, 0], zoom: 2 } as never}
          accessibleLabel="Categorical point cloud. Use arrow keys to pan, plus and minus to zoom, Enter for the category summary, Escape to clear."
          onA11yAnnounce={announce}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'a11y-categorical',
  category: 'View kinds',
  title: 'Accessibility — built-in categorical-points keyboard + live region',
  covers: 'a11y-categorical',
  Component: A11yCategoricalStory,
})
