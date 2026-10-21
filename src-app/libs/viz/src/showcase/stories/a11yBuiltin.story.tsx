// a11yBuiltin.story.tsx — proves the BUILT-IN accessibility of `DeckScatterCanvas` (the production
// wiring the merge audit asked for): passing `accessibleLabel` makes the canvas itself
// keyboard-focusable (tabIndex=0 / role=application / aria-label) with arrow-pan / +-zoom / Enter /
// Esc keyboard camera control and spoken ARIA-live announcements — no manual wrapper in the consumer.
// The last announcement is mirrored to `window.__VIZ_TEST__.lastAnnouncement` for the e2e.

import { useEffect, useMemo, useState } from 'react'
import { DeckScatterCanvas } from '../../viz-core/DeckScatterCanvas'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY } from '../../viz-core/data/engine'
import { registerStory } from '../registry'

const POINT_COUNT = 40_000

function A11yBuiltinStory() {
  const source = useMemo(() => new FixtureSource({ seed: 11, pointCount: POINT_COUNT }), [])
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [last, setLast] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const c = await computeColoring(source, DEFAULT_COLOR_BY)
      if (!alive) return
      setPositions(pos.positions)
      setColors(c.colors)
    })()
    return () => {
      alive = false
    }
  }, [source])

  const announce = (m: string) => {
    setLast(m)
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), lastAnnouncement: m }
  }

  return (
    <div data-testid="viz-a11y-builtin" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, fontSize: 13, opacity: 0.8 }}>
        <b>Built-in canvas a11y</b> — Tab to the plot, then <kbd>←↑→↓</kbd> pan · <kbd>+</kbd>/<kbd>−</kbd>{' '}
        zoom · <kbd>Enter</kbd> select · <kbd>Esc</kbd> clear.
        <span data-testid="viz-a11y-last" style={{ marginLeft: 8, opacity: 0.7 }}>
          {last}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {positions && colors && (
          <DeckScatterCanvas
            positions={positions}
            colors={colors}
            accessibleLabel="Scatter plot. Use arrow keys to pan, plus and minus to zoom, Enter to select, Escape to clear."
            onA11yAnnounce={announce}
          />
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'a11y-builtin',
  category: 'View kinds',
  title: 'Accessibility — built-in canvas keyboard + live region',
  covers: 'a11y',
  Component: A11yBuiltinStory,
})
