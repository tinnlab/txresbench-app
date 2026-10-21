import type { PermissionExpr } from '@/core/permissions'
import type {
  ProjectCardTagContribution,
  ProjectDetailPanelContribution,
  ProjectExtensionRegistration,
  ProjectNavContribution,
} from './types'

type WithExt<T> = T & { extensionName: string }

/**
 * Process-wide registry of project extensions. Name-keyed so an HMR re-register
 * replaces rather than stacks. Per-slot getters return the contributions sorted
 * by `order` (default 100); permission gating is a RENDER-time concern handled by
 * `<ProjectExtensionSlot>` / the sidebar (they read the reactive auth store), so the
 * registry only carries the `permission` through, it never evaluates it.
 */
export class ProjectExtensionRegistry {
  private extensions = new Map<string, ProjectExtensionRegistration>()

  register(registration: ProjectExtensionRegistration): void {
    if (this.extensions.has(registration.name)) {
      // HMR / double-import: replace, don't stack.
      console.warn(`[project] extension "${registration.name}" re-registered; replacing`)
    }
    this.extensions.set(registration.name, registration)
  }

  private collect<T extends { order?: number }>(
    pick: (r: ProjectExtensionRegistration) => T[] | undefined,
  ): Array<WithExt<T>> {
    const out: Array<WithExt<T>> = []
    for (const reg of this.extensions.values()) {
      for (const c of pick(reg) ?? []) out.push({ ...c, extensionName: reg.name })
    }
    return out.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
  }

  navEntries(): Array<WithExt<ProjectNavContribution>> {
    return this.collect(r => r.slots.project_nav)
  }

  detailPanels(): Array<WithExt<ProjectDetailPanelContribution>> {
    return this.collect(r => r.slots.detail_panels)
  }

  cardTags(): Array<WithExt<ProjectCardTagContribution>> {
    return this.collect(r => r.slots.card_tags)
  }
}

export interface PermissionGated {
  permission?: PermissionExpr
}

/** The singleton every consumer's `extension.tsx` registers into at import. */
export const projectExtensionRegistry = new ProjectExtensionRegistry()
