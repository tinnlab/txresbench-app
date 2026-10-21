// ArtifactPane (W3 host) — an artifact view as a pane. Its `ref` encodes EITHER a single
// produced artifact (`artifactKind::artifactId` → the host-owned `ArtifactPanel` dispatch,
// ITEM-38) OR a whole run (`run::runId` → the multi-output `ArtifactReview` + lineage,
// ITEM-24/25). The run form is what the history pane reopens (ITEM-26). Empty when no
// artifact is bound.

import { Empty } from '@ziee/kit'
import { ArtifactPanel } from './ArtifactPanel'
import { ArtifactReview } from './ArtifactReview'
import {
  type WorkbenchPane,
  type ParsedArtifactRef,
  PaneScroll,
  parseArtifactRef,
  runArtifactRef,
} from '../../core/shell/dock/paneModel'

// THE ENTITY BINDING IS NOT DONE HERE, and that is the fix, not an omission.
//
// This component used to `bindPaneEntity(pane.id, …)` in a mount effect and unbind on
// unmount — which tied the binding to the pane's RENDER lifetime. A region renders only its
// ACTIVE tab, so a bound pane that is not the active tab had NO binding at all, and the
// delete affordance's own flow guarantees exactly that: the review has to be active for its
// Delete to be clickable, which means the pane bound to the artifact being deleted is a
// background tab at that instant. Its `reconcileEntityPanes` then saw zero bindings and
// closed nothing; the user came back to a pane pointing at an artifact that no longer
// exists. (A layout restored from `localStorage` has the same hole for every tab the user
// has not clicked yet.)
//
// The binding is a property of the PANE, so it is now DERIVED from the pane's `ref` by the
// resolver `panes.tsx` registers for the kind (`paneModel.artifactPaneEntity`), which the shell
// can ask about every pane in the store whether or not it is on screen. The ref GRAMMAR moved
// with it — `core/` registers the resolver and may never import `extensions/` (INV-8) — and is
// re-exported here so this module stays the door its importers already knock on.
export { runArtifactRef, parseArtifactRef }
export type { ParsedArtifactRef }

export function ArtifactPane({ pane }: { pane: WorkbenchPane }) {
  const parsed = parseArtifactRef(pane.ref)

  return (
    <div data-testid={`workbench-artifact-pane-${pane.id}`} className="flex min-h-0 flex-1 flex-col">
      {/* ITEM-②: pane content scrolls via the overlay ScrollArea (react-overlayscrollbars) — no
          layout-width-stealing native scrollbar. Mirrors LauncherPane. */}
      <PaneScroll className="min-h-0 flex-1">
        <div className="flex flex-col">
          {parsed?.mode === 'artifact' ? (
            <ArtifactPanel artifactKind={parsed.artifactKind} artifactId={parsed.artifactId} />
          ) : parsed?.mode === 'run' ? (
            <ArtifactReview runId={parsed.runId} />
          ) : (
            <Empty
              data-testid={`workbench-artifact-pane-empty-${pane.id}`}
              title="No artifact bound"
              description="Complete an analysis run to review its artifacts here."
            />
          )}
        </div>
      </PaneScroll>
    </div>
  )
}
