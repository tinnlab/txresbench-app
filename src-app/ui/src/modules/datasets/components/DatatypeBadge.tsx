import { Tag } from '@ziee/kit'
import { datatypeLabel } from '@/modules/datasets/lib/format'

/** A quiet outline tag naming a dataset's P2 datatype (or "Untyped"). */
export function DatatypeBadge({ datatype }: { datatype?: string }) {
  return (
    <Tag
      variant="outline"
      tone={datatype ? 'primary' : 'default'}
      data-testid="dataset-datatype-badge"
    >
      {datatypeLabel(datatype)}
    </Tag>
  )
}
