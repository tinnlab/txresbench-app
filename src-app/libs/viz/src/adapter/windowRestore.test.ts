// windowRestore.test.ts — the two PER-WINDOW behaviors (ITEM-22 / DEC-16), unit-tested PURELY (no
// jsdom): a nav-timing entry, a mock `StorageLike`, and URL strings are all passed in as arguments.
//
// Covers:
//  (1) restore-only-on-reload — a genuine reload restores; a `window.open` COPY (nav `navigate` +
//      a copied sessionStorage) does NOT restore; persist/read round-trips over a mock StorageLike.
//  (2) URL-as-view-into-focus — focusToUrl/urlToFocus bidirectional round-trip + the all-directions
//      `isFocusUrlReconciled` predicate.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  shouldRestoreOnReload,
  persistWindowOption,
  readWindowOption,
  focusToUrl,
  urlToFocus,
  isFocusUrlReconciled,
  VIZ_WINDOW_OPTION_KEY,
  FOCUS_PARAM,
  type NavigationTypeEntry,
} from './windowRestore'
import type { StorageLike } from '../viz-core/persist/autosaveCore'
import type { VizOption } from '../viz-core/option/types'

/** A minimal in-memory Storage fake (mirrors autosave.test.ts). `map` is exposed so a test can
 *  simulate the sessionStorage COPY a `window.open` child tab inherits. */
function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: k => void map.delete(k),
  }
}

/** A one-pane scatter option — enough to prove a strict-JSON persist/read round-trip. */
const OPTION: VizOption = {
  dataset: { id: 'demo' },
  grid: [{ id: 'g1', region: { col: 0 } }],
  series: [{ id: 'g1', type: 'scatter', coordId: 'g1', encode: { layout: 'primary' } }],
}

const nav = (type: string): NavigationTypeEntry => ({ type })

// ── (1) restore-only-on-reload ──────────────────────────────────────────────

describe('windowRestore — restore-only-on-reload (ITEM-22)', () => {
  it('restores on a genuine reload when a snapshot is persisted', () => {
    expect(shouldRestoreOnReload(nav('reload'), true)).toBe(true)
  })

  it('does NOT restore a window.open COPY (nav "navigate" + a copied sessionStorage)', () => {
    // Simulate the child tab: it inherited a COPY of the opener's sessionStorage (the snapshot IS
    // present, hasPersisted === true) but the navigation is a plain `navigate`, not a reload.
    const copiedSession = fakeStorage()
    persistWindowOption(copiedSession, VIZ_WINDOW_OPTION_KEY, OPTION) // opener's snapshot, copied in
    const hasPersisted = readWindowOption(copiedSession, VIZ_WINDOW_OPTION_KEY) != null
    expect(hasPersisted).toBe(true)
    // Despite a present snapshot, a `navigate` (child tab) must NOT restore.
    expect(shouldRestoreOnReload(nav('navigate'), hasPersisted)).toBe(false)
  })

  it('does NOT restore on reload when nothing is persisted', () => {
    expect(shouldRestoreOnReload(nav('reload'), false)).toBe(false)
  })

  it('does NOT restore for back_forward / prerender / a missing nav entry', () => {
    expect(shouldRestoreOnReload(nav('back_forward'), true)).toBe(false)
    expect(shouldRestoreOnReload(nav('prerender'), true)).toBe(false)
    expect(shouldRestoreOnReload(null, true)).toBe(false)
    expect(shouldRestoreOnReload(undefined, true)).toBe(false)
  })

  describe('persistWindowOption / readWindowOption over a mock StorageLike', () => {
    let storage: ReturnType<typeof fakeStorage>
    beforeEach(() => {
      storage = fakeStorage()
    })

    it('round-trips a VizOption through persist → read', () => {
      expect(persistWindowOption(storage, VIZ_WINDOW_OPTION_KEY, OPTION)).toBe(true)
      const read = readWindowOption(storage, VIZ_WINDOW_OPTION_KEY)
      expect(read).toEqual(OPTION)
      // It was actually written under the namespaced key.
      expect(storage.map.has(VIZ_WINDOW_OPTION_KEY)).toBe(true)
    })

    it('reads null when nothing is persisted', () => {
      expect(readWindowOption(storage, VIZ_WINDOW_OPTION_KEY)).toBeNull()
    })

    it('reads null for a corrupt (non-JSON) entry (never throws)', () => {
      storage.map.set(VIZ_WINDOW_OPTION_KEY, '{not json')
      expect(readWindowOption(storage, VIZ_WINDOW_OPTION_KEY)).toBeNull()
    })

    it('is fail-soft on a null storage (never falls back to ambient localStorage)', () => {
      expect(persistWindowOption(null, VIZ_WINDOW_OPTION_KEY, OPTION)).toBe(false)
      expect(readWindowOption(null, VIZ_WINDOW_OPTION_KEY)).toBeNull()
      expect(persistWindowOption(undefined, VIZ_WINDOW_OPTION_KEY, OPTION)).toBe(false)
      expect(readWindowOption(undefined, VIZ_WINDOW_OPTION_KEY)).toBeNull()
    })
  })
})

