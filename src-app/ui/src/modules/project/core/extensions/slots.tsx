import { Fragment } from 'react'
import type { ProjectDto } from '@/api-client/types'
import { evaluatePermission } from '@/core/permissions'
import { Auth } from '@/modules/auth/Auth.store'
import { projectExtensionRegistry } from './registry'
import type { ProjectNavContribution } from './types'

/**
 * The permission-filtered, ordered `project_nav` entries for the CURRENT auth
 * session. A reactive hook (reads `Auth`), so nav entries appear/disappear
 * as the session/permissions change. Consumed by the sidebar (expanded project) and
 * the detail shell's section nav.
 */
export function useProjectNavEntries(): Array<ProjectNavContribution & { extensionName: string }> {
  const { user, permissions } = Auth
  return projectExtensionRegistry
    .navEntries()
    .filter(e => !e.permission || evaluatePermission(user, permissions, e.permission))
}

/**
 * The permission-filtered, ordered `detail_panels` for the current session.
 */
export function useProjectDetailPanels() {
  const { user, permissions } = Auth
  return projectExtensionRegistry
    .detailPanels()
    .filter(p => !p.permission || evaluatePermission(user, permissions, p.permission))
}

/**
 * Render the `card_tags` slot for one project card — the seam analysis modules
 * contribute count-tags into. Reactively permission-filters each contribution
 * (mirrors the sidebar's `isAllowed`). Renders nothing (a stable container) when
 * empty, so the seam exists before any consumer registers.
 */
export function ProjectCardTagsSlot({ project }: { project: ProjectDto }) {
  const { user, permissions } = Auth
  const tags = projectExtensionRegistry
    .cardTags()
    .filter(c => !c.permission || evaluatePermission(user, permissions, c.permission))

  return (
    <div className="contents" data-testid="project-card-tags">
      {tags.map(c => (
        <Fragment key={`${c.extensionName}:${c.id}`}>{c.render(project)}</Fragment>
      ))}
    </div>
  )
}

/**
 * The active panel's `section`-selection rule (shared by the slot + the
 * full-bleed hook so both resolve the SAME panel): the panel matching `section`,
 * else the first registered.
 */
function activePanel(panels: ReturnType<typeof useProjectDetailPanels>, section: string | undefined) {
  return panels.find(p => p.section === section) ?? panels[0]
}

/**
 * Whether the active detail panel for `section` is `fullBleed` — the page reads
 * this to drop its max-width/padding and yield viewport height (the workbench).
 * Returns `false` when no panel is registered / the active one isn't full-bleed.
 */
export function useActiveDetailPanelIsFullBleed(section: string | undefined): boolean {
  const panels = useProjectDetailPanels()
  if (panels.length === 0) return false
  return activePanel(panels, section)?.fullBleed ?? false
}

/**
 * Render the active detail-page section panel (selected by `section`). Falls back
 * to the first registered panel if `section` is unknown; renders `fallback`
 * (or nothing) when no panels are registered. A `fullBleed` panel gets a
 * height-yielding wrapper (`flex-1 min-h-0`) so it can fill the region; the
 * non-full-bleed path renders with NO wrapper class (byte-identical to before).
 */
export function ProjectDetailPanelSlot({
  section,
  fallback,
}: {
  section: string | undefined
  fallback?: React.ReactNode
}) {
  const panels = useProjectDetailPanels()
  if (panels.length === 0) return fallback ? <>{fallback}</> : null
  const active = activePanel(panels, section)
  const Panel = active.component
  return (
    <div
      data-project-detail-panel={active.section}
      className={active.fullBleed ? 'flex min-h-0 flex-1 flex-col' : undefined}
    >
      <Panel />
    </div>
  )
}
