import type { ProjectDto } from '@/api-client/types'
import { isDesktop } from '@/core/platform'
import { deriveProjectScope } from '@/modules/project/context/ProjectScope'
import { ProjectDrawer } from '@/modules/project/stores/ProjectDrawer.store'
import { Projects } from '@/modules/project/stores/Projects.store'
import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'
import { ProjectSettings } from '@/modules/project/stores/ProjectSettings.store'
import { Card, Confirm, Dropdown, Tag, Text, Tooltip } from '@txresbench/kit'
import { MoreVertical } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ProjectCardTags } from './ProjectCardTags'

const PERM_TONE: Record<string, 'success' | 'warning' | undefined> = {
  owner: 'success',
  editor: 'warning',
  viewer: undefined,
}

export function ProjectCard({ project }: { project: ProjectDto }) {
  const navigate = useNavigate()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { isOwner, canEdit } = deriveProjectScope(project)
  // Sharing + transfer are WEB-ONLY (desktop is single-user) and owner-only.
  const web = !isDesktop()
  const transferEnabled = ProjectSettings.settings?.transfer_enabled ?? true

  const items = [
    { key: 'open', label: 'Open' },
    ...(canEdit ? [{ key: 'edit', label: 'Edit' }] : []),
    { key: 'duplicate', label: 'Duplicate' },
    ...(isOwner && web ? [{ key: 'share', label: 'Share' }] : []),
    ...(isOwner && web && transferEnabled
      ? [{ key: 'transfer', label: 'Transfer ownership' }]
      : []),
    ...(isOwner
      ? [{ key: 'delete', label: 'Delete', danger: true }]
      : []),
  ]

  const onSelect = (key: string) => {
    switch (key) {
      case 'open':
        navigate(`/projects/${project.id}`)
        break
      case 'edit':
        ProjectDrawer.openEdit(project)
        break
      case 'duplicate':
        void Projects.duplicateProject(project.id)
        break
      case 'share':
        ProjectDetail.loadProject(project.id)
        ProjectDrawer.openShare()
        break
      case 'transfer':
        ProjectDetail.loadProject(project.id)
        ProjectDrawer.openTransfer()
        break
      case 'delete':
        setConfirmDelete(true)
        break
    }
  }

  return (
    <Card
      hoverable
      // `relative` anchors the title's stretched-link `::after` (below) so the WHOLE card is the
      // click target for opening the project, while the actions menu stays clickable via `z-10`.
      className="relative"
      data-testid={`project-card-${project.id}`}
      title={
        // Stretched-link pattern: a real keyboard-accessible link (Tab-focusable, Enter/Space
        // navigates) whose `after:absolute after:inset-0` overlay covers the whole card — so a
        // POINTER click anywhere on the card opens the project, with no whole-card div onClick
        // (keyboard-reachable) and no portaled-dialog click bubbling to navigate (the delete
        // dialog is portaled OUTSIDE the card, so it never overlaps the `::after`).
        <button
          type="button"
          className="min-w-0 truncate text-left !font-normal !text-sm hover:underline after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          onClick={() => navigate(`/projects/${project.id}`)}
          data-testid="project-card-title"
        >
          {project.name}
        </button>
      }
      extra={
        <Dropdown items={items} onSelect={onSelect} data-testid={`project-card-menu-${project.id}`}>
          {/* Plain role=button trigger (Base UI injects aria-* onto it). `relative z-10` lifts it
              ABOVE the title's stretched `::after` so the menu is clickable, not the card link.
              The <Tooltip> composes INSIDE the Dropdown trigger — its Slot forwards the props
              Base UI injects straight through to the div, so one element is both the menu
              trigger and the tooltip trigger. That composition was STAMPED but dead until the
              kit started hoisting the injected `id` onto Tooltip.Trigger (kit/tooltip.tsx): the
              Dropdown's `id` won the DOM node while the tooltip stayed registered under one
              nothing carried, so hovering opened nothing on a surface the behavioural sweep does
              not visit. Three dots say nothing about WHOSE actions on a wall of identical cards. */}
          <Tooltip content="Project actions">
            <div
              role="button"
              tabIndex={0}
              aria-label="Project actions"
              className="relative z-10 inline-flex size-8 items-center justify-center rounded-md hover:bg-accent"
            >
              <MoreVertical className="size-4" />
            </div>
          </Tooltip>
        </Dropdown>
      }
    >
      <div className="flex flex-col gap-2">
        {project.description ? (
          <Text className="line-clamp-2 text-sm text-muted-foreground">
            {project.description}
          </Text>
        ) : (
          <Text className="text-sm text-muted-foreground italic">No description</Text>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <Tag
            variant="outline"
            tone={PERM_TONE[project.effective_permission]}
            data-testid="project-permission-badge"
          >
            {project.effective_permission}
          </Tag>
          {/* The dataset count is now contributed by the dataset project-extension
              through the card_tags slot (single source — no duplicate Tag). */}
          <ProjectCardTags project={project} />
        </div>
      </div>
      <Confirm
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete project?"
        description={`"${project.name}" and its dataset groupings will be permanently removed.`}
        danger
        okText="Delete"
        cancelText="Cancel"
        data-testid={`project-delete-confirm-${project.id}`}
        onConfirm={() => {
          void Projects.deleteProject(project.id)
          setConfirmDelete(false)
        }}
      >
        {/* Real hidden <button>: Base UI's AlertDialogTrigger expects a native
            button (nativeButton) — a <span> triggers a console warning. */}
        <button type="button" aria-hidden className="hidden" data-testid={`project-delete-anchor-${project.id}`} />
      </Confirm>
    </Card>
  )
}
