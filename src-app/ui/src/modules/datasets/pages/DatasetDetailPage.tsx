import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Descriptions,
  ErrorState,
  Input,
  Spinner,
  Table,
  Tabs,
  Title,
  Tooltip,
  message,
  type TableColumn,
} from '@ziee/kit'
import { DatasetDetail } from '@/modules/datasets/stores/DatasetDetail.store'
import { Datasets } from '@/modules/datasets/stores/Datasets.store'
import { DivScrollY, HeaderBarContainer, useElementMinSize } from '@ziee/shell'
import { type DatasetFile } from '@/api-client/types'
import { ArrowLeft, Check, FolderInput, Pencil, Share2, X } from 'lucide-react'
import { LineageView } from '@/modules/datasets/components/LineageView'
import { SupportingFilesPanel } from '@/modules/datasets/components/SupportingFilesPanel'
import { ProcessingStatusBadge } from '@/modules/datasets/components/ProcessingStatusBadge'
import { ShareDialog } from '@/modules/datasets/components/ShareDialog'
import { AttachToProjectDialog } from '@/modules/datasets/components/AttachToProjectDialog'
import { formatBytes, formatDate, shortHash } from '@/modules/datasets/lib/format'
import { useActiveContext } from '@/core/actions/activeContext'
import { useAction } from '@/core/actions/useAction'

const fileColumns: TableColumn<DatasetFile>[] = [
  { key: 'filename', title: 'File', rowHeader: true, render: f => <span className="font-medium">{f.filename}</span> },
  { key: 'ordinal', title: '#', numeric: true, render: f => <span className="text-sm text-muted-foreground">{f.ordinal}</span> },
  { key: 'size', title: 'Size', numeric: true, render: f => <span className="text-sm text-muted-foreground">{formatBytes(f.file_size)}</span> },
]

/**
 * The dataset-detail workspace: a back-topped header + Contents · Lineage tabs.
 * Contents inspects the dataset's files + metadata; Lineage shows the forward
 * provenance graph with Promote. (Processing lives in the workbench/analysis flow,
 * not here — the inline "Pipeline" tab was removed.) Mirrors the ziee
 * `ProjectDetailPage` shell composition.
 */
