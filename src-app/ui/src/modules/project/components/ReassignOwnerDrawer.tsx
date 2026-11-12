import { type AdminUserOption, type BatchResult } from '@/api-client/types'
import { ProjectAdmin } from '@/modules/project/stores/ProjectAdmin.store'
import { Button, message } from '@txresbench/kit'
import { Drawer } from '@txresbench/shell'
import { useState } from 'react'
import { UserPicker } from './UserPicker'

function summarize(res: BatchResult): string {
  const ok = res.succeeded.length
  const bad = res.failed.length
  return bad === 0
    ? `Reassigned ${ok} ${ok === 1 ? 'project' : 'projects'}`
    : `Reassigned ${ok}; ${bad} failed`
}

/**
 * Reassign projects to a new owner — either the multi-select bulk set (DEC-7) or
 * ALL of one owner's projects (the offboarding accelerator). One drawer, driven by
 * whether `reassignFromOwner` (all) or `reassignProjectIds` (bulk) is set.
 */
export function ReassignOwnerDrawer() {
  const { reassignOpen, reassignProjectIds, reassignFromOwner, mutating } = ProjectAdmin
  const [target, setTarget] = useState<AdminUserOption | null>(null)

  const isAll = reassignFromOwner !== null
  const count = reassignProjectIds.length

  const close = () => {
    ProjectAdmin.closeReassign()
    setTarget(null)
  }

  const submit = async () => {
    if (!target) return
    try {
      const res = isAll
        ? await ProjectAdmin.reassignAll(reassignFromOwner!.id, target.id)
        : await ProjectAdmin.batchReassign(reassignProjectIds, target.id)
      if (res.failed.length > 0) message.warning(summarize(res))
      else message.success(summarize(res))
      close()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to reassign')
    }
  }

  return (
    <Drawer
      title="Reassign ownership"
      open={reassignOpen}
      onClose={close}
      size={480}
      mask={{ closable: false }}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={mutating} data-testid="reassign-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={mutating}
            disabled={!target}
            data-testid="reassign-submit"
          >
            Reassign
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="reassign-form">
        <div className="text-sm text-muted-foreground" data-testid="reassign-scope">
          {isAll ? (
            <>
              Move <span className="font-medium text-foreground">every</span> project owned by{' '}
              <span className="font-medium text-foreground">{reassignFromOwner!.name}</span> to a new
              owner.
            </>
          ) : (
            <>
              Move the <span className="font-medium text-foreground">{count}</span> selected{' '}
              {count === 1 ? 'project' : 'projects'} to a new owner.
            </>
          )}
        </div>
        <div>
          <div className="mb-1 text-sm font-medium">New owner</div>
          <UserPicker
            value={target}
            onChange={setTarget}
            excludeIds={isAll ? [reassignFromOwner!.id] : []}
            testid="reassign-picker"
          />
        </div>
      </div>
    </Drawer>
  )
}
