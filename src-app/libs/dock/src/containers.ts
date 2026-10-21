// containers.ts — the PURE multi-container layout model (docking P2, Arch A / plan option 2a).
//
// The main is no longer the only place a pane can live: a pane belongs to exactly ONE container —
// the main `'main'` or a `popup:<n>` window — and each container owns its OWN split-tree. This is the
// state model behind cross-window docking: "move a pane between windows" = `removeLeaf` from the
// source container's tree (which REFLOWS to reclaim the space) + insert into the target's tree.
//
// This module is PURE (no store, no React, no DOM) — it composes the existing `splitTree` ops
// (`removeLeaf`/`splitLeaf`/`leafIds`) per-container, so it's exhaustively node-unit-testable. The
// store (`GridWorkspace.store`) is a thin adapter over it; the RENDER wiring (a popup rendering its
// container as its own `GridWorkspace`, and the main reflowing instead of showing a placeholder)
// lands in P3 — this phase delivers the model + `movePane` + return-position, fully tested.

import { type LayoutNode, type SplitDir, splitLeaf, removeLeaf, leafIds } from './layout/splitTree'

/** A container id: the main window main, or a popup window. */
export type ContainerId = 'main' | `popup:${number}`

/** The main-window container (the default home of every pane). */
export const PRIMARY_CONTAINER = 'main' as const

/** The multi-container layout model: each container's split-tree + which container each cell is in. */
export interface ContainerModel {
  /** each container's split-tree; a container with NO cells has no entry (absent = empty). */
  readonly layoutByContainer: Readonly<Record<string, LayoutNode>>
  /** which container each cell is in — SPARSE: an absent cell defaults to `'main'`. */
  readonly paneContainer: Readonly<Record<string, ContainerId>>
}

/** Where to place a moved pane inside the TARGET container's tree. */
export type DropTarget =
  /** the target is empty (or place as the whole container) → the pane becomes the root leaf. */
  | { readonly kind: 'root' }
  /** split an existing target leaf, adding the moved pane beside it. `before` docks it on the
   *  leading side (left/top) instead of the trailing side (right/bottom, the default). */
  | { readonly kind: 'split'; readonly atLeaf: string; readonly dir: SplitDir; readonly before?: boolean }

export interface MoveResult {
  readonly model: ContainerModel
  /** a POPUP container that became empty as a result of the move (the caller closes that window),
   *  or `null`. The `'main'` never signals emptied (an empty main main is a valid state, not a close). */
  readonly emptied: ContainerId | null
}

/** Which container a cell lives in (absent ⇒ the main). */
export function containerOf(model: ContainerModel, paneId: string): ContainerId {
  return model.paneContainer[paneId] ?? PRIMARY_CONTAINER
}

/** The cell ids docked in a container (empty when the container has no tree). */
export function panesInContainer(model: ContainerModel, containerId: ContainerId): string[] {
  const tree = model.layoutByContainer[containerId]
  return tree ? leafIds(tree) : []
}

/** Insert `paneId` as a leaf into a container tree per `dropTarget`. An absent/empty tree ⇒ the pane
 *  becomes the whole tree. A `root` target against a POPULATED tree means APPEND (the "drop into the
 *  container's body, no pane under the cursor" intent) — it splits beside the last leaf, NEVER
 *  obliterates the existing panes. A `split` target whose leaf is missing falls back to the first leaf
 *  (robust against a stale drop target after a concurrent reflow). */
export function insertLeaf(
  tree: LayoutNode | undefined,
  paneId: string,
  dropTarget: DropTarget,
): LayoutNode {
  if (!tree) return { kind: 'leaf', id: paneId }
  const leaves = leafIds(tree)
  // `root` into a populated container is an APPEND, not a replace: a placement/drop resolving with no
  // pane under the cursor (a gutter/margin click) must add the pane beside the container's last leaf,
  // not discard every existing pane. Only an absent/empty container (handled above) roots a lone leaf.
  if (dropTarget.kind === 'root') return splitLeaf(tree, leaves[leaves.length - 1], 'col', paneId)
  const at = leaves.includes(dropTarget.atLeaf) ? dropTarget.atLeaf : leaves[0]
  return splitLeaf(tree, at, dropTarget.dir, paneId, dropTarget.before ?? false)
}

/**
 * Move `paneId` into `toContainer` at `dropTarget`. Removes it from its current container (collapsing
 * that container's split-tree — the reflow), inserts it into the target, and reassigns
 * `paneContainer`. If the source was a POPUP left with no panes, `emptied` names it (caller closes the
 * window). A move to the same container is a valid REPOSITION. A missing cell is a no-op. Never
 * mutates the input model.
 */