// ── (2) URL-as-view-into-focus ──────────────────────────────────────────────

describe('windowRestore — URL-as-view-into-focus (ITEM-22)', () => {
  it('writes ?pane=<id> onto a URL (focusToUrl)', () => {
    expect(urlToFocus(focusToUrl('http://viz.local/viz', 'g2'))).toBe('g2')
    expect(focusToUrl('http://viz.local/viz', 'g2')).toContain(`${FOCUS_PARAM}=g2`)
  })

  it('reads the focused pane from a URL (urlToFocus)', () => {
    expect(urlToFocus('http://viz.local/viz?pane=g3')).toBe('g3')
    expect(urlToFocus('http://viz.local/viz')).toBeNull()
    expect(urlToFocus('http://viz.local/viz?pane=')).toBeNull()
  })

  it('round-trips focusToUrl → urlToFocus for many pane ids', () => {
    for (const id of ['g1', 'cell-3', 'pane_42', 'a-b-c']) {
      expect(urlToFocus(focusToUrl('http://viz.local/viz?foo=bar', id))).toBe(id)
    }
  })

  it('round-trips urlToFocus → focusToUrl (reading then writing is a fixpoint)', () => {
    const url = 'http://viz.local/viz?pane=g5&keep=1'
    const focus = urlToFocus(url)
    expect(focus).toBe('g5')
    // Writing the read-back focus does not change the URL's pane param.
    expect(urlToFocus(focusToUrl(url, focus))).toBe('g5')
  })

  it('a null/empty focus REMOVES the pane param but preserves other query parts', () => {
    const cleared = focusToUrl('http://viz.local/viz?pane=g1&keep=1', null)
    expect(urlToFocus(cleared)).toBeNull()
    expect(cleared).toContain('keep=1')
    expect(focusToUrl('http://viz.local/viz?pane=g1', '')).not.toContain('pane=g1')
  })

  it('preserves a RELATIVE URL shape (no host injected)', () => {
    const written = focusToUrl('/viz?keep=1', 'g2')
    expect(written.startsWith('/viz')).toBe(true)
    expect(written).not.toContain('viz.local')
    expect(urlToFocus(written)).toBe('g2')
  })

  it('preserves the hash fragment', () => {
    const written = focusToUrl('http://viz.local/viz#section', 'g2')
    expect(written).toContain('#section')
    expect(urlToFocus(written)).toBe('g2')
  })

  it('focusToUrl is idempotent', () => {
    const once = focusToUrl('http://viz.local/viz', 'g2')
    expect(focusToUrl(once, 'g2')).toBe(once)
  })

  describe('isFocusUrlReconciled — the all-directions invariant', () => {
    it('holds once the URL reflects the focus (after focusToUrl)', () => {
      const reconciled = focusToUrl('http://viz.local/viz?keep=1', 'g2')
      expect(isFocusUrlReconciled(reconciled, 'g2')).toBe(true)
    })

    it('FAILS when the URL disagrees with the focus (a stale focus change)', () => {
      // URL says g1 but the focused pane is g2 → not reconciled in the read direction.
      expect(isFocusUrlReconciled('http://viz.local/viz?pane=g1', 'g2')).toBe(false)
      // URL carries a pane but nothing is focused → not reconciled.
      expect(isFocusUrlReconciled('http://viz.local/viz?pane=g1', null)).toBe(false)
      // Nothing focused, no pane param → reconciled.
      expect(isFocusUrlReconciled('http://viz.local/viz', null)).toBe(true)
    })

    it('treats "" and null as the same "no focus" state', () => {
      expect(isFocusUrlReconciled('http://viz.local/viz', '')).toBe(true)
      expect(isFocusUrlReconciled(focusToUrl('http://viz.local/viz', ''), '')).toBe(true)
    })

    it('every focusToUrl output satisfies the invariant for its focus (all directions)', () => {
      for (const [url, focus] of [
        ['http://viz.local/viz', 'g1'],
        ['http://viz.local/viz?keep=1', 'cell-3'],
        ['/viz?a=b', 'g9'],
        ['http://viz.local/viz?pane=old', null],
        ['http://viz.local/viz#h', 'g4'],
      ] as const) {
        const written = focusToUrl(url, focus)
        expect(isFocusUrlReconciled(written, focus)).toBe(true)
      }
    })
  })
})
