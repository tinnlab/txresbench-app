import { type AdminUserOption } from '@/api-client/types'
import { ProjectAdmin } from '@/modules/project/stores/ProjectAdmin.store'
import { Button, Select, message } from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import { useState } from 'react'
import { UserPicker } from './UserPicker'

/** Admin shares a project on the owner's behalf (creates a pending invite the
 *  recipient accepts, like a normal share). */
export function ShareOnBehalfDrawer() {
  const { shareId, rows, mutating } = ProjectAdmin
  const project = rows.find(r => r.id === shareId)
  const [recipient, setRecipient] = useState<AdminUserOption | null>(null)
  const [level, setLevel] = useState('viewer')

  const close = () => {
    ProjectAdmin.closeShare()
    setRecipient(null)
    setLevel('viewer')
  }

  const submit = async () => {
    if (!shareId || !recipient) return
    try {
      await ProjectAdmin.shareOnBehalf(shareId, recipient.id, level)
      message.success('Invitation sent')
      close()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to share')
    }
  }

  return (
    <Drawer
      title={project ? `Share "${project.name}" on behalf` : 'Share project'}
      open={shareId !== null}
      onClose={close}
      size={480}
      mask={{ closable: false }}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={mutating} data-testid="admin-share-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={mutating}
            disabled={!recipient}
            data-testid="admin-share-submit"
          >
            Send invite
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="admin-share-form">
        <div>
          <div className="mb-1 text-sm font-medium">Recipient</div>
          <UserPicker
            value={recipient}
            onChange={setRecipient}
            excludeIds={project ? [project.owner_id] : []}
            testid="admin-share-picker"
          />
        </div>
        <div>
          <div className="mb-1 text-sm font-medium">Permission</div>
          <Select
            value={level}
            onValueChange={setLevel}
            data-testid="admin-share-level"
            options={[
              { label: 'Viewer (read-only)', value: 'viewer' },
              { label: 'Editor (edit + attach datasets)', value: 'editor' },
            ]}
          />
        </div>
      </div>
    </Drawer>
  )
}