export function movePane(
  model: ContainerModel,
  paneId: string,
  toContainer: ContainerId,
  dropTarget: DropTarget,
): MoveResult {
  const from = containerOf(model, paneId)
  const fromTree = model.layoutByContainer[from]
  // Guard: the cell must actually be a leaf of its container (else nothing to move).
  if (!fromTree || !leafIds(fromTree).includes(paneId)) return { model, emptied: null }

  const layoutByContainer: Record<string, LayoutNode> = { ...model.layoutByContainer }

  // 1. Remove from the source (reflow: removeLeaf collapses single-child splits, renormalizes sizes).
  const afterRemove = removeLeaf(fromTree, paneId)
  let emptied: ContainerId | null = null
  if (afterRemove === null) {
    delete layoutByContainer[from]
    // the main emptying is a valid state; only a popup emptying signals a window close.
    if (from !== PRIMARY_CONTAINER && from !== toContainer) emptied = from
  } else {
    layoutByContainer[from] = afterRemove
  }

  // 2. Insert into the target (which may be the just-modified source tree on a same-container move).
  layoutByContainer[toContainer] = insertLeaf(layoutByContainer[toContainer], paneId, dropTarget)

  // 3. Reassign the pane's container (sparse: drop the entry when it returns to the main default).
  const paneContainer: Record<string, ContainerId> = { ...model.paneContainer }
  if (toContainer === PRIMARY_CONTAINER) delete paneContainer[paneId]
  else paneContainer[paneId] = toContainer

  return { model: { layoutByContainer, paneContainer }, emptied }
}

/**
 * The return ANCHOR for a pane about to LEAVE a container: where to best-effort restore it later (a
 * popup closed without dragging it back). It is the pane's former SIBLING slot — split beside a leaf
 * that will REMAIN after this pane is removed, in the parent split's direction — so a returning pane
 * lands roughly where it was. Returns `null` when the pane is the container's only leaf (no sibling to
 * anchor to; a later return just becomes the root / appends).
 *
 * Pure tree geometry: finds the pane's parent split, then a sibling LEAF under it (descending into a
 * sibling sub-split to its first leaf). A `split` `DropTarget` whose `atLeaf` later vanished falls back
 * to an append inside {@link returnToPrimary}, so a stale anchor is always safe.
 */
export function slotAnchorOf(tree: LayoutNode, paneId: string): DropTarget | null {
  return findAnchor(tree, paneId)
}

function findAnchor(node: LayoutNode, paneId: string): DropTarget | null {
  if (node.kind === 'leaf') return null // a bare leaf root has no sibling
  // Is `paneId` a DIRECT child of this split? Then a sibling under this split is the anchor.
  const directIdx = node.children.findIndex(c => c.kind === 'leaf' && c.id === paneId)
  if (directIdx >= 0) {
    for (let i = 0; i < node.children.length; i++) {
      if (i === directIdx) continue
      const siblingLeaf = firstLeafId(node.children[i])
      if (siblingLeaf) return { kind: 'split', atLeaf: siblingLeaf, dir: node.dir }
    }
    return null // only child (shouldn't happen in a well-formed split) → no anchor
  }
  // Otherwise recurse into whichever child subtree contains `paneId`.
  for (const child of node.children) {
    if (child.kind === 'split') {
      const found = findAnchor(child, paneId)
      if (found) return found
    }
  }
  return null
}

/** The first leaf id in a subtree (depth-first), or null for an empty/absent node. */
function firstLeafId(node: LayoutNode): string | null {
  const ids = leafIds(node)
  return ids.length > 0 ? ids[0] : null
}

/**
 * Return a pane to the main (e.g. a popup closed without dragging it back). Best-effort restores it to
 * `remembered` slot if that leaf still exists, else APPENDS it (splits the last main leaf; or becomes
 * the root when the main is empty). Delegates to {@link movePane}, so the source popup still signals
 * `emptied` when this was its last pane.
 */
export function returnToPrimary(
  model: ContainerModel,
  paneId: string,
  remembered?: DropTarget,
): MoveResult {
  const gridLeaves = panesInContainer(model, PRIMARY_CONTAINER)
  let dropTarget: DropTarget
  if (gridLeaves.length === 0) {
    dropTarget = { kind: 'root' }
  } else if (remembered && remembered.kind === 'split' && gridLeaves.includes(remembered.atLeaf)) {
    dropTarget = remembered
  } else {
    dropTarget = { kind: 'split', atLeaf: gridLeaves[gridLeaves.length - 1], dir: 'col' }
  }
  return movePane(model, paneId, PRIMARY_CONTAINER, dropTarget)
}
