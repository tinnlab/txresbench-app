import type { ProjectDto } from '@/api-client/types'
import { ProjectCardTagsSlot } from '@/modules/project/core/extensions'

/**
 * Renders the `card_tags` slot for one project card — the seam analysis modules
 * contribute count-tags into (now driven by the `ProjectExtensionRegistry`, which
 * superseded the old `projectCardTags` SDK-slot placeholder). Reactively
 * permission-filtered inside the slot.
 */
export function ProjectCardTags({ project }: { project: ProjectDto }) {
  return <ProjectCardTagsSlot project={project} />
}
