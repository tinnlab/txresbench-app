// PaneTree.tsx — SPLIT L (ITEM-28): the grid's SPLIT-TREE render component.
//
// DEC-26's census row "module tail (`PaneTree`, `SplitGroup`, `LeafBody`, `SEP*` styles)" (137),
// moved verbatim out of `GridWorkspace.tsx`. It is the recursive `Group`/`Panel`/`Separator` tree
// that renders the workspace layout, plus the four `React.CSSProperties` literals and the `SEP`
// constant it styles with.
//
// WHY THIS IS NOT OPTIONAL, and why "data plane" framing could not see it (DRIFT-31). INV-10 (b)
// reads as two caps — file ≤ 1,600 and body ≤ 1,200 — but it is really one, because the shell's
// NON-BODY lines (imports, the `GridWorkspaceProps` public interface, module consts, and this tail)
// do not shrink when a data plane leaves. With this tail in place `file ≤ 1,600` implied
// `body ≤ ~1,139`, i.e. STRICTER than the body cap asks for, so the file cap was unreachable even at
// a perfectly-met body cap. This is the one extraction in the set that is not data and not a hook.
//
// SHAPE — a props-only component, taken as-is. It was ALREADY a leaf: it reads no store, no ref, no
// context, and touches nothing in `GridWorkspace`'s closure. `PaneTree` is the only export; the
// recursion partner `SplitGroup`, the pane body `LeafBody`, and the five style constants stay
// module-private exactly as they were, because the shell never named them either.
//
// Writer-set completeness (HAZARD 1): VACUOUS here, and that is the finding rather than an omission.
// There is no state to move — no `useState`, no `useRef`, no `window` seam, no store subscription in
// the whole span. Every value it consumes arrives as a prop (`node`, `keyPrefix`, `onLayout`,
// `registerPane`), so `tsc` is a COMPLETE backstop for the first time in this decomposition.
//
// INV-10 (d): this is neither a LAYER nor a data-plane HOOK, so it joins neither `ALL_LAYERS` (which
// INV-10 (a) counts) nor `ALL_HOOKS`. Its only importer is the shell, and it imports no layer and no
// hook — asserted in both directions, so it cannot become a back door between two layers.
//
// ── TWO IDS ON THE LEAF, and why `paneTestId` arrives as a PROP ──────────────────────────────────
// The leaf body carries both of a pane's identities, for the two audiences `cellDomIdentity.test.ts`
// separates: `data-viz-cell` is the GRID's own key — `GridDockLayer`'s export crop and
// `VisualizationPage` both `querySelector` it with the id the store is keyed by, so on a composed
// grid it must stay the fold key or per-pane export silently crops the wrong pane (or nothing) — and
// `data-testid` is what a READER addresses, so it must be the id the declaration wrote.
// This module holds `LayoutNode`s, never `GridCell`s, so it cannot resolve the second itself. It
// takes a resolver rather than importing the cell map: the header's "every value it consumes arrives
// as a prop" is what makes `tsc` a complete backstop here, and reaching into the model to save one
// prop would end that.
import React from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { LayoutNode, SplitNode } from '@txresbench/dock'

/** Separator visual size (px). */
const SEP = 6

/** Recursively render the split tree as nested `Group`/`Panel`/`Separator`. */
export function PaneTree({
  node,
  keyPrefix,
  onLayout,
  registerPane,
  paneTestId,
}: {
  node: LayoutNode
  keyPrefix: string
  onLayout: () => void
  registerPane: (id: string, el: HTMLElement | null) => void
  /** grid key → the id a reader addresses that pane by (`cellTestId`). See the header. */
  paneTestId: (id: string) => string
}) {
  // A lone leaf still needs a Group wrapper (a Group needs ≥1 Panel).
  if (node.kind === 'leaf') {
    return (
      <Group orientation="horizontal" style={FILL}>
        <Panel
          // Key by the leaf id so a change of the lone leaf's id (e.g. `<Viz>` setOption replacing
          // the cells map: cell-1 → g-main) REMOUNTS the panel and re-fires `elementRef`
          // (registerPane old→null, new→el). Without the key React reuses the panel and the stale
          // pane element stays registered under the OLD id, so `measure()` finds no element for the
          // new id, `rects` never includes it, and the shared deck never mounts. The SplitGroup
          // children already key by their id (below) for the same reason.
          key={node.id}
          id={node.id}
          elementRef={el => registerPane(node.id, el as HTMLElement | null)}
          style={LEAF_PANEL_STYLE}
        >
          <LeafBody id={node.id} testId={paneTestId(node.id)} />
        </Panel>
      </Group>
    )
  }
  return (
    <SplitGroup
      node={node}
      keyPrefix={keyPrefix}
      onLayout={onLayout}
      registerPane={registerPane}
      paneTestId={paneTestId}
    />
  )
}

