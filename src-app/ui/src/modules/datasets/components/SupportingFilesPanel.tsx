import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Empty,
  Progress,
  Select,
  Spinner,
  Tag,
  Upload,
  message,
} from '@txresbench/kit'
import { Field, FieldDescription, FieldLabel } from '@txresbench/kit/shadcn/field'
import { DatasetDetail } from '@/modules/datasets/stores/DatasetDetail.store'
import { FileUp, Plus, Table2, X } from 'lucide-react'
import type { DatasetFile } from '@/api-client/types'
import { formatBytes } from '@/modules/datasets/lib/format'
import {
  coverageError,
  declaredAxes,
  formatCoverage,
  integrationStatus,
  isConverted,
  statusPresentation,
  supportingFiles,
} from '@/modules/datasets/lib/supporting'

/**
 * The dataset-detail **Supporting files** section (ITEM-15). Lists every
 * `role='supporting'` file as a status row — queued / integrating / integrated
 * (with `{matched,missing,extra}` coverage read from `integration_summary`) /
 * failed (with the reason) — mirroring LineageView's status-row style. An
 * **Add supporting file** control appears ONLY when the dataset is converted
 * (its primary import completed, so the axis-index the integrate converter needs
 * exists); it opens a small inline form to pick a target AXIS (from the dataset's
 * declared axes) + drop a CSV/TSV, then calls `DatasetDetail.addSupportingFile`.
 */
export function SupportingFilesPanel() {
  const { dataset, datatypes, addingSupporting, addSupportingPct, addSupportingError } =
    DatasetDetail

  // Fetch the datatype catalog once so we can resolve the dataset's declared axes.
  useEffect(() => {
    void DatasetDetail.loadDatatypes()
  }, [])

  const files = supportingFiles(dataset)
  const axes = declaredAxes(dataset, datatypes)
  const converted = isConverted(dataset)
  const canAdd = converted && axes.length > 0

  const [formOpen, setFormOpen] = useState(false)

  if (!dataset) return null

  return (
    <div className="flex flex-col gap-4" data-testid="dataset-supporting">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Supporting files</span>
          <Tag tone="default" variant="soft" data-testid="dataset-supporting-count">
            {files.length}
          </Tag>
        </div>
        {canAdd && !formOpen ? (
          <Button
            variant="outline"
            onClick={() => setFormOpen(true)}
            data-testid="dataset-supporting-add"
          >
            <Plus className="mr-1 size-4" /> Add supporting file
          </Button>
        ) : null}
      </div>

      <p className="text-sm text-muted-foreground">
        Axis-aligned annotation tables (CSV/TSV) folded onto this dataset — each keyed to
        an entity axis and integrated as extra metadata columns.
      </p>

      {/* Add form — only rendered when the dataset is converted (has axes). */}
      {canAdd && formOpen ? (
        <AddSupportingForm
          datasetId={dataset.id}
          axes={axes}
          adding={addingSupporting}
          pct={addSupportingPct}
          error={addSupportingError}
          onDone={() => setFormOpen(false)}
        />
      ) : null}

      {/* Not-yet-converted hint — the axis index the integrator needs isn't ready. */}
      {!converted ? (
        <Alert
          tone="info"
          title="Convert this dataset first"
          description="Supporting annotation tables can be added once the dataset's primary import has completed."
          data-testid="dataset-supporting-not-converted"
        />
      ) : null}

      {/* File rows. */}
      {files.length === 0 ? (
        <Empty
          description="No supporting files yet."
          data-testid="dataset-supporting-empty"
        />
      ) : (
        <div className="flex flex-col gap-2" data-testid="dataset-supporting-rows">
          {files.map(f => (
            <SupportingRow key={f.file_id} file={f} />
          ))}
        </div>
      )}
    </div>
  )
}

