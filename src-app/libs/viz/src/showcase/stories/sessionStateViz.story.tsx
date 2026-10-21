// sessionStateViz.story.tsx — PROVES the FULL <Viz> SAVE/RESTORE PRODUCTION GLUE via the
// consolidated `option`/`onChange` API (ITEM-5): the `<Viz option onChange>` props + the
// restore-after-`setOption(replace)` path, end-to-end, on a REAL `<Viz>` mount — NOT a hand-wired
// store round-trip (that is the sibling `sessionState.story`, which drives the stores + the pure
// getOption/setOption helpers directly). Here nothing touches the stores by hand: a mutation flows
// through the CONTROLLER, `onChange` (debounced) captures a `VizOption` (via `getOption()`), and a
// REMOUNT of `<Viz>` with `option={savedOption}` restores it — because a captured option carrying
// LIVE state (selection + overrides) is applied `{ replace: true }` after the fresh mount resolves.
//
// The flow the e2e drives:
//   1. mutate    — `controller.select([1..5])` + a per-group color OVERRIDE.
//   2. onChange fires (~150ms debounce) → `liveOptionRef` holds the captured `VizOption`.
//   3. reload    — pass that option as `<Viz option={saved}>` + bump `mountKey` to REMOUNT `<Viz>`
//                  (models the app re-fetching the data by id and re-mounting the façade).
//   4. the remount's restore-on-mount runs `setOption(saved, { replace: true })` (the option carries
//      live state → `optionCarriesLiveState`), re-hydrating the selection (→ 5) + the override
//      (→ #ff0000) from the saved option.
//
// The SAME memoised `source` object is reused across the remount — restore is data-INDEPENDENT
// (ids + config only, never buffers), so reusing the owned source faithfully models the re-fetch.
//
// window.__VIZ_TEST__ exposes the live selection length, the override color, whether an option
// was captured, and the mount key, so the headless harness can assert the round-trip without
// pixels. Domain-neutral, no SVG.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Viz } from '../../react/Viz'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { VizController } from '../../adapter/VizController'
import type { VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

/** The id of the primary cell the initial layout mounts (the option's grid-entry id). */
const MAIN_ID = 'g-main'

/** The color-by COLUMN + category NAME the override targets (stable identity, not by index). */
const COLUMN = 'group'
const CATEGORY = 'A'
const OVERRIDE_COLOR = '#ff0000'

/** The deterministic selection the controller publishes (canonical point ids). */
const SEL_IDS = [1, 2, 3, 4, 5]

/** The INITIAL layout — a single scatter cell, exactly like `dataOwnership.story` (the app hands
 *  `<Viz>` ONLY `source` + this tiny declarative plan). A layout-only option (no live state) ⇒ the
 *  default merge/build path. */
const INITIAL_LAYOUT: VizOption = {
  dataset: { id: 'demo' },
  grid: [{ id: MAIN_ID, region: { col: 0 } }],
  series: [{ id: 's-scatter', type: 'scatter', coordId: MAIN_ID, encode: { layout: 'primary' } }],
}

function SessionStateVizStory() {
  // The app holds the SMALL source + the controller handle. `<Viz>` OWNS the buffers.
  const source = useMemo(() => new FixtureSource({ seed: 7, pointCount: 60_000 }), [])
  const [controller, setController] = useState<VizController | null>(null)

  // The last `VizOption` captured by the DEBOUNCED `onChange` (a ref — it need not re-render;
  // `optionTick` below forces the reactive read used by the test hook).
  const liveOptionRef = useRef<VizOption | null>(null)
  const [optionTick, setOptionTick] = useState(0)

  // The option passed to the REMOUNTED `<Viz>` (null ⇒ mount the plain INITIAL_LAYOUT, no restore).
  const [restoreOption, setRestoreOption] = useState<VizOption | null>(null)
  // Bumping this remounts `<Viz>` (fresh controller + fresh restore latch).
  const [mountKey, setMountKey] = useState(0)

  // Reactive reads (proof the RESTORE re-populated the viz-owned stores after the remount). VIZ_
  // ISOLATION W3: `<Viz>` owns a PER-INSTANCE set, so we observe the controller's OWN coordination +
  // colorOverride stores (not the module singletons). Re-subscribes on remount (a fresh controller).
  const [selectionLength, setSelectionLength] = useState(0)
  const [overrideColor, setOverrideColor] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!controller) return
    const { coordination, colorOverride } = controller.getStores()
    const read = () => {
      setSelectionLength(coordination.getState().pointSelection?.length ?? 0)
      setOverrideColor(colorOverride.getState().overrides[COLUMN]?.categoryColors?.[CATEGORY])
    }
    read()
    const offs = [coordination.subscribe(read), colorOverride.subscribe(read)]
    return () => {
      for (const off of offs) off()
    }
  }, [controller])

  // e2e observation hook — keyed on the reactive reads (+ `optionTick`, bumped when the debounced
  // `onChange` lands, so `glueOptionCaptured` reflects the ref reactively).
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      glueSelLen: selectionLength,
      glueOverride: overrideColor ?? null,
      glueOptionCaptured: liveOptionRef.current != null,
      // The CAPTURED option's selection length — the test waits for THIS to reach 5 (the debounced
      // onChange also fires a NO-selection option on the initial setOption, so "an option exists" is
      // not enough; the reload must use the option that actually holds the mutated selection).
      glueOptionSelLen: liveOptionRef.current?.selection?.ids?.length ?? 0,
      glueMountKey: mountKey,
    }
  }, [selectionLength, overrideColor, optionTick, mountKey])

  // MUTATE: everything flows through the controller / the store's public action — nothing here
  // hand-writes an option. `onChange` (debounced) captures the resulting `VizOption`.
  const mutate = () => {
    controller?.select(Uint32Array.from(SEL_IDS))
    // Set the override on the viz's OWN colorOverride store (via the controller) so it is captured
    // by `onChange` and round-trips through restore (VIZ_ISOLATION W3).
    controller?.getStores().colorOverride.getState().setCategoryColor(COLUMN, CATEGORY, OVERRIDE_COLOR)
  }

  // RELOAD: hand the captured option to a FRESH `<Viz>` mount as `option`, then remount. Reusing the
  // same `source` object models the app re-fetching the data by id (restore is data-independent). The
  // remount's restore-on-mount runs `setOption(saved, { replace: true })` — bringing the selection +
  // override back from the saved option.
  const reload = () => {
    setRestoreOption(liveOptionRef.current)
    setMountKey(k => k + 1)
  }

  return (
    <div
      data-testid="viz-session-state-glue"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" data-testid="viz-glue-mutate" onClick={mutate}>
          mutate (select + override)
        </button>
        <button type="button" data-testid="viz-glue-reload" onClick={reload}>
          reload via option
        </button>
        <span style={{ opacity: 0.6 }}>
          sel={selectionLength} · override={overrideColor ?? '—'} · mount#{mountKey} · option=
          {String(liveOptionRef.current != null)}
        </span>
      </div>
      <div style={{ padding: '0 8px 8px', fontSize: 12, opacity: 0.6 }}>
        The app mutates through the <code>controller</code>; <code>&lt;Viz onChange&gt;</code>{' '}
        (debounced) captures a <code>VizOption</code>. Clicking <em>reload</em> remounts{' '}
        <code>&lt;Viz option={'{saved}'}&gt;</code> with a fresh source — the selection + color
        override return via the restore-after-<code>setOption(replace)</code> path.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Viz
          key={mountKey}
          source={source}
          option={restoreOption ?? INITIAL_LAYOUT}
          onController={setController}
          onChange={o => {
            liveOptionRef.current = o
            setOptionTick(t => t + 1)
          }}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'session-state-viz-glue',
  category: 'Export',
  title: 'Session state — <Viz option/onChange> production glue',
  covers: 'session-state',
  Component: SessionStateVizStory,
})
