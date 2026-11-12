import { type BatchResult } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { ListPagination } from '@/components/common/ListPagination'
import { usePermission } from '@/core/permissions'
import { ProjectAdmin } from '@/modules/project/stores/ProjectAdmin.store'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Confirm,
  Dropdown,
  Empty,
  ErrorState,
  Input,
  Select,
  Spinner,
  Tag,
  message,
} from '@txresbench/kit'
import { SettingsPageContainer } from '@txresbench/shell'
import { useState } from 'react'

/** Compact date for the last-activity column. */
function activityDate(iso: string): string {
  return iso.slice(0, 10)
}

function batchSummary(res: BatchResult, verb: string): string {
  const ok = res.succeeded.length
  const bad = res.failed.length
  return bad === 0 ? `${verb} ${ok}` : `${verb} ${ok}; ${bad} failed`
}
import { ChangeOwnerDrawer } from '../components/ChangeOwnerDrawer'
import { ReassignOwnerDrawer } from '../components/ReassignOwnerDrawer'
import { ShareOnBehalfDrawer } from '../components/ShareOnBehalfDrawer'
import { ProjectAdminDetailDrawer } from '../components/ProjectAdminDetailDrawer'
import { ProjectDeploymentSettingsCard } from '../components/ProjectDeploymentSettingsCard'

const SORTS = [
  { label: 'Recently updated', value: 'updated' },
  { label: 'Recently created', value: 'created' },
  { label: 'Name (A–Z)', value: 'name' },
  { label: 'Owner (A–Z)', value: 'owner' },
  { label: 'Most datasets', value: 'datasets' },
]
const STATUSES = [
  { label: 'All projects', value: 'all' },
  { label: 'Orphaned (owner deactivated)', value: 'orphaned' },
  { label: 'Shared', value: 'shared' },
  { label: 'Private (unshared)', value: 'private' },
  { label: 'Empty (no datasets)', value: 'empty' },
]

