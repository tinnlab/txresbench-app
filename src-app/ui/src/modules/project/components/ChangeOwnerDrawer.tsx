import { type AdminUserOption } from '@/api-client/types'
import { ProjectAdmin } from '@/modules/project/stores/ProjectAdmin.store'
import { Button, Switch, message } from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import { useState } from 'react'
import { UserPicker } from './UserPicker'

/** Admin forced change of a project's owner (immediate, no accept — DEC-2/3). */
export function ChangeOwnerDrawer() {
  const { changeOwnerId, rows, mutating } = ProjectAdmin
  const project = rows.find(r => r.id === changeOwnerId)
  const [newOwner, setNewOwner] = useState<AdminUserOption | null>(null)
  const [keepOld, setKeepOld] = useState(false)

  const close = () => {
    ProjectAdmin.closeChangeOwner()
    setNewOwner(null)
    setKeepOld(false)
  }

  const submit = async () => {
    if (!changeOwnerId || !newOwner) return
    try {
      await ProjectAdmin.changeOwner(changeOwnerId, newOwner.id, keepOld)
      message.success('Ownership changed')
      close()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to change owner')
    }
  }

  return (
    <Drawer
      title={project ? `Change owner — "${project.name}"` : 'Change owner'}
      open={changeOwnerId !== null}
      onClose={close}
      size={480}
      mask={{ closable: false }}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={mutating} data-testid="change-owner-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={mutating}
            disabled={!newOwner}
            data-testid="change-owner-submit"
          >
            Change owner
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="change-owner-form">
        {project && (
          <div className="text-sm text-muted-foreground">
            Current owner: <span className="font-medium text-foreground">{project.owner_username}</span>{' '}
            ({project.owner_email})
          </div>
        )}
        <div>
          <div className="mb-1 text-sm font-medium">New owner</div>
          <UserPicker
            value={newOwner}
            onChange={setNewOwner}
            excludeIds={project ? [project.owner_id] : []}
            testid="change-owner-picker"
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 text-sm">
            Keep{' '}
            <span className="font-medium">{project?.owner_username ?? 'the previous owner'}</span> as an
            editor
            <div className="text-xs text-muted-foreground">
              Off (default) removes their access — the offboarding case.
            </div>
          </div>
          <Switch
            checked={keepOld}
            onCheckedChange={setKeepOld}
            data-testid="change-owner-keep-editor"
          />
        </div>
      </div>
    </Drawer>
  )
}
