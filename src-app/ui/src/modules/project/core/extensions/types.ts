import type { ComponentType, ReactNode } from 'react'
import type { ProjectDto } from '@/api-client/types'
import type { PermissionExpr } from '@/core/permissions'
import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'

/**
 * The project-extension slot registry — the FRONTEND seam by which future project
 * sub-modules (samples, upload, clustering, embedding, visualization, …) add
 * themselves to a project without the project module importing any of them. Mirrors
 * ziee's `projects/core/extensions` pattern; the slot NAMES are project-specific.
 */
export const PROJECT_SLOTS = {
  /**
   * A per-project navigation entry shown in the expanded recent-projects sidebar
   * (and the project detail shell's section nav). `section` keys the URL
   * `/projects/:id/:section` and the matching `detail_panels` entry.
   */
  project_nav: { description: 'Per-project navigation entry (sidebar + detail shell)' },
  /**
   * A section panel rendered on the project detail page, selected by the URL
   * `:section`. Zero-prop — reads `ProjectDetail` like ziee project panels.
   */
  detail_panels: { description: 'A section panel on the project detail page' },
  /**
   * A tag rendered on the project CARD (wires the former `projectCardTags`
   * placeholder). Rendered per-project across the list, so it takes the project.
   */
  card_tags: { description: 'A tag on a project card' },
} as const

export type ProjectSlotName = keyof typeof PROJECT_SLOTS

/** A per-project nav entry (sidebar sub-item + detail-shell section tab). */
export interface ProjectNavContribution {
  id: string
  /** URL section key: `/projects/:id/:section` and the matching detail panel. */
  section: string
  label: string
  icon?: ReactNode
  /** Optional right-aligned badge (e.g. a count) rendered from the project. */
  badge?: (project: ProjectDto) => ReactNode
  permission?: PermissionExpr
  order?: number
}

/** A detail-page section panel (zero-prop; reads `ProjectDetail`). */
export interface ProjectDetailPanelContribution {
  id: string
  /** Must match a `project_nav` entry's `section`. */
  section: string
  component: ComponentType
  permission?: PermissionExpr
  order?: number
  /**
   * Full-bleed section — the panel owns the ENTIRE viewport. The shell drops its
   * max-width + padding AND renders no chrome at all: no header bar, no project
   * name / permission badge, no Edit/Share/Transfer actions, no section nav
   * (`ProjectDetailPage`'s `fullBleed` early return emits only the panel + drawers).
   *
   * A full-bleed panel is therefore responsible for surfacing project identity and
   * any actions it needs, itself — the workbench does this in its own
   * `WorkbenchShell` header (`workbench-project-name`), and project-level actions
   * live on the projects-list card ⋮ menu (`ProjectCard`).
   */
  fullBleed?: boolean
}

/** A project-card tag (rendered per project). */
export interface ProjectCardTagContribution {
  id: string
  render: (project: ProjectDto) => ReactNode
  permission?: PermissionExpr
  order?: number
}

/** Slot-name → contribution type. */
export interface ProjectSlotContributions {
  project_nav: ProjectNavContribution
  detail_panels: ProjectDetailPanelContribution
  card_tags: ProjectCardTagContribution
}

/** What a consumer passes to `projectExtensionRegistry.register`. */
export interface ProjectExtensionRegistration {
  name: string
  slots: Partial<{ [K in ProjectSlotName]: ProjectSlotContributions[K][] }>
}
