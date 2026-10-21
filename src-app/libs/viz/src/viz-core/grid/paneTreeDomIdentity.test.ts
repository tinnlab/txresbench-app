// @vitest-environment jsdom
//
// paneTreeDomIdentity — the split tree's leaf carries BOTH of a pane's identities, and they are not
// interchangeable.
//
// ── WHY THIS FILE EXISTS (it was found by a surviving mutation) ──────────────────────────────────
// The pane-chrome round swept every `data-testid` onto the AUTHORED id and deliberately KEPT the
// grid key on the two invertible channels. Mutating `data-viz-cell={id}` → `{testId}` — i.e.
// "simplifying" the leaf to one id — killed NOTHING: the whole suite stayed green. That is not a
// missing assertion about a cosmetic attribute; `data-viz-cell` is what `GridDockLayer`'s per-pane
// export crop and `VisualizationPage`'s export crop `querySelector` with the id the STORE is keyed
// by, so on a composed grid the mutation crops the wrong pane, or nothing. It survived because every
// fixture that exercises those consumers drives an UN-COMPOSED grid, where both ids are the same
// string and the mutation is invisible — the same blindness the composed-grid drag spec exists to
// remove one layer up.
//
// The e2e cannot host this leg: `tests/viz-e2e/` is inside the domain-guard's scan set and carries a
// per-file, shrink-only budget for the grid's own noun, so a spec there cannot name the attribute.
// `libs/viz` is a documented carve-out, and `PaneTree` is a props-only leaf component, so the
// assertion is cheapest and clearest right here.

import * as React from 'react'
import { render, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { LayoutNode } from '@ziee/dock'
import { PaneTree } from './PaneTree'
import { paneTestId, type GridCell } from './gridModel'

// `react-resizable-panels` constructs a `ResizeObserver` when a Group mounts, and jsdom ships none.
// A no-op stand-in is enough: nothing here asserts on SIZE — only on the two ids the leaf publishes,
// which are written during render and never touched by a measurement.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= NoopResizeObserver

afterEach(() => cleanup())

/** Two panes, both host-namespaced, the way a composing host emits them. */
const CELLS: Record<string, Pick<GridCell, 'id' | 'localId'>> = {
  'panel.alpha::left': { id: 'panel.alpha::left', localId: 'left' },
  'panel.beta::right': { id: 'panel.beta::right', localId: 'right' },
}

const LAYOUT: LayoutNode = {
  kind: 'split',
  dir: 'col',
  sizes: [0.5, 0.5],
  children: [
    { kind: 'leaf', id: 'panel.alpha::left' },
    { kind: 'leaf', id: 'panel.beta::right' },
  ],
} as LayoutNode

function renderTree(resolve: (id: string) => string, node: LayoutNode = LAYOUT) {
  return render(
    React.createElement(PaneTree, {
      node,
      keyPrefix: 'root',
      onLayout: () => {},
      registerPane: () => {},
      paneTestId: resolve,
    }),
  )
}

/** The leaf bodies, in document order. */
function leaves(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-viz-cell]'))
}

describe('the split tree leaf publishes two ids on two attributes', () => {
  it('addresses the leaf by the AUTHORED id', () => {
    const { container } = renderTree(id => paneTestId(CELLS, id))
    const ids = leaves(container).map(el => el.getAttribute('data-testid'))
    expect(ids, 'the tree renders a leaf per pane').toHaveLength(2)
    expect(ids).toEqual(['viz-grid-cell-left', 'viz-grid-cell-right'])
  })

  it('…and KEEPS the grid key on the lookup channel, because two exporters invert through it', () => {
    // `GridDockLayer.buildExportDialog` and `VisualizationPage` both do
    // `querySelector('[data-viz-cell="<cellId>"]')` with the id the store is keyed by, to crop the
    // deck canvas to that pane's rect. Resolve this to the authored id and a composed grid's
    // per-pane export silently crops the wrong pane — with no other symptom.
    const { container } = renderTree(id => paneTestId(CELLS, id))
    expect(leaves(container).map(el => el.getAttribute('data-viz-cell'))).toEqual([
      'panel.alpha::left',
      'panel.beta::right',
    ])
  })

  it('the two channels genuinely DIFFER here — otherwise the pair above proves nothing', () => {
    // The negative control for this whole file. Every other grid fixture in the tree makes the two
    // ids the same string, which is exactly why the mutation that motivated this file survived.
    const { container } = renderTree(id => paneTestId(CELLS, id))
    for (const el of leaves(container)) {
      expect(el.getAttribute('data-viz-cell')).not.toBe(el.getAttribute('data-testid'))
      expect(el.getAttribute('data-testid')).not.toContain('::')
      expect(el.getAttribute('data-viz-cell')).toContain('::')
    }
  })

  it('an UN-COMPOSED tree is byte-identical to before the resolver existed', () => {
    const plain: LayoutNode = { kind: 'leaf', id: 'cell-1' } as LayoutNode
    const { container } = renderTree(id => paneTestId({}, id), plain)
    const el = leaves(container)[0]
    expect(el.getAttribute('data-testid')).toBe('viz-grid-cell-cell-1')
    expect(el.getAttribute('data-viz-cell')).toBe('cell-1')
  })
})
