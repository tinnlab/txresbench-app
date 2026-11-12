// The contributed artifact-detail ROUTE (ITEM-46) — a deep-linkable, permission-gated
// project artifact view. PRINCIPLE: one renderer, three mounts — this route renders the
// SAME `ArtifactReview` (host-owned dispatch → the `ArtifactPanel` classifier / a
// `ViewContribution` component) as the inline run pane AND the pop-out window, so there
// is no third implementation. The URL (`/projects/:id/artifacts/:kind/:runId`) carries
// the ids → shareable, browser back/forward, open-in-new-tab.
//
// Access is gated TWICE: the route's global `permission: ProvenanceRead` (module.tsx)
// AND the per-project role — `Project.access` 403/404s for a project the user can't
// reach, so this renders an access-denied state (never the renderer) for an
// unpermitted member (TEST-417). It is a READ-ONLY deep-link (no write affordances off
// a shared URL) → `canEdit={false}`, so the chaining "start next analysis" affordance
// (which needs the live workspace instance) is not offered here; the workspace panes
// remain the launch surface.

import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Button, ErrorState, Spinner } from '@txresbench/kit'
import { ApiClient } from '@/api-client'
import { useWorkbenchApi } from '../../core/host/createHost'
import { WorkbenchProvider } from '../../core/shell/WorkbenchContext'
import { ArtifactReview } from './ArtifactReview'

type AccessState = { status: 'loading' } | { status: 'ok' } | { status: 'denied' }

export function ArtifactDetailRoutePage() {
  const { id = '', kind = '', runId = '' } = useParams<{ id: string; kind: string; runId: string }>()
  const navigate = useNavigate()
  const [access, setAccess] = useState<AccessState>({ status: 'loading' })
  const [viewId] = useState(() => crypto.randomUUID())
  // Hooks run unconditionally (Rules of Hooks): the per-project API is memoized by id.
  const api = useWorkbenchApi(id)

  useEffect(() => {
    let cancelled = false
    setAccess({ status: 'loading' })
    void ApiClient.Project.access({ id })
      .then(() => {
        if (!cancelled) setAccess({ status: 'ok' })
      })
      .catch(() => {
        // 403 / 404 — the acting user can't reach this project (the route guard).
        if (!cancelled) setAccess({ status: 'denied' })
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (access.status === 'loading') {
    return (
      <div className="flex h-full min-h-0 items-center justify-center py-16" role="main">
        <Spinner label="Loading artifact…" data-testid="artifact-detail-loading" />
      </div>
    )
  }

  if (access.status === 'denied') {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 p-8" role="main" data-testid="artifact-detail-denied">
        <ErrorState
          resource="artifact"
          description="You don't have access to this project's artifacts."
          data-testid="artifact-detail-denied-error"
        />
        <Button variant="outline" onClick={() => navigate('/projects')} data-testid="artifact-detail-denied-back">
          Back to projects
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4" role="main" data-testid="artifact-detail-route">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          icon={<ArrowLeft className="size-4" />}
          onClick={() => navigate(`/projects/${id}/workspace`)}
          data-testid="artifact-detail-back"
        >
          Workspace
        </Button>
        <h1 className="text-base font-semibold">Artifact · {kind}</h1>
      </div>
      {/* The SAME renderer as the inline pane + pop-out window (host owns dispatch). */}
      <WorkbenchProvider api={api} projectId={id} viewId={viewId} canEdit={false}>
        <ArtifactReview runId={runId} data-testid="artifact-detail-review" />
      </WorkbenchProvider>
    </div>
  )
}
