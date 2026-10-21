// liveRegion.ts — accessibility announcement primitives for the GPU canvases (ITEM-60).
//
// A WebGL/GPU canvas is a single opaque node to a screen reader: pixel changes emit no
// DOM mutations, so pan/zoom/selection are invisible to assistive tech. The fix is an
// ARIA live region — a visually-hidden DOM node whose textContent we update as state
// changes; the screen reader SPEAKS the new text. This module is pure + domain-agnostic
// (it says "points", never "cells") and node-testable: the controller writes to an
// INJECTED element, so no browser is needed to unit-test it.

/** The minimal element shape the controller writes to (a real DOM node satisfies it, and
 *  a node test can pass a plain `{ textContent: '' }` object). */
export interface LiveRegionElement {
  textContent: string | null
}

/** ARIA live politeness: `polite` waits for a pause; `assertive` interrupts. */
export type Politeness = 'polite' | 'assertive'

// Deterministic, locale-independent grouped number formatting ("200000" → "200,000") so
// announcements read naturally AND unit tests are stable regardless of the host locale.
const NUM = new Intl.NumberFormat('en-US')
function fmt(n: number): string {
  return NUM.format(Math.trunc(n))
}

/** Pluralize a noun on a count (`1 point` / `2 points`). */
function plural(n: number, noun: string): string {
  return `${noun}${Math.abs(n) === 1 ? '' : 's'}`
}

// ── message builders (pure) ────────────────────────────────────────────────────────────

/**
 * "Selected 5,021 of 200,000 points". `count` selected out of `total`. The trailing noun
 * agrees with `total`. A zero count reads "cleared" via {@link announceEmpty}, but this
 * builder still formats a literal 0 if asked.
 */
export function announceSelection(count: number, total: number): string {
  return `Selected ${fmt(count)} of ${fmt(total)} ${plural(total, 'point')}`
}

/**
 * "Zoomed in" / "Zoomed out" / "View reset". The argument is a zoom DELTA (or direction
 * sign): positive → in, negative → out, exactly 0 → reset. Modeled as a delta because a
 * single absolute zoom level can't tell the listener which way the view moved.
 */
export function announceViewChange(zoomDelta: number): string {
  if (zoomDelta > 0) return 'Zoomed in'
  if (zoomDelta < 0) return 'Zoomed out'
  return 'View reset'
}

/**
 * "Point 6 of 200,000" — the currently focused point. `index` is 0-based (as stored); the
 * spoken position is 1-based (as a human counts).
 */
export function announceCellFocus(index: number, total: number): string {
  return `Point ${fmt(index + 1)} of ${fmt(total)}`
}

/** "Selection cleared". */
export function announceEmpty(): string {
  return 'Selection cleared'
}

// ── controller ──────────────────────────────────────────────────────────────────────────

export interface LiveRegionOptions {
  politeness?: Politeness
  /** Debounce window (ms). Rapid announcements collapse to the last one so a burst of
   *  key-repeat pans doesn't spam the screen reader. Default 150ms. */
  debounceMs?: number
}

/**
 * Writes announcement text into an injected live-region element, debounced. Attach a DOM
 * node (or any {@link LiveRegionElement}) with {@link attach}; call {@link announce} on
 * each state change. The last message in a debounce window wins.
 */
export class LiveRegion {
  politeness: Politeness
  private readonly debounceMs: number
  private el: LiveRegionElement | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: string | null = null

  constructor(opts: LiveRegionOptions = {}) {
    this.politeness = opts.politeness ?? 'polite'
    this.debounceMs = opts.debounceMs ?? 150
  }

  /** Bind the element the announcements are written to. */
  attach(el: LiveRegionElement | null): void {
    this.el = el
  }

  /** Queue `msg` to be spoken; only the last message within `debounceMs` is written. */
  announce(msg: string): void {
    this.pending = msg
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.debounceMs)
  }

  /** Write the pending message immediately (cancels the debounce timer). */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending !== null && this.el) {
      this.el.textContent = this.pending
    }
    this.pending = null
  }

  /** Cancel any pending announcement and detach (idempotent; safe on unmount). */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
    this.el = null
  }
}