/** One supporting-file status row (mirrors LineageView's run/output rows). */
function SupportingRow({ file }: { file: DatasetFile }) {
  const status = integrationStatus(file)
  const { tone, label } = statusPresentation(status)
  const coverage = formatCoverage(file.integration_summary)
  const reason = coverageError(file.integration_summary)

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`dataset-supporting-row-${file.file_id}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Table2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{file.filename}</span>
          <span className="text-xs text-muted-foreground">
            {formatBytes(file.file_size)}
            {file.kind ? ` · ${file.kind}` : ''}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 sm:justify-end">
        {status === 'running' ? <Spinner size="sm" label="Integrating" /> : null}
        {status === 'integrated' && coverage ? (
          <span
            className="text-xs text-muted-foreground"
            data-testid={`dataset-supporting-coverage-${file.file_id}`}
          >
            {coverage}
          </span>
        ) : null}
        {status === 'failed' && reason ? (
          <span
            className="text-xs text-destructive"
            data-testid={`dataset-supporting-reason-${file.file_id}`}
          >
            {reason}
          </span>
        ) : null}
        <Tag tone={tone} variant="soft" data-testid={`dataset-supporting-status-${file.file_id}`}>
          {label}
        </Tag>
      </div>
    </div>
  )
}

/** The inline add-supporting-file form: an axis picker + a CSV/TSV dropzone. */
function AddSupportingForm({
  datasetId,
  axes,
  adding,
  pct,
  error,
  onDone,
}: {
  datasetId: string
  axes: { name: string; key_label: string }[]
  adding: boolean
  pct: number
  error: string | null
  onDone: () => void
}) {
  const [axis, setAxis] = useState(axes.length === 1 ? axes[0].name : '')
  const [file, setFile] = useState<File | null>(null)

  const ready = axis !== '' && file != null

  const submit = async () => {
    if (!ready || !file) return
    try {
      await DatasetDetail.addSupportingFile(datasetId, { file, axis })
      message.success('Supporting file added — integration started')
      setFile(null)
      onDone()
    } catch {
      /* the inline Alert (addSupportingError) surfaces the failure */
    }
  }

  return (
    <div
      className="flex flex-col gap-4 rounded-md border border-border bg-card p-4"
      data-testid="dataset-supporting-form"
    >
      <Field>
        <FieldLabel htmlFor="dataset-supporting-axis">Target axis</FieldLabel>
        <Select
          id="dataset-supporting-axis"
          data-testid="dataset-supporting-axis"
          value={axis}
          onChange={setAxis}
          placeholder="Choose the axis this table annotates…"
          options={axes.map(a => ({
            label: `${axisLabel(a.name)} (keyed by ${a.key_label})`,
            value: a.name,
          }))}
        />
        <FieldDescription>
          The table's key column is matched against this axis's entity ids.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel>Annotation table (CSV/TSV)</FieldLabel>
        {file ? (
          <div
            className="flex items-center justify-between gap-2 rounded-md bg-background px-3 py-1.5 text-sm"
            data-testid="dataset-supporting-file"
          >
            <span className="truncate">{file.name}</span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {formatBytes(file.size)}
              {!adding ? (
                <Button
                  variant="ghost"
                  size="icon"
                  tooltip={`Remove ${file.name}`}
                  onClick={() => setFile(null)}
                  data-testid="dataset-supporting-file-remove"
                >
                  <X className="size-4" />
                </Button>
              ) : null}
            </span>
          </div>
        ) : (
          <Upload
            onFiles={picked => {
              const f = picked[0]
              if (f) setFile(f)
            }}
            accept=".csv,.tsv,.txt"
            disabled={adding}
            label="Drop a CSV/TSV or click to browse"
            data-testid="dataset-supporting-file-input"
          >
            <div className="flex flex-col items-center gap-1.5 text-center">
              <FileUp className="size-5 text-muted-foreground" aria-hidden />
              <span className="text-sm font-medium">Drop a CSV/TSV or click to browse</span>
              <span className="text-xs text-muted-foreground">
                A keyed table of attribute columns.
              </span>
            </div>
          </Upload>
        )}
      </Field>

      {adding ? (
        <Progress value={pct} aria-label="Upload progress" data-testid="dataset-supporting-progress" showInfo />
      ) : null}

      {error ? (
        <Alert
          tone="error"
          title="Failed to add supporting file"
          description={error}
          data-testid="dataset-supporting-error"
        />
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone} disabled={adding} data-testid="dataset-supporting-cancel">
          Cancel
        </Button>
        <Button onClick={submit} loading={adding} disabled={!ready} data-testid="dataset-supporting-submit">
          {adding ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </div>
  )
}

/** A friendly title-case label for an axis name (`cells` → `Cells`). */
function axisLabel(name: string): string {
  return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name
}