export function ProjectAdminPage() {
  const {
    rows,
    total,
    page,
    pageSize,
    search,
    ownerFilter,
    ownerFilterName,
    statusFilter,
    sort,
    stats,
    loading,
    error,
    isInitialized,
    selectedIds,
    deleteId,
  } = ProjectAdmin
  const canManage = usePermission(Permissions.ProjectAdminManage)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  // Prefer the name captured when the filter was set (survives an empty page,
  // e.g. right after reassign-all empties the owner); fall back to a visible row.
  const filteredOwnerLabel =
    ownerFilterName ?? (ownerFilter ? rows.find(r => r.owner_id === ownerFilter)?.owner_username : null)
  const deleteRow = deleteId ? rows.find(r => r.id === deleteId) : null
  const allOnPageSelected = rows.length > 0 && rows.every(r => selectedIds.includes(r.id))

  const runBulkDelete = async () => {
    setBulkDeleteOpen(false)
    try {
      const res = await ProjectAdmin.batchDelete(selectedIds)
      if (res.failed.length > 0) message.warning(batchSummary(res, 'Deleted'))
      else message.success(batchSummary(res, 'Deleted'))
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Bulk delete failed')
    }
  }
  const runDelete = async () => {
    const id = deleteId
    ProjectAdmin.closeDelete()
    if (!id) return
    try {
      await ProjectAdmin.deleteProject(id)
      message.success('Project deleted')
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <SettingsPageContainer title="Projects" subtitle="All projects across every user — govern ownership, sharing, and cleanup.">
      <div className="flex flex-col gap-4" data-testid="project-admin-page">
        {/* aggregate stats */}
        {stats && (
          <div className="flex flex-wrap gap-4 text-sm" data-testid="project-admin-stats">
            <span>
              <span className="font-semibold">{stats.total_projects}</span> projects
            </span>
            <span>
              <span className="font-semibold">{stats.distinct_owners}</span> owners
            </span>
            <span className={stats.orphaned_count > 0 ? 'text-destructive' : undefined}>
              <span className="font-semibold">{stats.orphaned_count}</span> orphaned
            </span>
          </div>
        )}

        <Card title="Projects" data-testid="project-admin-list-card">
          {/* toolbar */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={e => ProjectAdmin.setSearch(e.target.value)}
              placeholder="Search by name"
              aria-label="Search projects by name"
              className="w-full sm:w-56"
              data-testid="project-admin-search"
            />
            <Select
              value={statusFilter ?? 'all'}
              onValueChange={v => ProjectAdmin.setStatusFilter(v === 'all' ? null : v)}
              options={STATUSES}
              aria-label="Filter projects by status"
              data-testid="project-admin-status-filter"
            />
            <Select
              value={sort}
              onValueChange={v => ProjectAdmin.setSort(v)}
              options={SORTS}
              aria-label="Sort projects"
              data-testid="project-admin-sort"
            />
          </div>

          {/* owner-filter context + offboarding accelerator */}
          {ownerFilter && (
            <div
              className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2"
              data-testid="project-admin-owner-filter"
            >
              <span className="text-sm">
                Filtered to owner{' '}
                <span className="font-medium">{filteredOwnerLabel ?? ownerFilter}</span>
              </span>
              {canManage && (
                <Button
                  variant="outline"
                  data-testid="project-admin-reassign-all"
                  onClick={() =>
                    ProjectAdmin.openReassignAll(ownerFilter, filteredOwnerLabel ?? ownerFilter)
                  }
                >
                  Reassign all their projects…
                </Button>
              )}
              <Button
                variant="ghost"
                data-testid="project-admin-owner-filter-clear"
                onClick={() => ProjectAdmin.setOwnerFilter(null)}
              >
                Clear
              </Button>
            </div>
          )}

          {/* bulk bar */}
          {canManage && selectedIds.length > 0 && (
            <div
              className="mb-3 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
              data-testid="project-admin-bulk-bar"
            >
              <span className="text-sm font-medium">{selectedIds.length} selected</span>
              <Button
                variant="outline"
                data-testid="project-admin-bulk-reassign"
                onClick={() => ProjectAdmin.openReassignBulk(selectedIds)}
              >
                Reassign…
              </Button>
              <Button
                variant="destructive"
                data-testid="project-admin-bulk-delete"
                onClick={() => setBulkDeleteOpen(true)}
              >
                Delete
              </Button>
              <Button
                variant="ghost"
                data-testid="project-admin-bulk-clear"
                onClick={() => ProjectAdmin.clearSelection()}
              >
                Clear
              </Button>
            </div>
          )}

          {/* a post-init load failure keeps the stale rows but must not be silent */}
          {error && isInitialized && (
            <div
              className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="project-admin-load-error"
            >
              Couldn't refresh projects. Showing the last results.
            </div>
          )}

          {/* body */}
          {error && !isInitialized ? (
            <ErrorState
              resource="projects"
              onRetry={() => void ProjectAdmin.load()}
              data-testid="project-admin-error"
            />
          ) : loading && !isInitialized ? (
            <div className="flex justify-center py-10">
              <Spinner label="Loading projects" />
            </div>
          ) : rows.length === 0 ? (
            <Empty description="No projects match" data-testid="project-admin-empty" />
          ) : (
            <div className="flex flex-col divide-y" data-testid="project-admin-rows">
              {canManage && (
                <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={allOnPageSelected}
                    onCheckedChange={() =>
                      allOnPageSelected
                        ? ProjectAdmin.clearSelection()
                        : ProjectAdmin.selectAllOnPage()
                    }
                    aria-label="Select all projects on this page"
                    data-testid="project-admin-select-all"
                  />
                  <span>Select all on page</span>
                </div>
              )}
              {rows.map(r => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 py-2"
                  data-testid={`project-admin-row-${r.id}`}
                >
                  {canManage && (
                    <Checkbox
                      checked={selectedIds.includes(r.id)}
                      onCheckedChange={() => ProjectAdmin.toggleSelect(r.id)}
                      aria-label={`Select ${r.name}`}
                      data-testid={`project-admin-select-${r.id}`}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                      data-testid={`project-admin-name-${r.id}`}
                      onClick={() => ProjectAdmin.openDetail(r.id)}
                    >
                      {r.name}
                    </button>
                    <button
                      type="button"
                      className="block max-w-full truncate text-left text-xs text-muted-foreground hover:underline"
                      data-testid={`project-admin-owner-${r.id}`}
                      onClick={() => ProjectAdmin.setOwnerFilter(r.owner_id, r.owner_username)}
                    >
                      {(r.owner_display_name || r.owner_username) + ' · ' + r.owner_email}
                    </button>
                  </div>

                  <div className="hidden shrink-0 items-center gap-3 text-xs text-muted-foreground md:flex">
                    <span title="datasets" data-testid={`project-admin-datasets-${r.id}`}>
                      {r.dataset_count} ds
                    </span>
                    <span title="shares" data-testid={`project-admin-shares-${r.id}`}>
                      {r.share_count} shared
                    </span>
                    {/* The former "size" column is REMOVED, for two independent reasons.
                        (1) It was never TRUE: it rendered the two legacy size-proxy count
                        fields, and the server pins BOTH to `0::bigint`
                        (`project/repository.rs`, DEC-1 "datasets no longer carry domain
                        counts"), so every project read `0 / 0` — an admin column reporting
                        that every project on the deployment is empty. (2) Its tooltip named
                        the two fixed biological axes, asserting a data model the app is not
                        allowed to know. DEC-M retains those two fields as a WIRE contract
                        (dropping them is a versioned OpenAPI change, not this sweep); it
                        does NOT authorize RENDERING them. Nothing replaces it: the only true
                        size signal the schema carries is `dataset_count`, already shown by
                        the `…-datasets-` column two spans to the left. */}
                    <span title="last activity" data-testid={`project-admin-activity-${r.id}`}>
                      {activityDate(r.last_activity)}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {r.is_orphaned && (
                      <Badge tone="error" data-testid={`project-admin-orphaned-${r.id}`}>
                        orphaned
                      </Badge>
                    )}
                    {r.transfer_pending && (
                      <Tag tone="warning" data-testid={`project-admin-transfer-${r.id}`}>
                        transfer
                      </Tag>
                    )}
                    <Tag variant="outline" data-testid={`project-admin-visibility-${r.id}`}>
                      {r.share_count > 0 ? 'shared' : 'private'}
                    </Tag>
                  </div>

                  {canManage && (
                    <Dropdown
                      data-testid={`project-admin-menu-${r.id}`}
                      items={[
                        { key: 'view', label: 'View details' },
                        { key: 'change-owner', label: 'Change owner' },
                        { key: 'share', label: 'Share on behalf' },
                        { key: 'delete', label: 'Delete', danger: true },
                      ]}
                      onSelect={key => {
                        if (key === 'view') ProjectAdmin.openDetail(r.id)
                        else if (key === 'change-owner') ProjectAdmin.openChangeOwner(r.id)
                        else if (key === 'share') ProjectAdmin.openShare(r.id)
                        else if (key === 'delete') ProjectAdmin.openDelete(r.id)
                      }}
                    >
                      {/* `⋯` is an ICON that happens to be a codepoint, so this row's menu needs
                          hover text as much as any `<svg>` one does — an `aria-label` reaches
                          assistive tech and is rendered by nothing. A NATIVE `title` rather than a
                          kit `<Tooltip>`: this element is ALREADY the Dropdown's trigger, and a
                          tooltip composed onto an existing trigger never opens (and suppresses a
                          correct outer one). Same string in both channels, so the two users of this
                          control are told the same thing. */}
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`Actions for ${r.name}`}
                        title={`Actions for ${r.name}`}
                        className="px-2 text-muted-foreground"
                      >
                        ⋯
                      </div>
                    </Dropdown>
                  )}
                </div>
              ))}
            </div>
          )}

          {total > 0 && (
            <div className="pt-2">
              <ListPagination
                current={page}
                total={total}
                pageSize={pageSize}
                onChange={p => ProjectAdmin.changePage(p)}
                onPageSizeChange={size => ProjectAdmin.changePage(1, size)}
                itemNoun="projects"
                data-testid="project-admin-pagination"
              />
            </div>
          )}
        </Card>

        {/* deployment-wide setting (folded in — DEC-1) */}
        <ProjectDeploymentSettingsCard />
      </div>

      {/* overlays */}
      <ProjectAdminDetailDrawer />
      <ChangeOwnerDrawer />
      <ShareOnBehalfDrawer />
      <ReassignOwnerDrawer />

      <Confirm
        open={deleteId !== null}
        onOpenChange={o => {
          if (!o) ProjectAdmin.closeDelete()
        }}
        title="Delete this project?"
        description={
          'Deletes the project, its shares, dataset links, and any pending transfer. ' +
          'The datasets themselves are NOT deleted (they become unfiled).' +
          (deleteRow && deleteRow.share_count > 0
            ? ` Its ${deleteRow.share_count} share(s) (accepted or pending) will be removed.`
            : '')
        }
        danger
        okText="Delete"
        cancelText="Cancel"
        data-testid="project-admin-delete-confirm"
        onConfirm={() => void runDelete()}
      >
        <button type="button" aria-hidden className="hidden" />
      </Confirm>

      <Confirm
        open={bulkDeleteOpen}
        onOpenChange={o => {
          if (!o) setBulkDeleteOpen(false)
        }}
        title={`Delete ${selectedIds.length} ${selectedIds.length === 1 ? 'project' : 'projects'}?`}
        description="Each project, its shares, dataset links, and pending transfers are removed. The datasets themselves are NOT deleted (they become unfiled). This cannot be undone."
        danger
        okText="Delete all"
        cancelText="Cancel"
        data-testid="project-admin-bulk-delete-confirm"
        onConfirm={() => void runBulkDelete()}
      >
        <button type="button" aria-hidden className="hidden" />
      </Confirm>
    </SettingsPageContainer>
  )
}
