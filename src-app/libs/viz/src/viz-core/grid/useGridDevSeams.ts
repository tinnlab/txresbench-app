// useGridDevSeams.ts — SPLIT R (ITEM-34): the grid's DEV-INSTRUMENTATION plane.
//
// DEC-26's "DEV instrumentation seams" row (57) moved verbatim out of `GridWorkspace`: the six
// `window.__viz*` hooks the gallery stories and the e2e suite drive the grid through, their
// primary-instance gate, and the unmount teardown that drops them.
//
// WHY THIS ROW EXISTS AT ALL — these are the seams e2e uses to reach state that has no UI affordance
// yet (share a mask across a link group, mint a link group directly, seed a cell's display override).
// They are DEV-ONLY by convention, not by `cfg`: they are installed unconditionally, so the teardown
// is the only thing preventing a torn-down workspace from leaving live mutators on `window`.
//
// `isPrimaryWorkspace` CAME WITH IT, and that is a correction to the record. Two comments — this
// shell's own and `useGridAnnotate.ts`'s writer-set table — asserted it "did NOT move: the mask
// plane's window-hook effect reads it too, so it is a value with two owners". That was true when it
// was written and is now false: the window-hook effect they name IS this module, and after the move
// `grep` finds exactly ONE code reader of the shell's `isPrimaryWorkspace` — the gate below. Leaving
// the const in the shell would have left genuinely dead code behind a comment explaining why it was
// alive (DEC-18 rule 4's delete-don't-carry clause). Both comments are corrected in the same commit.
// It is derived from `containerId` here, exactly as it was there — same expression, same DEC-20 test.
//
// SHAPE — returns `void`. Every output is a `window` write, so there is nothing to broker; this is
// the `useGridColoring` shape (DEC-27), not the value-bundle shape. A plane that returned something
// would be re-brokering instrumentation through the shell for no reader.
//
// Writer-set completeness (HAZARD 1) — this module IS the escape hatch that HAZARD 1 is about, so the
// direction of the check is inverted here. The question is not "did a writer stay behind" but "does
// any OTHER module write these six names". Grepped across the package:
//   `__vizSharedMasks` / `__vizShareMaskAcrossGroup` / `__vizDetachSharedMask` /
//   `__vizApplyDisplayToGroup` / `__vizSeedCellDisplay` / `__vizLinkCells`
//                        installed and torn down ONLY here, and read only by stories / e2e specs.
//   `__vizAnnotateStores` / `__vizProcessorPorts`
//                        NOT here — they belong to `useGridAnnotate`, which installs them beside the
//                        maps they alias (Split J). Deliberately left there: a seam belongs with the
//                        state it publishes, not with the other seams.
// Everything the effect reads (`sharedMaskSessionsRef`, the three mask callbacks, `maskEpoch`,
// `stores`) is an INPUT, owned by the mask plane or the shell. This module owns no state at all.
import { useEffect } from 'react'
import type { RefObject } from 'react'
import { PRIMARY_CONTAINER, type ContainerId } from '@ziee/dock'
import type { SharedLabelMask } from '../annotate/sharedMask'
import type { SharedMaskController } from '../annotate/sharedMaskController'
import type { VizStores } from '../../adapter/vizStores'

export interface GridDevSeamsInputs {
  readonly containerId: ContainerId
  readonly stores: VizStores
  /** Re-installs the handles when the mask epoch advances (the sessions map is mutated in place). */
  readonly maskEpoch: number
  readonly sharedMaskSessionsRef: RefObject<Map<string, { mask: SharedLabelMask; controller: SharedMaskController }>>
  readonly shareMaskAcrossGroup: (groupId: string) => void
  readonly detachSharedMask: (groupId: string) => void
  readonly applyDisplayToGroup: (sourceCellId: string) => void
}

export function useGridDevSeams({
  containerId,
  stores,
  maskEpoch,
  sharedMaskSessionsRef,
  shareMaskAcrossGroup,
  detachSharedMask,
  applyDisplayToGroup,
}: GridDevSeamsInputs): void {
  // Authoring intent (tool / class vocabulary / level) is strictly PER-PANE (DEC-17, amended INV-11).
  // The workspace-level authoring store that used to fan intent across every pane is DELETED: with N
  // datasets side by side, pane A brushing Tumour while pane B outlines Stroma is the point of the
  // surface, not an edge case. `isPrimaryWorkspace` replaces the old `ownsWorkspaceAnnotate` flag and
  // is derived from the container id (DEC-20) — the same test the file already uses elsewhere — so a
  // recursive popup <GridWorkspace> still cannot clobber the primary's window dev-hooks.
  const isPrimaryWorkspace = containerId === PRIMARY_CONTAINER

  // Expose the shared-mask sessions + attach/detach for gallery stories / e2e (dev hook, like
  // `__vizMaskSessions`). The e2e SHARES a 2-cell group, paints across the seam, and asserts one raster.
  useEffect(() => {
    // Gate to the OWNING (primary) instance — a recursive child <GridWorkspace> must not clobber the
    // primary's window hooks. `isPrimaryWorkspace` is the container-id test (DEC-20).
    if (typeof window === 'undefined' || !isPrimaryWorkspace) return
    const w = window as unknown as {
      __vizSharedMasks?: Map<string, { mask: SharedLabelMask; controller: SharedMaskController }>
      __vizShareMaskAcrossGroup?: (groupId: string) => void
      __vizDetachSharedMask?: (groupId: string) => void
      __vizLinkCells?: (cellIds: string[]) => string
      __vizApplyDisplayToGroup?: (sourceCellId: string) => void
      __vizSeedCellDisplay?: (cellId: string, patch: { colormap?: string }) => void
    }
    w.__vizSharedMasks = sharedMaskSessionsRef.current
    w.__vizShareMaskAcrossGroup = shareMaskAcrossGroup
    w.__vizDetachSharedMask = detachSharedMask
    w.__vizApplyDisplayToGroup = applyDisplayToGroup
    // dev-only test seam: give a cell an explicit display override (so the confirm-on-overwrite path
    // is exercisable). Mirrors `__vizLinkCells`; a genuine channel editor is out of Track C's scope.
    w.__vizSeedCellDisplay = (cellId, patch) =>
      stores.gridWorkspace.getState().applyDisplayPatches([{ cellId, ...patch }])
    // dev-only test seam (like `__vizMaskSessions`): create a link group over `cellIds` directly (the
    // link-picking UX is manual), returning the group id so a story/e2e can then share a mask over it.
    w.__vizLinkCells = (cellIds: string[]) => {
      const gid = `lg-${Math.random().toString(36).slice(2, 8)}`
      stores.gridWorkspace.setState(s => ({ linkGroups: { ...s.linkGroups, [gid]: [...cellIds] } }))
      return gid
    }
    return () => {
      // Drop the hooks on unmount so a torn-down workspace doesn't leave live mutators on `window`.
      w.__vizSharedMasks = undefined
      w.__vizShareMaskAcrossGroup = undefined
      w.__vizDetachSharedMask = undefined
      w.__vizApplyDisplayToGroup = undefined
      w.__vizSeedCellDisplay = undefined
      w.__vizLinkCells = undefined
    }
  }, [maskEpoch, isPrimaryWorkspace, shareMaskAcrossGroup, detachSharedMask, applyDisplayToGroup, stores])
}
