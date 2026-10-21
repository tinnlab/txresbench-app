// Viz.props.test.ts — the two pure decision helpers `<Viz>` uses to route the consolidated props
// (ITEM-5/12/13). Named `.test.ts` (NOT `.tsx`) so vitest's `src/**/*.test.ts` node pass collects
// it; the React render surface is exercised by the showcase/e2e Playwright layer, not this node pass.
//   - `isStreamingSource` gates the ONE data-input seam: a `StreamingSource` (catalog()+stream())
//     routes to the controller's streaming resolver; a legacy pull `DataSource` keeps the
//     byte-identical `resolveDataset` path.
//   - `optionCarriesLiveState` gates restore-on-mount: an option carrying live interaction state is
//     applied `{ replace: true }`; a layout-only option takes the default merge/build path.

import { describe, it, expect } from 'vitest'
import { isStreamingSource, optionCarriesLiveState, planReloadRestore, nextFocusUrl } from './Viz'
import { fromArray, type StreamingSource, type Channel } from '../viz-core/data/streamingSource'
import { VIZ_WINDOW_OPTION_KEY, FOCUS_PARAM } from '../adapter/windowRestore'
import type { VizOption } from '../viz-core/option/types'

/** A minimal `StreamingSource` (catalog() + stream()) — the ONE data-input seam shape. */
const streamingSource: StreamingSource = {
  async catalog() {
    return { total: 0, layouts: [], columns: [] } as unknown as Awaited<ReturnType<StreamingSource['catalog']>>
  },
  stream(_channel: Channel) {
    return fromArray(new Float32Array(0))
  },
}

/** A minimal LEGACY pull `DataSource`-shaped object: has `positions`/`catalog` but NO `stream`. */
const legacyDataSource = {
  async catalog() {
    return { total: 0, layouts: [], columns: [] }
  },
  async positions() {
    return { positions: new Float32Array(0), length: 0 }
  },
}

describe('isStreamingSource', () => {
  it('accepts a source exposing catalog() + stream()', () => {
    expect(isStreamingSource(streamingSource)).toBe(true)
  })

  it('rejects a legacy DataSource (no stream())', () => {
    expect(isStreamingSource(legacyDataSource)).toBe(false)
  })

  it('rejects null / undefined / non-objects', () => {
    expect(isStreamingSource(null)).toBe(false)
    expect(isStreamingSource(undefined)).toBe(false)
    expect(isStreamingSource(42)).toBe(false)
    expect(isStreamingSource({})).toBe(false)
    // Half-shaped objects (only one of the two methods) are NOT streaming sources.
    expect(isStreamingSource({ stream: () => {} })).toBe(false)
    expect(isStreamingSource({ catalog: async () => ({}) })).toBe(false)
  })
})

describe('optionCarriesLiveState', () => {
  const base: VizOption = { version: 1, datasets: [{ id: 'd' }], grid: [{ id: 'g' }], series: [] }

  it('is FALSE for a layout-only option (declarative mount → default merge/build path)', () => {
    expect(optionCarriesLiveState(base)).toBe(false)
  })

  it('is TRUE when the option carries any live interaction field (→ restore with replace)', () => {
    expect(optionCarriesLiveState({ ...base, selection: { mode: 'lasso', link: [], ids: [1, 2] } })).toBe(true)
    expect(optionCarriesLiveState({ ...base, dataZoom: [{ id: 'z', type: 'slider', coordId: 'g', axes: ['x'] }] })).toBe(true)
    expect(optionCarriesLiveState({ ...base, filters: { f: [0, 1] } })).toBe(true)
    expect(optionCarriesLiveState({ ...base, colorOverrides: { c: {} } })).toBe(true)
    expect(optionCarriesLiveState({ ...base, colorScale: { link: [], domains: { k: [0, 1] } } })).toBe(true)
    expect(optionCarriesLiveState({ ...base, colorBySelection: 'k' })).toBe(true)
  })
})

// ITEM-22 (1): the mount effect delegates its restore DECISION to `planReloadRestore` (the effect
// itself — reading `performance`/`sessionStorage` — is exercised by the showcase/e2e layer, not this
// node pass). These assert the wiring returns the SAVED option to `setOption(replace)` only on a
// genuine reload, and never for a `window.open` child tab or an absent snapshot.
describe('planReloadRestore', () => {
  const saved: VizOption = {
    version: 1,
    datasets: [{ id: 'd' }],
    grid: [{ id: 'g' }],
    series: [],
    selection: { mode: 'lasso', link: [], ids: [7] },
  }

  it('restores the saved option on a genuine reload', () => {
    expect(planReloadRestore({ type: 'reload' }, saved)).toBe(saved)
  })

  it('does NOT restore for a window.open child tab (nav type "navigate")', () => {
    expect(planReloadRestore({ type: 'navigate' }, saved)).toBeNull()
  })

  it('does NOT restore for back_forward / prerender / a missing nav entry', () => {
    expect(planReloadRestore({ type: 'back_forward' }, saved)).toBeNull()
    expect(planReloadRestore({ type: 'prerender' }, saved)).toBeNull()
    expect(planReloadRestore(null, saved)).toBeNull()
    expect(planReloadRestore(undefined, saved)).toBeNull()
  })

  it('does NOT restore when there is no persisted snapshot (even on a reload)', () => {
    expect(planReloadRestore({ type: 'reload' }, null)).toBeNull()
  })

  it('uses the versioned per-window sessionStorage key (contract with the persist side)', () => {
    expect(VIZ_WINDOW_OPTION_KEY).toBe('viz:window-option:v1')
  })
})

// ITEM-22 (2): the URL-focus effect delegates its WRITE DECISION to `nextFocusUrl` (the
// `history.replaceState` call + the `select`-event subscription are e2e-only). These assert the
// helper writes `?pane=<origin>` only when the URL doesn't already reflect the focus.
describe('nextFocusUrl', () => {
  it('writes ?pane=<id> when the focus is not yet reflected', () => {
    expect(nextFocusUrl('http://viz.local/', 'cellA')).toBe(`http://viz.local/?${FOCUS_PARAM}=cellA`)
  })

  it('returns null (no history write) when the URL already reflects the focus', () => {
    expect(nextFocusUrl(`http://viz.local/?${FOCUS_PARAM}=cellA`, 'cellA')).toBeNull()
  })

  it('removes the param when focus clears (null / empty normalize the same)', () => {
    expect(nextFocusUrl(`http://viz.local/?${FOCUS_PARAM}=cellA`, null)).toBe('http://viz.local/')
    expect(nextFocusUrl(`http://viz.local/?${FOCUS_PARAM}=cellA`, '')).toBe('http://viz.local/')
  })

  it('is a no-op (null) when clearing focus on an already-clean URL', () => {
    expect(nextFocusUrl('http://viz.local/', null)).toBeNull()
  })
})
