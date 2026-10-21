import { useMemo, useState } from 'react'
import { fallbackParamsFor } from '@/modules/workbench/extensions/analysis/inputEconomy'
import {
  Alert,
  Button,
  Empty,
  Input,
  InputNumber,
  Select,
  Switch,
  Tag,
  message,
} from '@ziee/kit'
import { DatasetDetail } from '@/modules/datasets/stores/DatasetDetail.store'
import { CircleDot, Database, Play, Lock } from 'lucide-react'
import { JobMilestoneSteps } from '@/modules/jobs/components/JobMilestoneSteps'
import { jobStatusLabel } from '@/modules/jobs/components/JobStatusBadge'
import type { AnalysisContribution } from '@/modules/workbench/core'
import type { ParamField } from '@/modules/workbench/core'
import {
  applicableProcessors,
  buildProcessSpec,
  type ProcessorOption,
} from '@/modules/datasets/lib/workbench'

/** A scalar-field editor rendered from the processor's declarative params. */
function FieldEditor({
  field,
  value,
  onChange,
}: {
  field: ParamField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const label = field.title ?? field.id
  const common = (
    <label className="text-sm font-medium" htmlFor={`pipe-field-${field.id}`}>
      {label}
    </label>
  )
  if (field.type === 'number') {
    return (
      <div className="flex flex-col gap-1">
        {common}
        <InputNumber
          id={`pipe-field-${field.id}`}
          value={(value as number | undefined) ?? undefined}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={v => onChange(v)}
          aria-label={label}
          data-testid={`pipe-field-${field.id}`}
        />
        {field.doc ? <span className="text-xs text-muted-foreground">{field.doc}</span> : null}
      </div>
    )
  }
  if (field.type === 'enum') {
    return (
      <div className="flex flex-col gap-1">
        {common}
        <Select
          id={`pipe-field-${field.id}`}
          // ── ITEM-12: what is DISPLAYED and what is SUBMITTED must be the same claim ────────
          //
          // This was `value ?? field.default ?? field.options[0]`. `params` starts `{}` (see
          // `ProcessorForm` — "an empty start is the honest one") and is written ONLY by
          // `onChange`, so an untouched enum field DISPLAYED `options[0]` while
          // `buildProcessSpec` submitted no key for it at all: the user read a value off the
          // form that the run never received, and could not tell that from a value they chose.
          // Which option got displayed was declaration order — `[0]` again, one layer over.
          //
          // The fix is the honest empty: nothing chosen and no declared `default` ⇒ NO
          // selection, so the trigger shows its placeholder and the form displays exactly what
          // it will submit (nothing). The compute owns the fallback at the one boundary a value
          // can legitimately be absent (`params.json`), which is the same reason `params` starts
          // empty.
          //
          // A DECLARED `field.default` is still shown, and still not written into `params` —
          // and those agree, because the value shown is by definition the one the compute
          // applies for an absent key. What is NOT done is auto-writing `options[0]` (or the
          // default) into `params` on mount: that would submit a value the user never chose,
          // which is this same defect facing the other way.
          value={(value as string | undefined) ?? field.default}
          placeholder="Not set"
          onChange={v => onChange(v)}
          options={field.options.map(o => ({ label: o, value: o }))}
          aria-label={label}
          data-testid={`pipe-field-${field.id}`}
        />
        {field.doc ? <span className="text-xs text-muted-foreground">{field.doc}</span> : null}
      </div>
    )
  }
  if (field.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          {common}
          {field.doc ? <span className="text-xs text-muted-foreground">{field.doc}</span> : null}
        </div>
        <Switch
          checked={Boolean(value ?? field.default)}
          onCheckedChange={v => onChange(v)}
          label={label}
          data-testid={`pipe-field-${field.id}`}
        />
      </div>
    )
  }
  if (field.type === 'string') {
    return (
      <div className="flex flex-col gap-1">
        {common}
        <Input
          id={`pipe-field-${field.id}`}
          value={(value as string | undefined) ?? ''}
          onChange={e => onChange(e.target.value)}
          aria-label={label}
          data-testid={`pipe-field-${field.id}`}
        />
        {field.doc ? <span className="text-xs text-muted-foreground">{field.doc}</span> : null}
      </div>
    )
  }
  // Tier-2/3/4 fields (artifact-ref / widget / array) need the project workbench
  // host — not offered on the owner-scoped dataset pipeline.
  return (
    <div className="flex flex-col gap-1">
      {common}
      <span className="text-xs text-muted-foreground">
        This option is only configurable in a project workbench.
      </span>
    </div>
  )
}

