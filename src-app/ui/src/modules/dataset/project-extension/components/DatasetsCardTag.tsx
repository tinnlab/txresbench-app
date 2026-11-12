import type { ProjectDto } from '@/api-client/types'
import { Tag } from '@txresbench/kit'
import { Database } from 'lucide-react'

/**
 * The dataset count tag shown on a project card (the first `card_tags` consumer,
 * wiring the former `projectCardTags` placeholder). Reads the already-loaded
 * `dataset_count` off the project — no per-card fetch (DEC-16). Renders nothing
 * for a project with no datasets.
 */
export function DatasetsCardTag({ project }: { project: ProjectDto }) {
  if (!project.dataset_count) return null
  return (
    <Tag variant="outline" data-testid="project-card-dataset-tag">
      <Database className="mr-1 size-3" />
      {project.dataset_count} {project.dataset_count === 1 ? 'dataset' : 'datasets'}
    </Tag>
  )
}
