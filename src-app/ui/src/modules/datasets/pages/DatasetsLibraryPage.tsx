import { Link } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Confirm,
  Empty,
  ErrorState,
  Input,
  Pagination,
  Popover,
  Spinner,
  Table,
  Tabs,
  Tag,
  Title,
  Tooltip,
  message,
  type TableColumn,
} from '@txresbench/kit'
import { Datasets } from '@/modules/datasets/stores/Datasets.store'
import { DivScrollY, HeaderBarContainer, useElementMinSize } from '@txresbench/shell'
import { cn } from '@/lib/utils'
import { type Dataset, type DatasetListItem } from '@/api-client/types'
import { ProcessingStatusBadge } from '@/modules/datasets/components/ProcessingStatusBadge'
import {
  CornerDownLeft,
  FolderInput,
  FolderTree,
  Search,
  Share2,
  Trash2,
  Upload as UploadIcon,
} from 'lucide-react'
import { DatatypeBadge } from '@/modules/datasets/components/DatatypeBadge'
import { FolderRail, DATASET_DRAG_KEY } from '@/modules/datasets/components/FolderRail'
import { UploadPanel } from '@/modules/datasets/components/UploadPanel'
import { ShareDialog } from '@/modules/datasets/components/ShareDialog'
import { AttachToProjectDialog } from '@/modules/datasets/components/AttachToProjectDialog'
import { formatDate, shortHash } from '@/modules/datasets/lib/format'

/** Per-row popover to add/remove a dataset from the owner's folders (accessible
 *  companion to drag-to-folder). */
