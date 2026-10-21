// a11y.story.tsx — accessibility + keyboard-control showcase (ITEM-60). A GPU scatter made
// keyboard-focusable (`tabIndex=0`): arrows pan, +/- zoom, Enter/Space select a demo
// subset, Esc clears — and every change is spoken through an off-screen ARIA live region
// (a canvas is opaque to screen readers, so state changes must be announced). The last
// announcement is mirrored to `window.__VIZ_TEST__.lastAnnouncement` for e2e.

import { useEffect, useMemo, useRef, useState } from 'react'
import { DeckScatterCanvas } from '../../viz-core/DeckScatterCanvas'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import {
  A11yLiveRegion,
  type A11yLiveRegionHandle,
} from '../../viz-core/a11y/A11yLiveRegion'
import { useCanvasKeyboard } from '../../viz-core/a11y/keyboardControls'
import {
  announceSelection,
  announceViewChange,
  announceEmpty,
} from '../../viz-core/a11y/liveRegion'
import { registerStory } from '../registry'

const POINT_COUNT = 200_000
// A fixed demo subset "selected" on activate — just enough to show the count formatting.
const DEMO_SELECTION = 5021
const PAN_WORLD_STEP = 0.1 // arrow pan distance in world units per keypress

function A11yKeyboardStory() {
  const source = useMemo(
    () => new FixtureSource({ seed: 42, pointCount: POINT_COUNT }),
    [],
  )
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)

  // Local view state the keyboard drives. The canvas is uncontrolled (reads
  // `initialViewState` at mount), so we remount it via `viewKey` when a key changes the
  // view — a demo-scale approach that keeps DeckScatterCanvas untouched.
  const [zoom, setZoom] = useState(4)
  const [target, setTarget] = useState<[number, number]>([0, 0])
  const [viewKey, setViewKey] = useState(0)
  const [selectedCount, setSelectedCount] = useState(0)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const liveRef = useRef<A11yLiveRegionHandle | null>(null)

  const say = (msg: string) => liveRef.current?.announce(msg)

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const c = await computeColoring(source, {
        mode: 'categorical',
        key: 'group',
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      setPositions(pos.positions)
      setColors(c.colors)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source])

  useCanvasKeyboard({
    ref: containerRef,
    onPan: ({ dx, dy }) => {
      setTarget(([tx, ty]) => [tx + dx * PAN_WORLD_STEP, ty + dy * PAN_WORLD_STEP])
      setViewKey(k => k + 1)
    },
    onZoom: ({ dir }) => {
      setZoom(z => (dir === 'in' ? z + 1 : z - 1))
      setViewKey(k => k + 1)
      say(announceViewChange(dir === 'in' ? 1 : -1))
    },
    onActivate: () => {
      setSelectedCount(DEMO_SELECTION)
      say(announceSelection(DEMO_SELECTION, POINT_COUNT))
    },
    onClearSelection: () => {
      setSelectedCount(0)
      say(announceEmpty())
    },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, fontSize: 13, opacity: 0.8 }}>
        <b>Keyboard controls</b> — click the plot to focus, then:
        <span style={{ marginLeft: 6 }}>
          <kbd>←↑→↓</kbd> pan · <kbd>Shift</kbd>+arrow larger step · <kbd>+</kbd>/<kbd>−</kbd>{' '}
          zoom · <kbd>Enter</kbd>/<kbd>Space</kbd> select · <kbd>Esc</kbd> clear
        </span>
        <div style={{ marginTop: 4, opacity: 0.7 }}>
          {POINT_COUNT.toLocaleString()} points · {selectedCount.toLocaleString()} selected ·
          zoom {zoom}
        </div>
      </div>
      <div
        ref={containerRef}
        data-testid="viz-a11y"
        tabIndex={0}
        aria-label="Scatter plot — use arrow keys to pan, plus and minus to zoom, Enter to select, Escape to clear"
        role="application"
        style={{ flex: 1, minHeight: 0, outline: 'none', position: 'relative' }}
      >
        {positions && colors ? (
          <DeckScatterCanvas
            key={viewKey}
            positions={positions}
            colors={colors}
            colorEpoch={colorEpoch}
            initialViewState={{ target: [target[0], target[1], 0], zoom }}
          />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
        <A11yLiveRegion
          ref={liveRef}
          onAnnounce={msg => {
            const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
            w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), lastAnnouncement: msg }
          }}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'a11y-keyboard',
  category: 'Controls',
  title: 'Accessibility — keyboard pan/zoom/select + ARIA live announcements',
  covers: 'a11y',
  Component: A11yKeyboardStory,
})