/** The parameter form + Run action for a chosen processor. */
function ProcessorForm({
  datasetId,
  contribution,
  onCancel,
}: {
  datasetId: string
  contribution: AnalysisContribution
  onCancel: () => void
}) {
  const { submitting } = DatasetDetail
  // The fallback form's fields — one artifact-ref control per input SLOT, synthesized
  // from `appliesTo` (INV-1: the manifest carries no form schema). Same shim the run
  // pane uses, so the two agree by construction instead of by two similar mappings.
  const fallback = fallbackParamsFor(contribution)
  const schemaFields = 'fields' in fallback ? fallback.fields : []
  // No `defaults` to seed from — the compute owns the fallback at the one boundary a
  // value can be absent (`params.json`), so an empty start is the honest one.
  const [params, setParams] = useState<Record<string, unknown>>(() => ({}))

  const run = async () => {
    try {
      const spec = buildProcessSpec(contribution, params)
      await DatasetDetail.runProcessor(datasetId, spec, {
        name: contribution.title,
        priorityClass: contribution.schedule?.class,
        datasetSlot: 'dataset',
      })
      message.success('Processing started')
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to start processing')
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4" data-testid="pipeline-form">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{contribution.title}</span>
        {contribution.description ? (
          <span className="text-xs text-muted-foreground">{contribution.description}</span>
        ) : null}
      </div>
      {schemaFields.length > 0 ? (
        <div className="flex flex-col gap-3">
          {schemaFields.map(field => (
            <FieldEditor
              key={field.id}
              field={field}
              value={params[field.id]}
              onChange={v => setParams(prev => ({ ...prev, [field.id]: v }))}
            />
          ))}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">This processor has no parameters.</span>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={submitting} data-testid="pipeline-form-cancel">
          Cancel
        </Button>
        <Button onClick={run} loading={submitting} data-testid="pipeline-form-run">
          <Play className="mr-1 size-4" /> Run
        </Button>
      </div>
    </div>
  )
}

/** The live/finished process-job step (logs + terminal status). */
function JobStep() {
  const { processJob, processError } = DatasetDetail
  if (processError && !processJob) {
    return <Alert tone="error" title="Processing failed" description={processError} data-testid="pipeline-job-error" />
  }
  if (!processJob) return null
  const terminal = ['completed', 'failed', 'stopped'].includes(processJob.status)
  const tone = processJob.status === 'failed' || processJob.status === 'stopped' ? 'error' : processJob.status === 'completed' ? 'success' : 'info'
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4" data-testid="pipeline-job">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <CircleDot className={'size-4 ' + (processJob.running ? 'animate-pulse text-info' : 'text-muted-foreground')} aria-hidden />
          {processJob.name}
        </span>
        <Tag tone={tone} variant="soft" data-testid="pipeline-job-status">
          {jobStatusLabel(processJob.status)}
        </Tag>
      </div>
      <JobMilestoneSteps milestones={processJob.milestones} testidPrefix="pipeline-milestone" />
      {processJob.logs.length > 0 ? (
        <pre
          className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs text-muted-foreground"
          data-testid="pipeline-job-logs"
        >
          {processJob.logs.map(l => l.content).join('\n')}
        </pre>
      ) : processJob.running ? (
        <span className="text-xs text-muted-foreground">Waiting for output…</span>
      ) : null}
      {terminal && processJob.status === 'completed' ? (
        <span className="text-xs text-muted-foreground">
          Promote an output to a new dataset from the Lineage tab.
        </span>
      ) : null}
    </div>
  )
}

/**
 * The dataset-detail Pipeline: a vertical step timeline hosting processors,
 * owner-scoped with NO project selector (DEC-5). Offers the processors applicable to
 * the dataset's datatype (P5 registry) — an arch-incompatible one is shown DISABLED
 * with the reason, never hidden (DEC-29). Picking one opens its param form; running
 * enqueues a dataset-scoped analysis job (ITEM-23) whose progress streams below.
 */
export function PipelineTimeline({
  datasetId,
  datatype,
  processorsOverride,
}: {
  datasetId: string
  datatype?: string
  /** Gallery/test seam: render this fixed processor set instead of querying the
   *  live P5 registry (keeps the offline picker/param-form surfaces deterministic
   *  without mutating the shared `workbenchRegistry`). */
  processorsOverride?: ProcessorOption[]
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const processors = useMemo(
    () => processorsOverride ?? applicableProcessors(datatype),
    [processorsOverride, datatype],
  )
  const selected = processors.find(p => p.contribution.id === selectedId)?.contribution ?? null

  return (
    <div className="flex flex-col gap-4" data-testid="pipeline-timeline">
      {/* Dataset root node */}
      <div className="flex items-center gap-2 text-sm">
        <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Database className="size-4" aria-hidden />
        </span>
        <span className="font-medium">Dataset</span>
        {datatype ? <Tag variant="outline" tone="primary" data-testid="pipeline-datatype">{datatype}</Tag> : null}
      </div>

      <div className="ms-3 flex flex-col gap-4 border-s border-border ps-6">
        {/* The running/finished job step (if any) */}
        <JobStep />

        {/* The processor picker OR the active form */}
        {selected ? (
          <ProcessorForm
            datasetId={datasetId}
            contribution={selected}
            onCancel={() => setSelectedId(null)}
          />
        ) : processors.length === 0 ? (
          <Empty
            description={
              datatype
                ? 'No processors apply to this datatype yet'
                : 'This dataset is untyped — no processors to offer'
            }
            data-testid="pipeline-empty"
          />
        ) : (
          <div className="flex flex-col gap-2" data-testid="pipeline-picker">
            <span className="text-xs font-medium text-muted-foreground">Add a processing step</span>
            {processors.map(({ contribution, availability }) => {
              const runnable = availability.runnable
              return (
                <button
                  key={contribution.id}
                  type="button"
                  disabled={!runnable}
                  onClick={() => runnable && setSelectedId(contribution.id)}
                  data-testid={`pipeline-processor-${contribution.id}`}
                  className={
                    'flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-start ' +
                    (runnable
                      ? 'hover:border-primary hover:bg-accent/50'
                      : 'cursor-not-allowed opacity-60')
                  }
                >
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{contribution.title}</span>
                    {contribution.description ? (
                      <span className="text-xs text-muted-foreground">{contribution.description}</span>
                    ) : null}
                  </span>
                  {runnable ? (
                    <Play className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-warning">
                      <Lock className="size-3.5" aria-hidden />
                      {availability.reason}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
