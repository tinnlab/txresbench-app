// composedPaneDomId.test.ts — composition's namespacing is INTERNAL; the DOM keeps the id the
// declaration wrote.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
// `composeCanvas` prefixes every id a contribution wrote with its view (`<viewId>::<local>`) so two
// independently-authored declarations cannot silently merge two unrelated plots into one square on
// the shared grid. That is a correctness requirement and it stays. But the composed `coordId`
// became the pane's identity all the way down, and viz stamps a pane's identity into its
// `data-testid` — so a spec addressing a pane had to know (a) the separator and (b) which view
// happened to contribute it, neither of which is any of its business. The e2e spec under
// `tests/e2e/14-workbench/` that drives the two before/after plot panes was written against the ids the
// declaration writes (`…-emb-before` / `…-emb-after`), and composition silently moved the DOM out
// from under it.
//
// The fix is NOT a DOM-safe separator (the leak would remain, just spelled differently) and NOT
// namespacing only when >1 view contributes (an id whose SHAPE depends on how many other panes are
// open is worse than one that leaks). The composed id stays exactly as it is and stays internal;
// the pane additionally carries the id its author wrote, and that is what reaches the DOM.
//
// ── WHERE THE REST OF THE CHAIN IS ──────────────────────────────────────────────────────────────
// This side owns "what composition puts on the wire". Its counterpart in `libs/viz` (the pane
// DOM-identity suite under `src/viz-core/grid/`) owns the other half — that viz resolves those
// fields onto its pane model and renders them — asserted on the rendered DOM. Split by layer, not
// duplicated; the same split `canvasCloseAffordance.test.ts` uses.

import { describe, expect, it } from 'vitest'
import type { VizOption } from '@txresbench/viz'
import { composeCanvas, type CanvasContribution } from './canvasComposition'

/** Two views that BOTH call their pane `emb` — the collision namespacing exists for. Neither is
 *  wrong to; a declaration names its own panes and knows nothing about the other. */
function contribution(paneIds: readonly string[]): CanvasContribution {
  return {
    option: {
      datasets: [{ id: 'frame' }],
      grid: [],
      series: paneIds.map(id => ({
        id: `s-${id}`,
        type: 'scatter',
        coordId: id,
        datasetId: 'frame',
        encode: { layout: 'primary' },
      })),
    } as VizOption,
    resolver: () => ({}) as never,
    close: null,
  }
}

const COMPOSED = () =>
  composeCanvas(
    new Map([
      ['view.alpha', contribution(['emb', 'qc'])],
      ['view.beta', contribution(['emb'])],
    ]),
  )

/** The plots the two views both called `emb`. */
const embOf = (composed: ReturnType<typeof COMPOSED>) =>
  (composed.option?.series ?? []).filter(s => composed.paneOwners.get(s.coordId)?.local === 'emb')

describe('a composed canvas keeps its namespacing off the DOM', () => {
  it('still namespaces INTERNALLY — the collision guard is untouched', () => {
    const composed = COMPOSED()
    const coordIds = (composed.option?.series ?? []).map(s => s.coordId)
    expect(new Set(coordIds).size, 'two views naming a pane `emb` must remain two panes').toBe(3)
    expect(coordIds.every(id => id.includes('::')), 'every composed pane id is view-qualified').toBe(true)
  })

  it('carries the id the DECLARATION wrote, alongside the view that placed it', () => {
    const composed = COMPOSED()
    const emb = embOf(composed)
    expect(emb).toHaveLength(2)
    for (const s of emb) {
      expect(
        s.localId,
        'the composed pane must state the id its author gave it — that is what a reader addresses, ' +
          'and it is the only thing recoverable without parsing the composed id back apart',
      ).toBe('emb')
      expect(s.localId, 'and it may never carry the composition separator').not.toContain('::')
    }
    expect(
      new Set(emb.map(s => s.ownerId)),
      'two panes that share a declared id are told apart by WHO placed them',
    ).toEqual(new Set(['view.alpha', 'view.beta']))
  })

  it('namespaces the SERIES id too — a shared plot name must not take the whole canvas down', () => {
    // Found while wiring the DOM half of this round. Two views naming a plot `s-emb` is as ordinary
    // as two naming a pane `emb`, and `parseOption` REJECTS a duplicate series id outright — so
    // composition threw and every open pane's plots went with it.
    const ids = (COMPOSED().option?.series ?? []).map(s => s.id)
    expect(new Set(ids).size, 'each contribution keeps its own plot identity').toBe(ids.length)
    expect(ids.every(id => id.includes('::'))).toBe(true)
  })

  it('a SOLE contributor is composed the same way — the id shape never depends on how many panes are open', () => {
    const solo = composeCanvas(new Map([['view.alpha', contribution(['emb'])]]))
    const s = (solo.option?.series ?? [])[0]
    expect(s.coordId, 'still namespaced internally').toContain('::')
    expect(s.localId, 'still addressed by its declared id').toBe('emb')
    expect(s.ownerId).toBe('view.alpha')
  })
})