export function DatasetDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { dataset, loading, error, tab } = DatasetDetail
  // Page-width-aware responsive header (mirrors ChatHistoryPage / the datasets library).
  const pageRef = useRef<HTMLDivElement>(null)
  const isNarrow = useElementMinSize(pageRef).sm
  // Inline rename of the dataset name (item 4).
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  // Stable `view_id` for this dataset detail as an AI-drivable instance
  // (never reused across mounts — PLAN.md ITEM-6 / ARCHITECTURE.md Layer 4).
  const [datasetViewId] = useState(() => crypto.randomUUID())

  const commitRename = async () => {
    if (!dataset) return
    const name = nameDraft.trim()
    if (!name || name === dataset.name) {
      setEditingName(false)
      return
    }
    try {
      await Datasets.renameDataset(dataset.id, name)
      await DatasetDetail.loadDataset(dataset.id)
      setEditingName(false)
      message.success('Dataset renamed')
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to rename dataset')
    }
  }

  useEffect(() => {
    if (id) void DatasetDetail.loadDataset(id)
  }, [id])

  const datasetId = dataset?.id ?? ''

  // PLAN.md ITEM-2/6: while this page is mounted, declare the `'dataset'`
  // context ACTIVE (carrying the focused dataset id) AND register this page as
  // the live `'dataset'` instance. Together they make `dataset.process`
  // (`context:'dataset'`, `kind:'instance'`) offerable in ⌘K + invokable by the
  // AI HERE — its `run` delegates to this instance's handler, which wraps the
  // EXISTING `DatasetDetail.runProcessor` → `ApiClient.Dataset.process`.
  // Both hooks run unconditionally (hooks rule), BEFORE the early returns below.
  useActiveContext('dataset', { entityId: datasetId || undefined })
  useAction(datasetViewId, {
    type: 'dataset',
    handlers: {
      'dataset.process': params =>
        DatasetDetail.runProcessor(datasetId, (params as { spec?: unknown }).spec),
    },
    getSnapshot: () => ({ datasetId }),
  })

  if (error) {
    return (
      <div className="p-6">
        <ErrorState
          resource="dataset"
          description={error}
          onRetry={() => id && DatasetDetail.loadDataset(id)}
          data-testid="dataset-detail-error"
        />
      </div>
    )
  }
  if (loading && !dataset) {
    return (
      <div className="flex justify-center py-16" data-testid="dataset-detail-loading">
        <Spinner label="Loading dataset" />
      </div>
    )
  }
  if (!dataset) return null

  const metadataText = (() => {
    try {
      return dataset.metadata && Object.keys(dataset.metadata as object).length > 0
        ? JSON.stringify(dataset.metadata, null, 2)
        : null
    } catch {
      return null
    }
  })()

  return (
    <div
      ref={pageRef}
      className="flex h-full flex-col overflow-hidden"
      data-testid="dataset-detail-page"
    >
      {/* Page header — back + editable name + actions, on the shared HeaderBarContainer bar. */}
      <HeaderBarContainer>
        <div className="flex h-full w-full items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              icon={<ArrowLeft className="size-4" />}
              tooltip="Back to datasets"
              aria-label="Back to datasets"
              onClick={() => navigate('/datasets')}
              data-testid="dataset-detail-back"
            />
            {editingName ? (
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <Input
                  autoFocus
                  className="h-8 max-w-[420px]"
                  value={nameDraft}
                  aria-label="Dataset name"
                  data-testid="dataset-detail-name-input"
                  onChange={e => setNameDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') setEditingName(false)
                  }}
                />
                <Button variant="ghost" size="icon" aria-label="Save name" tooltip="Save" icon={<Check className="size-4" />} onClick={() => void commitRename()} data-testid="dataset-detail-name-save" />
                <Button variant="ghost" size="icon" aria-label="Cancel rename" tooltip="Cancel" icon={<X className="size-4" />} onClick={() => setEditingName(false)} data-testid="dataset-detail-name-cancel" />
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-1">
                <Title level={4} className="!m-0 !leading-tight truncate" data-testid="dataset-detail-name">
                  {dataset.name}
                </Title>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label="Rename dataset"
                  tooltip="Rename"
                  data-testid="dataset-detail-rename"
                  icon={<Pencil className="size-4" />}
                  onClick={() => {
                    setNameDraft(dataset.name)
                    setEditingName(true)
                  }}
                />
                <ProcessingStatusBadge
                  status={dataset.processing_status}
                  error={dataset.processing_error}
                  showCompleted
                />
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isNarrow ? (
              <>
                <Button variant="outline" size="icon" tooltip="Share" aria-label="Share" icon={<Share2 className="size-4" />} onClick={() => Datasets.openShare(dataset)} data-testid="dataset-detail-share" />
                <Button variant="outline" size="icon" tooltip="Attach to project" aria-label="Attach to project" icon={<FolderInput className="size-4" />} onClick={() => Datasets.openAttach(dataset)} data-testid="dataset-detail-attach" />
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => Datasets.openShare(dataset)} data-testid="dataset-detail-share">
                  <Share2 className="mr-1 size-4" /> Share
                </Button>
                <Button variant="outline" onClick={() => Datasets.openAttach(dataset)} data-testid="dataset-detail-attach">
                  <FolderInput className="mr-1 size-4" /> Attach to project
                </Button>
              </>
            )}
          </div>
        </div>
      </HeaderBarContainer>

      {/* Page body — React overlay-scroll region below the bar. */}
      <DivScrollY className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
          {/* A failed PRIMARY processing job (the dataset's on-ingest converter run)
              surfaces here with its reason, so the failure is unmissable — not just a
              small header badge. */}
          {dataset.processing_status === 'failed' ? (
            <Alert
              tone="error"
              title="Processing failed"
              description={
                dataset.processing_error ??
                'The conversion job for this dataset failed. Check the Lineage tab for details.'
              }
              data-testid="dataset-processing-failed"
            />
          ) : null}
          <Tabs
            variant="line"
            value={tab}
            onValueChange={t => DatasetDetail.setTab(t as 'contents' | 'supporting' | 'lineage')}
            data-testid="dataset-detail-tabs"
            items={[
              {
                key: 'contents',
                label: 'Contents',
                children: (
                  <div className="flex flex-col gap-4 pt-2" data-testid="dataset-tab-contents">
                    <Descriptions
                      data-testid="dataset-contents-info"
                      column={2}
                      items={[
                        { key: 'datatype', label: 'Datatype', children: dataset.datatype ?? 'Untyped' },
                        { key: 'source', label: 'Source', children: dataset.source },
                        { key: 'files', label: 'Files', children: String(dataset.files.length) },
                        { key: 'hash', label: 'Content hash', children: shortHash(dataset.content_hash) },
                        { key: 'created', label: 'Created', children: formatDate(dataset.created_at) },
                        { key: 'updated', label: 'Updated', children: formatDate(dataset.updated_at) },
                      ]}
                    />
                    {dataset.files.length > 0 ? (
                      <Table columns={fileColumns} dataSource={dataset.files} rowKey="file_id" data-testid="dataset-files-table" />
                    ) : (
                      <p className="text-sm text-muted-foreground">This dataset has no files yet.</p>
                    )}
                    {metadataText ? (
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">Metadata</span>
                        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs" data-testid="dataset-metadata">
                          {metadataText}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ),
              },
              {
                key: 'supporting',
                label: 'Supporting files',
                children: (
                  <div className="pt-2" data-testid="dataset-tab-supporting">
                    <SupportingFilesPanel />
                  </div>
                ),
              },
              {
                key: 'lineage',
                label: 'Lineage',
                children: (
                  <div className="pt-2" data-testid="dataset-tab-lineage">
                    <LineageView datasetName={dataset.name} />
                  </div>
                ),
              },
            ]}
          />
        </div>
      </DivScrollY>

      {/* Overlays (shared with the library; read the Datasets store targets) */}
      <ShareDialog />
      <AttachToProjectDialog />
    </div>
  )
}
