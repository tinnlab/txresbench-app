import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { ProjectAdmin } from '@/modules/project/stores/ProjectAdmin.store'
import { Badge, Button, Confirm, Empty, ErrorState, Spinner, Tag } from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import { useState } from 'react'

const STATUS_TONE: Record<string, 'success' | 'warning' | undefined> = {
  accepted: 'success',
  pending: 'warning',
  declined: undefined,
}

/** Admin drill-down: metadata, owner, every share (with revoke), datasets,
 *  transfer state, and the governance actions (manage-gated). */
export function ProjectAdminDetailDrawer() {
  const { detailId, detail, detailLoading, detailError } = ProjectAdmin
  const canManage = usePermission(Permissions.ProjectAdminManage)
  const [revokeShareId, setRevokeShareId] = useState<string | null>(null)
  const close = () => ProjectAdmin.closeDetail()

  return (
    <Drawer
      title={detail ? detail.project.name : 'Project'}
      open={detailId !== null}
      onClose={close}
      size={560}
    >
      {detailError ? (
        <ErrorState
          resource="project"
          onRetry={() => detailId && ProjectAdmin.openDetail(detailId)}
          data-testid="project-admin-detail-error"
        />
      ) : detailLoading || !detail ? (
        <div className="flex justify-center py-10">
          <Spinner label="Loading project" />
        </div>
      ) : (
        <div className="flex flex-col gap-5" data-testid="project-admin-detail">
          {/* owner */}
          <section>
            <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">Owner</div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium" data-testid="detail-owner-name">
                {detail.owner_display_name || detail.owner_username}
              </span>
              <span className="text-sm text-muted-foreground" data-testid="detail-owner-email">
                {detail.owner_email}
              </span>
              {!detail.owner_is_active && (
                <Badge tone="error" data-testid="detail-owner-inactive">
                  deactivated
                </Badge>
              )}
            </div>
          </section>

          {/* actions (manage-gated) */}
          {canManage && (
            <section className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                data-testid="detail-change-owner"
                onClick={() => ProjectAdmin.openChangeOwner(detail.project.id)}
              >
                Change owner
              </Button>
              <Button
                variant="outline"
                data-testid="detail-share"
                onClick={() => ProjectAdmin.openShare(detail.project.id)}
              >
                Share on behalf
              </Button>
              <Button
                variant="destructive"
                data-testid="detail-delete"
                onClick={() => ProjectAdmin.openDelete(detail.project.id)}
              >
                Delete project
              </Button>
            </section>
          )}

          {/* transfer state */}
          {detail.transfer && (
            <section data-testid="detail-transfer">
              <Tag tone="warning" data-testid="detail-transfer-tag">
                Transfer pending
              </Tag>
            </section>
          )}

          {/* shares */}
          <section>
            <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">
              Shares ({detail.shares.length})
            </div>
            {detail.shares.length === 0 ? (
              <Empty description="Not shared with anyone" data-testid="detail-shares-empty" />
            ) : (
              <div className="flex flex-col divide-y">
                {detail.shares.map(s => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-2 py-2"
                    data-testid={`detail-share-${s.id}`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{s.recipient_username}</div>
                      <div className="truncate text-xs text-muted-foreground">{s.recipient_email}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Tag variant="outline" data-testid={`detail-share-level-${s.id}`}>
                        {s.permission_level}
                      </Tag>
                      <Tag
                        variant="outline"
                        tone={STATUS_TONE[s.status]}
                        data-testid={`detail-share-status-${s.id}`}
                      >
                        {s.status}
                      </Tag>
                      {canManage && (
                        <Button
                          variant="ghost"
                          data-testid={`detail-revoke-${s.id}`}
                          onClick={() => setRevokeShareId(s.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* datasets */}
          <section>
            <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">
              Datasets ({detail.datasets.length})
            </div>
            {detail.datasets.length === 0 ? (
              <Empty description="No datasets" data-testid="detail-datasets-empty" />
            ) : (
              <div className="flex flex-col divide-y">
                {detail.datasets.map(d => (
                  <div key={d.id} className="py-1.5 text-sm" data-testid={`detail-dataset-${d.id}`}>
                    {d.name}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      <Confirm
        open={revokeShareId !== null}
        onOpenChange={o => {
          if (!o) setRevokeShareId(null)
        }}
        title="Revoke this share?"
        description="This share will be removed; if it was accepted, the user loses access to the project."
        danger
        okText="Revoke"
        cancelText="Cancel"
        data-testid="detail-revoke-confirm"
        onConfirm={() => {
          if (revokeShareId && detail) void ProjectAdmin.revokeShare(detail.project.id, revokeShareId)
          setRevokeShareId(null)
        }}
      >
        <button type="button" aria-hidden className="hidden" />
      </Confirm>
    </Drawer>
  )
}
