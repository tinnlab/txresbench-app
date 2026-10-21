import type { ProjectDto } from '@/api-client/types'
import { createContext, useContext, type ReactNode } from 'react'

/**
 * The central project-role / `canEdit` derivation — the FE mirror of the backend
 * `ProjectScope`. Replaces the ad-hoc per-component role derivation (owner/editor/
 * viewer string-compares that had already drifted: some computed `canEdit`,
 * `ProjectFormDrawer` inverted it as `readOnly = viewer`). ONE source now: the
 * server's `ProjectDto.effective_permission`. `canEdit` is DERIVED, never persisted
 * (DEC-9); the authoritative gate is the server 403 (`ProjectScope::require_can_edit`).
 */

/** The three project roles the server projects onto `effective_permission`. */
export type ProjectRole = 'owner' | 'editor' | 'viewer'

export interface ProjectScope {
  role: ProjectRole
  /** Owner|Editor may mutate; a Viewer gets the read-only surface. */
  canEdit: boolean
  isOwner: boolean
  isViewer: boolean
}

/**
 * Narrow the untyped wire `effective_permission: string` to a `ProjectRole`.
 * Unknown/absent → the fail-CLOSED default `viewer`, so a stray value never
 * accidentally grants edit.
 */
export function toProjectRole(perm: string | null | undefined): ProjectRole {
  return perm === 'owner' || perm === 'editor' ? perm : 'viewer'
}

/**
 * Derive the scope from a DTO (or a bare `effective_permission`). The single
 * source both the provider AND per-item consumers (e.g. `ProjectCard`, which holds
 * a per-row DTO, not the detail store) call.
 */
export function deriveProjectScope(
  project: Pick<ProjectDto, 'effective_permission'> | null | undefined,
): ProjectScope {
  const role = toProjectRole(project?.effective_permission)
  return {
    role,
    isOwner: role === 'owner',
    isViewer: role === 'viewer',
    canEdit: role === 'owner' || role === 'editor',
  }
}

/** Non-React predicate for stores (which can't use hooks). */
export function isOwnerRole(perm: string | null | undefined): boolean {
  return toProjectRole(perm) === 'owner'
}

const ProjectScopeContext = createContext<ProjectScope | null>(null)

/**
 * Wrap a project surface so its descendants (detail-panel extensions, action bars)
 * read the role ONCE from the loaded `ProjectDto` instead of re-deriving it. This
 * is the seam the P6 workbench shell + every extension contribution read
 * `canEdit` from — a Viewer gets a fully-rendered but read-only surface.
 */
export function ProjectScopeProvider({
  project,
  children,
}: {
  project: Pick<ProjectDto, 'effective_permission'> | null | undefined
  children: ReactNode
}) {
  const scope = deriveProjectScope(project)
  return <ProjectScopeContext.Provider value={scope}>{children}</ProjectScopeContext.Provider>
}

/**
 * The full scope. Falls back to the fail-CLOSED default (viewer / no edit) when
 * used outside a provider, so a surface never accidentally shows a mutation
 * affordance for lack of context.
 */
export function useProjectScope(): ProjectScope {
  return useContext(ProjectScopeContext) ?? deriveProjectScope(undefined)
}

export function useProjectRole(): ProjectRole {
  return useProjectScope().role
}

/** `true` when the acting user may mutate the project (owner|editor). */
export function useCanEdit(): boolean {
  return useProjectScope().canEdit
}
