import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'
import { Button, Card, Confirm, Empty, Tag } from '@ziee/kit'
import { useState } from 'react'

const STATUS_TONE: Record<string, 'success' | 'warning' | undefined> = {
  accepted: 'success',
  pending: 'warning',
  declined: undefined,
}

/**
 * Owner-only "Shared with" list: recipients + status + revoke.
 *
 * Rendered inside `ProjectShareDrawer` (reached from the projects-list card ⋮ menu →
 * "Share"). It USED to live on the project detail page, but `a7c75ef1` made every project
 * URL the full-bleed workbench, whose early return renders neither the header nor this
 * panel — so from that commit until now an owner had NO reachable way to see who a project
 * was shared with, or to revoke a share (`ProjectDetail.revokeShare` had exactly one
 * caller: this component, unreachable). The invite drawer was invite-ONLY. Moving the list
 * into that drawer restores management on the surface the new IA already routes "Share" to.
 *
 * No `extra` Share button any more — the drawer this renders in IS the share surface, so
 * that button would have re-opened its own container.
 */
export function ProjectSharePanel() {
  const { shares } = ProjectDetail
  const [revokeId, setRevokeId] = useState<string | null>(null)

  return (
    <Card title="Shared with" data-testid="project-share-panel">
      {shares.length === 0 ? (
        <Empty description="Not shared with anyone yet" data-testid="project-share-empty" />
      ) : (
        <div className="flex flex-col divide-y">
          {shares.map(s => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-2 py-2"
              data-testid={`project-share-row-${s.id}`}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{s.recipient_username}</div>
                <div className="truncate text-xs text-muted-foreground">{s.recipient_email}</div>
              </div>
              <div className="flex items-center gap-2">
                <Tag variant="outline" data-testid={`project-share-level-${s.id}`}>
                  {s.permission_level}
                </Tag>
                <Tag
                  variant="outline"
                  tone={STATUS_TONE[s.status]}
                  data-testid={`project-share-status-${s.id}`}
                >
                  {s.status}
                </Tag>
                <Button
                  variant="ghost"
                  data-testid={`project-share-revoke-${s.id}`}
                  onClick={() => setRevokeId(s.id)}
                >
                  Revoke
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Confirm
        open={revokeId !== null}
        onOpenChange={o => {
          if (!o) setRevokeId(null)
        }}
        title="Revoke access?"
        description="This user will lose access to the project."
        danger
        okText="Revoke"
        cancelText="Cancel"
        data-testid="project-share-revoke-confirm"
        onConfirm={() => {
          if (revokeId) void ProjectDetail.revokeShare(revokeId)
          setRevokeId(null)
        }}
      >
        <button type="button" aria-hidden className="hidden" />
      </Confirm>
    </Card>
  )
}