function SplitGroup({
  node,
  keyPrefix,
  onLayout,
  registerPane,
  paneTestId,
}: {
  node: SplitNode
  keyPrefix: string
  onLayout: () => void
  registerPane: (id: string, el: HTMLElement | null) => void
  paneTestId: (id: string) => string
}) {
  // dir 'row' divides HEIGHT (panes stacked) → vertical; 'col' divides WIDTH → horizontal.
  const orientation = node.dir === 'row' ? 'vertical' : 'horizontal'
  const items: React.ReactNode[] = []
  node.children.forEach((child, i) => {
    if (i > 0) {
      items.push(
        <Separator
          key={`${keyPrefix}-sep-${i}`}
          style={orientation === 'horizontal' ? SEP_V_STYLE : SEP_H_STYLE}
        />,
      )
    }
    const isLeaf = child.kind === 'leaf'
    const panelId = isLeaf ? (child as { id: string }).id : `${keyPrefix}-s${i}`
    items.push(
      <Panel
        key={panelId}
        id={panelId}
        defaultSize={`${node.sizes[i] * 100}%`}
        elementRef={
          isLeaf
            ? el => registerPane((child as { id: string }).id, el as HTMLElement | null)
            : undefined
        }
        style={isLeaf ? LEAF_PANEL_STYLE : SPLIT_PANEL_STYLE}
      >
        {isLeaf ? (
          <LeafBody
            id={(child as { id: string }).id}
            testId={paneTestId((child as { id: string }).id)}
          />
        ) : (
          <SplitGroup
            node={child as SplitNode}
            keyPrefix={panelId}
            onLayout={onLayout}
            registerPane={registerPane}
            paneTestId={paneTestId}
          />
        )}
      </Panel>,
    )
  })
  return (
    <Group orientation={orientation} onLayoutChanged={onLayout} style={FILL}>
      {items}
    </Group>
  )
}

/** The pane's content region — measured for its deck view; pointer-transparent.
 *
 *  `id` is the GRID key (the invertible one two `querySelector` consumers invert through);
 *  `testId` is what a reader addresses. Same element, two channels — see the header. */
function LeafBody({ id, testId }: { id: string; testId: string }) {
  return (
    <div
      data-viz-cell={id}
      data-testid={`viz-grid-cell-${testId}`}
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  )
}

const FILL: React.CSSProperties = { width: '100%', height: '100%' }
const LEAF_PANEL_STYLE: React.CSSProperties = { minWidth: 0, minHeight: 0, pointerEvents: 'none' }
const SPLIT_PANEL_STYLE: React.CSSProperties = { minWidth: 0, minHeight: 0, pointerEvents: 'none' }
// The separator keeps a comfortable `SEP`-px DRAG hit-area, but renders only a 1px HAIRLINE centered
// in it (a gradient) instead of a solid SEP-px bar — so the divider between panes reads as a thin
// line, not a thick border, while staying easy to grab. (#7)
const SEP_V_STYLE: React.CSSProperties = {
  width: SEP,
  cursor: 'col-resize',
  background:
    'linear-gradient(to right, transparent 2.5px, rgba(128,128,128,0.4) 2.5px, rgba(128,128,128,0.4) 3.5px, transparent 3.5px)',
  pointerEvents: 'auto',
}
const SEP_H_STYLE: React.CSSProperties = {
  height: SEP,
  cursor: 'row-resize',
  background:
    'linear-gradient(to bottom, transparent 2.5px, rgba(128,128,128,0.4) 2.5px, rgba(128,128,128,0.4) 3.5px, transparent 3.5px)',
  pointerEvents: 'auto',
}
