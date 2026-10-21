import { useState } from 'react'
import { z } from 'zod'
import {
  Button,
  Confirm,
  Dialog,
  Form,
  FormField,
  Input,
  message,
  useForm,
  zodResolver,
} from '@ziee/kit'
import { Datasets } from '@/modules/datasets/stores/Datasets.store'
import { Folder, FolderPlus, Layers, Trash2 } from 'lucide-react'

/** The MIME-ish key the draggable dataset rows carry. */
export const DATASET_DRAG_KEY = 'text/dataset-id'

const folderSchema = z.object({ name: z.string().min(1, 'Name the folder').max(120) })
type FolderValues = z.infer<typeof folderSchema>

function FolderCreateDialog() {
  const { folderCreateOpen, mutating } = Datasets
  const form = useForm<FolderValues>({ resolver: zodResolver(folderSchema), defaultValues: { name: '' } })
  const close = () => {
    Datasets.closeFolderCreate()
    form.reset({ name: '' })
  }
  const onSubmit = async (values: FolderValues) => {
    try {
      await Datasets.createFolder(values.name.trim())
      message.success('Folder created')
      close()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to create folder')
    }
  }
  return (
    <Dialog
      open={folderCreateOpen}
      onOpenChange={o => {
        if (!o) close()
      }}
      title="New folder"
      description="Folders are a private label over your datasets."
      data-testid="dataset-folder-dialog"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={mutating} data-testid="dataset-folder-cancel">
            Cancel
          </Button>
          <Button type="submit" form="dataset-folder-form" loading={mutating} data-testid="dataset-folder-submit">
            Create
          </Button>
        </div>
      }
    >
      <Form name="dataset-folder-form" form={form} layout="vertical" onSubmit={onSubmit} data-testid="dataset-folder-form">
        <FormField name="name" label="Folder name" required>
          {/* Domain-neutral: folders are documented as a private, datatype-agnostic label
              over datasets, so the example must not name one domain (was "e.g. PBMC atlas"). */}
          <Input placeholder="e.g. Q3 batch" data-testid="dataset-folder-name" />
        </FormField>
      </Form>
    </Dialog>
  )
}

/**
 * The owner-scoped folder rail (DEC-22): filter-by-folder + drop-to-add. Each
 * folder is a filter toggle AND a drop target (drag a dataset row onto it to add
 * it). "All datasets" clears the filter. Folders are a label view — no lineage
 * impact; deleting one only drops the label layer.
 */
export function FolderRail() {
  const { folders, activeFolderId, folderMembers } = Datasets
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const countFor = (folderId: string) =>
    Object.values(folderMembers).filter(ids => ids.includes(folderId)).length

  const onDrop = async (folderId: string, e: React.DragEvent) => {
    e.preventDefault()
    setDropTarget(null)
    const datasetId = e.dataTransfer.getData(DATASET_DRAG_KEY)
    if (!datasetId) return
    if (folderMembers[datasetId]?.includes(folderId)) return
    try {
      await Datasets.addToFolder(folderId, datasetId)
      message.success('Added to folder')
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to add to folder')
    }
  }

  return (
    <nav className="flex w-52 shrink-0 flex-col gap-1" aria-label="Dataset folders" data-testid="dataset-folder-rail">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-muted-foreground">Folders</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="New folder"
          tooltip="New folder"
          onClick={() => Datasets.openFolderCreate()}
          data-testid="dataset-folder-new"
        >
          <FolderPlus className="size-4" />
        </Button>
      </div>

      <button
        type="button"
        onClick={() => Datasets.setFolder(null)}
        aria-current={activeFolderId === null ? 'true' : undefined}
        data-testid="dataset-folder-all"
        className={
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm ' +
          (activeFolderId === null ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-accent/50')
        }
      >
        <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        All datasets
      </button>

      {folders.map(folder => {
        const active = folder.id === activeFolderId
        const isDrop = dropTarget === folder.id
        return (
          <div
            key={folder.id}
            onDragOver={e => {
              e.preventDefault()
              setDropTarget(folder.id)
            }}
            onDragLeave={() => setDropTarget(cur => (cur === folder.id ? null : cur))}
            onDrop={e => void onDrop(folder.id, e)}
            className={
              'group flex items-center gap-1 rounded-md ' + (isDrop ? 'ring-2 ring-primary' : '')
            }
          >
            <button
              type="button"
              onClick={() => Datasets.setFolder(active ? null : folder.id)}
              aria-current={active ? 'true' : undefined}
              data-testid={`dataset-folder-${folder.id}`}
              className={
                'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm ' +
                (active ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-accent/50')
              }
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{folder.name}</span>
              <span className="ms-auto shrink-0 text-xs text-muted-foreground">{countFor(folder.id)}</span>
            </button>
            <Confirm
              title={`Delete folder "${folder.name}"?`}
              description="This removes the label only — the datasets are not deleted."
              danger
              okText="Delete folder"
              cancelText="Cancel"
              onConfirm={async () => {
                try {
                  await Datasets.deleteFolder(folder.id)
                  message.success('Folder deleted')
                } catch (err) {
                  message.error(err instanceof Error ? err.message : 'Failed to delete folder')
                }
              }}
              data-testid={`dataset-folder-delete-${folder.id}`}
            >
              <Button
                variant="ghost"
                size="icon"
                // ONE string for both channels: the kit adopts a string `tooltip` as the
                // accessible name. A dialog trigger CAN also be a tooltip trigger now that the
                // kit hoists the injected `id` onto Tooltip.Trigger, so the wrapper this used to
                // need is gone.
                tooltip={`Delete folder ${folder.name}`}
                className="opacity-0 group-hover:opacity-100"
                data-testid={`dataset-folder-delete-btn-${folder.id}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </Confirm>
          </div>
        )
      })}

      <FolderCreateDialog />
    </nav>
  )
}