function RowFolderMenu({ dataset }: { dataset: Dataset }) {
  const { folders, folderMembers } = Datasets
  if (folders.length === 0) return null
  const memberOf = folderMembers[dataset.id] ?? []
  const toggle = async (folderId: string) => {
    try {
      if (memberOf.includes(folderId)) await Datasets.removeFromFolder(folderId, dataset.id)
      else await Datasets.addToFolder(folderId, dataset.id)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to update folder')
    }
  }
  return (
    <Popover
      title="Folders"
      content={
        <ul className="flex min-w-40 flex-col gap-0.5" role="list">
          {folders.map(f => {
            const on = memberOf.includes(f.id)
            return (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => void toggle(f.id)}
                  data-testid={`dataset-rowfolder-${dataset.id}-${f.id}`}
                  className={
                    'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-sm ' +
                    (on ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-accent/50')
                  }
                >
                  <span className="truncate">{f.name}</span>
                  {on ? <span className="text-xs text-primary">In folder</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      }
    >
      <Button
        variant="ghost"
        size="icon"
        // ONE string for both channels — the kit adopts a string `tooltip` as the accessible
        // name. A Popover trigger CAN also be a tooltip trigger now that the kit hoists the
        // injected `id` onto Tooltip.Trigger, so the wrapper this used to need is gone. The
        // string names the popover, not one of its actions: the old pair was
        // `aria-label="Folders for X"` + `tooltip="Add to folder"`, a disagreement whose tooltip
        // half was also the weaker one (this popover REMOVES folders too).
        tooltip={`Folders for ${dataset.name}`}
        data-testid={`dataset-row-folders-${dataset.id}`}
      >
        <FolderTree className="size-4" />
      </Button>
    </Popover>
  )
}

/**
 * The top-level dataset library (Variant A "instrument" — DEC-21). Composed like
 * the txresbench `ProjectsPage` (the shared `HeaderBarContainer` top bar over a centered
 * max-width body, states) but scaled to a dense kit `Table` + `Pagination` with a
 * folder rail. Owned ∪ shared (two tabs); folders + search + pagination are applied
 * client-side (the list endpoints return the full owner-scoped set — no server paging).
 */
export function DatasetsLibraryPage() {
  const {
    items,
    total,
    mineTotal,
    sharedTotal,
    tab,
    activeFolderId,
    folderMembers,
    search,
    page,
    pageSize,
    loading,
    error,
    isInitialized,
  } = Datasets

  // Page-width-aware responsive header (mirrors ChatHistoryPage): below `sm` page
  // width — sidebar-open + medium window, or a small window — collapse the header
  // search to an icon that toggles a body search box, and the Upload action to icon-only.
  const pageRef = useRef<HTMLDivElement>(null)
  const isNarrow = useElementMinSize(pageRef).sm
  const [searchOpenInNarrow, setSearchOpenInNarrow] = useState(false)
  useEffect(() => {
    if (!isNarrow) setSearchOpenInNarrow(false)
  }, [isNarrow])

  // Search, folder-filter, and paging are all applied on the SERVER now (see
  // Datasets.store): the page just renders the current page `items` + `total`.
  // `q` is kept only to pick the right empty-state copy.
  const q = search.trim()

  const columns: TableColumn<DatasetListItem>[] = [
    {
      key: 'name',
      title: 'Name',
      rowHeader: true,
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: ds => (
        <span
          draggable
          onDragStart={e => e.dataTransfer.setData(DATASET_DRAG_KEY, ds.id)}
          className="flex items-center gap-1.5"
        >
          <Link
            to={`/datasets/${ds.id}`}
            draggable={false}
            className="truncate font-medium text-foreground hover:underline"
            data-testid={`dataset-row-${ds.id}`}
          >
            {ds.name}
          </Link>
          {ds.source === 'promote' ? (
            <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" aria-label="Promoted from an artifact" />
          ) : null}
          <ProcessingStatusBadge status={ds.processing_status} error={ds.processing_error} />
        </span>
      ),
    },
    { key: 'type', title: 'Type', sorter: (a, b) => (a.datatype ?? '').localeCompare(b.datatype ?? ''), render: ds => <DatatypeBadge datatype={ds.datatype} /> },
    {
      key: 'source',
      title: 'Source',
      sorter: (a, b) => a.source.localeCompare(b.source),
      render: ds => (
        <Tag
          tone={ds.source === 'promote' ? 'info' : 'default'}
          variant="soft"
          data-testid={`dataset-source-${ds.id}`}
        >
          {ds.source}
        </Tag>
      ),
    },
    {
      key: 'hash',
      title: 'Content hash',
      sortable: false,
      render: ds => <span className="font-mono text-xs text-muted-foreground">{shortHash(ds.content_hash)}</span>,
    },
    {
      key: 'updated',
      title: 'Updated',
      sorter: (a, b) => a.updated_at.localeCompare(b.updated_at),
      render: ds => <span className="text-sm text-muted-foreground">{formatDate(ds.updated_at)}</span>,
    },
    {
      key: 'actions',
      title: 'Actions',
      sortable: false,
      render: ds => (
        <div className="flex items-center justify-end gap-0.5">
          {tab === 'mine' ? <RowFolderMenu dataset={ds} /> : null}
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Share ${ds.name}`}
            tooltip="Share"
            onClick={() => Datasets.openShare(ds)}
            data-testid={`dataset-share-${ds.id}`}
          >
            <Share2 className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Attach ${ds.name} to a project`}
            tooltip="Attach to project"
            onClick={() => Datasets.openAttach(ds)}
            data-testid={`dataset-attach-${ds.id}`}
          >
            <FolderInput className="size-4" />
          </Button>
          {tab === 'mine' ? (
            <Confirm
              title={`Delete "${ds.name}"?`}
              // ── ITEM-42 — THE CASCADE IS THE SURPRISING PART, AND IT IS SAID HERE ────
              //
              // `artifacts.dataset_id ON DELETE CASCADE` takes everything COMPUTED ON this
              // dataset with it — every result derived from it. Possibly an
              // hour of compute. That is correct behaviour and it is exactly the kind of
              // correct behaviour a user does not expect, so a generic "are you sure" is not
              // an adequate prompt for it.
              //
              // ── AND THIS SENTENCE IS THE SAME FOR AN INTEGRATED DATASET (INV-3) ──────
              //
              // An integrated dataset is a dataset. There is deliberately NO branch here on
              // whether one is "virtual": the discriminant is a RECIPE the server reads
              // (`structure.gathered_from`) and DEC-8 keeps it below the data plane, so this
              // client cannot see it and must not try. Its cascade is also identical in KIND —
              // it owns no source bytes, so deleting it takes its own derived artifacts and
              // leaves its sources untouched, which is what this sentence already says. A
              // second, virtual-specific sentence would be the UI branch INV-3 forbids.
              //
              // ── THE ENUMERATION WAS REMOVED, AND THE TRADE IS RECORDED ──────────────
              //
              // This sentence used to name three concrete results by their domain names. That
              // is more SALIENT — a named loss lands where a category does not — and it put
              // three domain nouns in a core page, which must carry none of that lattice.
              //
              // Applying the forced-rename test honestly: "every analysis result" is LESS
              // SPECIFIC, which normally makes such a fix suspect. It survives here for a
              // reason particular to this sentence: the enumeration was never exhaustive (it
              // ended "and any other derived results"), so it was always an ILLUSTRATION
              // rather than the claim. The claim — everything derived is destroyed — is
              // unchanged and still exactly true. What is lost is salience, not accuracy, and
              // buying salience with a domain leak in core is the trade this guard exists to
              // refuse. Recorded rather than silently taken.
              //
              // ── NO COUNT, AND THAT IS A DECISION ────────────────────────────────────
              //
              // Naming a NUMBER of derived artifacts would be better, and it is not available:
              // every artifact route is project-scoped (`/projects/{id}/artifacts`) and this is
              // the library, which is not. Rendering "0" or a guess here would be the ITEM-39
              // defect on a strictly more destructive action — a fabricated count in front of a
              // permanent delete reads as a safety clearance. So the copy names WHAT goes and
              // declines to claim HOW MUCH.
              description="This permanently deletes the dataset, its files, and every analysis result computed from it in any project. Datasets it was integrated with are not affected."
              danger
              okText="Delete"
              cancelText="Cancel"
              onConfirm={async () => {
                try {
                  await Datasets.deleteDataset(ds.id)
                  message.success('Dataset deleted')
                } catch (err) {
                  message.error(err instanceof Error ? err.message : 'Failed to delete dataset')
                }
              }}
              data-testid={`dataset-delete-${ds.id}`}
            >
              <Button
                variant="ghost"
                size="icon"
                // ONE string for both channels — see RowFolderMenu above.
                tooltip={`Delete ${ds.name}`}
                data-testid={`dataset-delete-btn-${ds.id}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </Confirm>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div
      ref={pageRef}
      className="flex h-full flex-col overflow-hidden"
      data-testid="datasets-page"
    >
      {/* Page header — standardized on the shared HeaderBarContainer bar. */}
      <HeaderBarContainer>
        <div className="flex h-full w-full items-center justify-between gap-3">
          <Title level={4} className="!m-0 !leading-tight truncate">
            Datasets
          </Title>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            {/* Wide: inline search input (shrinkable). Narrow: an icon toggle that
                opens the body search box below the header. */}
            {!isNarrow ? (
              <Input
                className="flex-[0_1_320px] min-w-[200px]"
                placeholder="Search datasets"
                aria-label="Search datasets"
                prefix={<Search className="size-4" />}
                value={search}
                onChange={e => Datasets.setSearch(e.target.value)}
                data-testid="datasets-search"
              />
            ) : (
              // The false arm said "Search" on hover and "Open search" to assistive tech.
              <Tooltip content={searchOpenInNarrow ? 'Hide search' : 'Open search'}>
                <Button
                  variant={searchOpenInNarrow ? 'default' : 'ghost'}
                  size="icon"
                  icon={<Search className="size-4" />}
                  aria-label={searchOpenInNarrow ? 'Hide search' : 'Open search'}
                  aria-pressed={searchOpenInNarrow}
                  onClick={() => setSearchOpenInNarrow(v => !v)}
                  data-testid="datasets-search-toggle"
                />
              </Tooltip>
            )}
            {isNarrow ? (
              <Button
                size="icon"
                icon={<UploadIcon className="size-4" />}
                tooltip="Upload data"
                aria-label="Upload data"
                onClick={() => Datasets.openUpload()}
                data-testid="datasets-upload-button"
              />
            ) : (
              <Button onClick={() => Datasets.openUpload()} data-testid="datasets-upload-button">
                <UploadIcon className="mr-1 size-4" />
                Upload data
              </Button>
            )}
          </div>
        </div>
      </HeaderBarContainer>

      {/* Page body — scrollable, nativeScroll-aware region below the bar. */}
      {/* Narrow layout: the header search collapses to a toggle that reveals this
          body search box (mirrors ChatHistoryPage's narrow search affordance). */}
      {isNarrow && searchOpenInNarrow ? (
        <div className="mx-auto w-full max-w-6xl px-4 pt-3 sm:px-6">
          <Input
            autoFocus
            className="w-full"
            placeholder="Search datasets"
            aria-label="Search datasets"
            prefix={<Search className="size-4" />}
            value={search}
            onChange={e => Datasets.setSearch(e.target.value)}
            data-testid="datasets-search"
          />
        </div>
      ) : null}

      {/* Body — fills the remaining viewport height; the table scrolls internally
          (wrapped in `DivScrollY` overlay-scroll), while the tabs + pagination stay
          FIXED so the page itself never scrolls no matter how many datasets there are. */}
      <div className="mx-auto flex w-full min-h-0 max-w-6xl flex-1 flex-col p-4 sm:p-6">
        {/* Mine / Shared — quiet underline (line) tabs. The strip's own bottom border is
            the section divider; the active tab's underline sits flush on it (no gap). */}
        <Tabs
          variant="line"
          aria-label="Dataset scope"
          data-testid="datasets-scope"
          value={tab}
          onValueChange={v => Datasets.setTab(v as 'mine' | 'shared')}
          items={[
            { key: 'mine', label: `Mine (${mineTotal})` },
            { key: 'shared', label: `Shared with me (${sharedTotal})` },
          ]}
        />

        {/* Body */}
        {error ? (
          <div className="pt-4">
            <ErrorState resource="datasets" description={error} onRetry={() => void Datasets.load()} data-testid="datasets-error" />
          </div>
        ) : !isInitialized && loading ? (
          <div className="flex flex-1 items-center justify-center" data-testid="datasets-loading">
            <Spinner label="Loading datasets" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 pt-4 sm:flex-row">
            {tab === 'mine' ? <FolderRail /> : null}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              {items.length === 0 ? (
                <div className="flex flex-1 items-center justify-center">
                  <Empty
                    data-testid="datasets-empty"
                    description={
                      q
                        ? 'No datasets match your search'
                        : activeFolderId
                          ? 'This folder is empty'
                          : tab === 'shared'
                            ? 'No datasets shared with you yet'
                            : 'No datasets yet — upload data to get started'
                    }
                  >
                    {!q && tab === 'mine' && !activeFolderId ? (
                      <Button onClick={() => Datasets.openUpload()} data-testid="datasets-empty-upload">
                        <UploadIcon className="mr-1 size-4" />
                        Upload data
                      </Button>
                    ) : null}
                  </Empty>
                </div>
              ) : (
                <>
                  {/* The table area takes the remaining height and scrolls on its
                      own via React overlay scrollbars (OverlayScrollbars) — the page
                      itself never scrolls; the tabs + pager stay fixed. */}
                  <DivScrollY className="min-h-0 flex-1">
                    <Table
                      columns={columns}
                      dataSource={items}
                      rowKey="id"
                      sortable
                      loading={loading}
                      data-testid="datasets-table"
                    />
                  </DivScrollY>
                  {total > pageSize ? (
                    <div className="flex shrink-0 justify-end">
                      <Pagination
                        data-testid="datasets-pagination"
                        current={page}
                        total={total}
                        pageSize={pageSize}
                        onChange={p => Datasets.setPage(p)}
                        showSizeChanger
                        pageSizeOptions={[10, 20, 50]}
                        pageSizeLabel="Page size"
                        onPageSizeChange={s => Datasets.setPageSize(s)}
                        showTotal={(t, [from, to]) => `${from}-${to} of ${t}`}
                        previousLabel="Previous page"
                        nextLabel="Next page"
                        pageLabel={p => `Page ${p}`}
                        aria-label="Datasets pagination"
                      />
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Overlays */}
      <UploadPanel />
      <ShareDialog />
      <AttachToProjectDialog />
    </div>
  )
}
