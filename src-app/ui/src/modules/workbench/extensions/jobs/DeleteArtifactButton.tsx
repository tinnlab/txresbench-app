// DeleteArtifactButton (ITEM-19) — the UI affordance that deletes a produced artifact and
// GENUINELY self-closes its bound pane in the acting tab. Permission-gated: rendered ONLY for
// Owner/Editor (`canEdit`), matching the backend `require_project_edit` write boundary — a Viewer
// never sees it.
//
// ── Why this used to hand-wire two calls, and why it no longer does ─────────────────────────
//
// `workstore/data_api.rs:300` publishes `Artifact`/`Delete` with `origin` applied, so the acting
// connection is the one the fan-out skips. This file compensated by calling BOTH subscribers'
// effects itself — `reconcileEntityPanes(api)` (what `useEntitySelfClose` does) and
// `refreshCatalog()` (what `useCatalogInvalidation` does). That is an ENUMERATION of the
// subscriber list maintained at a mutation site: correct for exactly those two, silent for the
// third. `useCatalogInvalidation.ts` was written to retire precisely that shape.
//
// It now emits the ONE frame the server withheld and lets every `sync:artifact` subscriber react
// as it does for a cross-device delete — the same path, the same order, one code path instead of
// two. This also removes the extension -> `core/shell/dock/entityLifecycle` deep import (a
// committed entry in `scripts/layer-boundary-baseline.json`). See `core/sync/localEcho.ts`.

import { useState } from 'react'
import { Button, Confirm, message } from '@txresbench/kit'
import { ApiClient } from '@/api-client'
import { echoLocalSync } from '@/core/sync/localEcho'
import { useWorkbench } from '../../core/shell/WorkbenchContext'

export function DeleteArtifactButton({
  artifactId,
  testid,
  onDeleted,
}: {
  artifactId: string
  testid: string
  /** Called after a successful delete — e.g. the artifact-detail route reloads its card list (a
   *  bound run pane instead self-closes via `reconcileEntityPanes` and unmounts). */
  onDeleted?: () => void
}) {
  const { canEdit, projectId } = useWorkbench()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  // Owner/Editor only — a read-only Viewer must not even see the affordance (the backend also
  // hard-refuses with 403 PROJECT_READ_ONLY, but the UI must not offer what it can't do).
  if (!canEdit) return null

  const onConfirm = async () => {
    setBusy(true)
    try {
      await ApiClient.Workstore.deleteArtifact({ project_id: projectId, id: artifactId })
      // Re-emit the frame the server withheld from this connection. `useEntitySelfClose`
      // self-closes the bound pane and `useCatalogInvalidation` advances the catalog epoch —
      // the same reactions a cross-device delete produces, plus any subscriber added later.
      await echoLocalSync('artifact', 'delete', artifactId)
      // A route mount (no bound pane) still refreshes its own view; that is this component's
      // caller contract, not a sync subscriber.
      onDeleted?.()
      message.success('Artifact deleted')
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to delete artifact')
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  return (
    <Confirm
      open={open}
      onOpenChange={setOpen}
      title="Delete artifact?"
      description="This permanently removes the produced artifact and closes its view. This cannot be undone."
      danger
      okText="Delete"
      cancelText="Cancel"
      data-testid={`${testid}-dialog`}
      onConfirm={onConfirm}
    >
      <Button variant="destructive" disabled={busy} data-testid={testid}>
        Delete artifact
      </Button>
    </Confirm>
  )
}
