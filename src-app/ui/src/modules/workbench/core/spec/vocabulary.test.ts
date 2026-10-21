// TEST-37 (visualize-pane ITEM-29) — **`EFFECT_OPS` IS UNCHANGED BY THIS ROUND.**
//
// ITEM-29's rule is an ABSENCE: the Visualize pane draws its pictures through the canvas
// PROJECTION (a section's `canvas:` block, a `for_each` over its own state), and it adds no
// effect op to do it. *"No new effect op — `EFFECT_OPS` stays closed."*
//
// ── why this is an ENUMERATION and not a containment check ────────────────────────────────
//
// `render/registry.test.ts` already asserts the set is equality-CLOSED against the validator:
// every declared op is accepted and an undeclared one (`exfiltrate`) is rejected. That test
// is about the validator, and it stays green no matter what is added to the list — which is
// exactly the change ITEM-29 forbids. The obvious way to ship the pane would have been an
// `append_canvas_pane` op; it would have passed every existing test in this repo.
//
// So what is pinned here is the LIST ITSELF, verbatim and in order. A future op — a canvas
// append, a "plot this" verb, anything a section could use to reach the centre — fails HERE,
// visibly, and someone decides. The failure message is the argument, so the next author meets
// it rather than a bare diff.
//
// The order is pinned too, deliberately. It costs nothing (the list is hand-written and stable)
// and it makes the diff of a REORDER — which is how an addition gets hidden in a long list —
// as loud as the diff of an addition.

import { describe, expect, it } from 'vitest'

import { EFFECT_OPS, NUMBER_REQUIRE_KEYS, REQUIRE_KEYS, WIDGET_KINDS } from './vocabulary'

/** The vocabulary as it stands with the Visualize pane shipped. `listAppend`/`listRemove`
 *  predate this round (DEC-9's dynamic-list mutation, already shipped by an earlier package);
 *  the pane's emit model is built out of them and adds nothing. */
const EFFECT_OPS_AT_VISUALIZE_PANE = [
  'set',
  'api',
  'run_processor',
  'wait_for',
  'progress',
  'toast',
  'open_view',
  'close_view',
  'call_action',
  'listAppend',
  'listRemove',
] as const

describe('TEST-37 — the effect vocabulary is closed, and this round did not open it', () => {
  it('is EXACTLY this list, in this order', () => {
    expect(
      [...EFFECT_OPS],
      [
        'EFFECT_OPS changed.',
        '',
        'ITEM-29: the Visualize pane draws through the canvas PROJECTION — a section declares a',
        '`canvas:` block over its OWN state — and adds no effect op to do it. An op that appends',
        'a pane to the canvas, or otherwise lets a declaration reach the centre imperatively, is',
        'the thing this assertion exists to stop: it would make a section able to do what INV-12',
        'says no extension may do.',
        '',
        'If the addition is genuinely right, change this list AND say why in the lifecycle record.',
        'Do not delete the assertion.',
      ].join('\n'),
    ).toEqual([...EFFECT_OPS_AT_VISUALIZE_PANE])
  })

  it('holds no canvas/plot/pane verb under any spelling', () => {
    // The enumeration above is the real guard; this one names the SHAPE of the forbidden
    // addition, so a reader of a future failure sees the category rather than a diff of strings.
    const smells = /canvas|plot|pane|mount|place|dock/i
    expect(EFFECT_OPS.filter(op => smells.test(op))).toEqual([])
  })

  it('the neighbouring closed sets are unchanged too — this round widened no vocabulary', () => {
    // `WIDGET_KINDS` is deliberately OPEN (an extension may register a kind core never heard
    // of — `render/registry.test.ts` proves it), so it is asserted as a FLOOR, not a fixed set:
    // pinning it would forbid the extensibility the design requires.
    expect(WIDGET_KINDS.length).toBeGreaterThan(0)
    // These two ARE closed, and the pane touched neither.
    expect([...REQUIRE_KEYS]).toEqual([
      'required',
      'min_items',
      'max_items',
      'number',
      'unique_by',
      'not_in',
      'message',
    ])
    expect([...NUMBER_REQUIRE_KEYS]).toEqual(['min', 'max', 'integer'])
  })
})
