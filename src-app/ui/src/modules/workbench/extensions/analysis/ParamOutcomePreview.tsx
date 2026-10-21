// Param→outcome live-preview strip (ITEM-65) — the honest, pre-submit hint shown below
// the analysis form as the user tweaks a param. An ESTIMATE chip carries a REAL
// number the front end computed cheaply (a cap against the resident input size); a
// DEFERRED chip says "computes on run" with an optional direction arrow from the field's
// own doc — never a fabricated figure. Classification is the pure, unit-tested
// `previewParamOutcomes`.

import { Tag, Tooltip } from '@ziee/kit'
import type { ParamField } from '@/modules/workbench/core'
import { previewParamOutcomes, type ResidentInput } from './paramPreview'

export interface ParamOutcomePreviewProps {
  fields: ParamField[]
  params: Record<string, unknown>
  resident?: ResidentInput
  'data-testid'?: string
}

function arrow(direction: 'up' | 'down' | undefined): string {
  return direction === 'up' ? ' ↑' : direction === 'down' ? ' ↓' : ''
}

export function ParamOutcomePreview({
  fields,
  params,
  resident,
  'data-testid': testid = 'workbench-param-preview',
}: ParamOutcomePreviewProps) {
  const previews = previewParamOutcomes(fields, params, resident)
  if (previews.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testid}>
      <span className="text-xs text-muted-foreground">Outcome preview</span>
      {previews.map(p =>
        p.kind === 'estimate' ? (
          <Tooltip key={p.field} content={p.note}>
            <Tag tone="success" variant="soft" data-testid={`${testid}-estimate-${p.field}`}>
              {p.metric} ≈ {p.value.toLocaleString()}
            </Tag>
          </Tooltip>
        ) : (
          <Tag key={p.field} tone="default" variant="soft" data-testid={`${testid}-deferred-${p.field}`}>
            {p.metric}: {p.reason}
            {arrow(p.direction)}
          </Tag>
        ),
      )}
    </div>
  )
}
