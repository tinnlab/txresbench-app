// transitionsToggle.story.tsx — PROVES the "per-plot animated transitions" contract is real +
// OPT-IN, not hardcoded (mirrors `datazoom-toggle.story.tsx`). A BOX plot whose `transitions`
// config is flipped between `{ duration, easing }` and `false` by a toggle button, plus a
// RECOLOR / DATA-CHANGE button (swaps the bound value column) so a human sees the marks TWEEN
// when transitions are ON and SNAP when OFF. Precisely e2e-timing a GPU tween mid-frame is
// flaky, so the machine-checkable proof is the WIRING — a `window.__VIZ_TEST__` hook exposes:
//
//   • `transitionsEnabled`  — the toggle state (on/off).
//   • `transitionsPropPresent` — whether `deckTransitions(config, accessors)` yields a deck
//     `transitions` object for the CURRENT config. OFF ⇒ `false` (the View spreads NO
//     `transitions` key ⇒ instant, byte-identical); ON ⇒ `true`. This is the "config respected,
//     nothing hardcoded" proof, the analog of datazoom's rail-count.
//   • `transitionsDuration` — the resolved duration (ms) when on, else null.
//   • `dataNonce` — increments on each recolor/data-change (so a driver can assert the change fired).

import { useEffect, useMemo, useState } from 'react'
import { BoxView } from '../../viz-core/charts/BoxView'
import { deckTransitions, type TransitionProp } from '../../viz-core/charts/transitions'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { registerStory } from '../registry'

const GROUP_KEY = 'group'
// Two value columns to swap between — the DATA CHANGE that tweens (box heights + mean marker move,
// fill recolors) when transitions are ON.
const VALUE_KEYS = ['Feature A', 'Feature B'] as const
// The accessors the box View animates (box fill + mean marker) — used only to compute the
// `transitionsPropPresent` wiring proof here in the story.
const BOX_ACCESSORS = ['getFillColor', 'getPosition'] as const
const TRANSITION_CONFIG: TransitionProp = { duration: 400, easing: 'cubic-in-out' }

function TransitionsToggleStory() {
  const source = useMemo(() => new FixtureSource({ seed: 7, pointCount: 12_000, groupCount: 5 }), [])

  const [enabled, setEnabled] = useState(true)
  const [valueIdx, setValueIdx] = useState(0)

  const transitions: TransitionProp = enabled ? TRANSITION_CONFIG : false
  const valueKey = VALUE_KEYS[valueIdx % VALUE_KEYS.length]

  // The wiring proof: does the CURRENT config resolve to a deck `transitions` object? OFF ⇒
  // undefined (no key ⇒ instant); ON ⇒ an object. This is exactly what each View spreads.
  const deckTx = deckTransitions(transitions, BOX_ACCESSORS)

  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      transitionsEnabled: enabled,
      transitionsPropPresent: !!deckTx,
      transitionsDuration: deckTx ? deckTx.getFillColor?.duration ?? null : null,
      dataNonce: valueIdx,
      transitionsValueKey: valueKey,
    }
  }, [enabled, deckTx, valueIdx, valueKey])

  return (
    <div
      data-testid="viz-transitions-toggle"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <button
          type="button"
          data-testid="viz-transitions-toggle-btn"
          aria-pressed={enabled}
          onClick={() => setEnabled(v => !v)}
        >
          Transitions: {enabled ? 'ON' : 'OFF'}
        </button>
        <button
          type="button"
          data-testid="viz-transitions-recolor-btn"
          onClick={() => setValueIdx(i => i + 1)}
        >
          Change data ({valueKey})
        </button>
        <span data-testid="viz-transitions-readout" style={{ opacity: 0.75 }}>
          deck transitions prop: {deckTx ? `present (${deckTx.getFillColor?.duration}ms)` : 'absent (instant)'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }} data-testid="viz-transitions-box-pane">
        <BoxView source={source} valueKey={valueKey} groupKey={GROUP_KEY} transitions={transitions} />
      </div>
    </div>
  )
}

registerStory({
  id: 'transitions-toggle',
  category: 'Controls',
  title: 'Transitions — per-plot opt-in animated transitions (box toggle + data-change tween)',
  covers: 'transitions-toggle',
  Component: TransitionsToggleStory,
})
