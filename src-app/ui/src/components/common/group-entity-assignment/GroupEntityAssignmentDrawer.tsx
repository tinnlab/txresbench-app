import { type ReactNode, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Flex,
  Spinner,
  Switch,
  Text,
  Title,
  message,
} from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import type { Group } from '@/api-client/types'

/**
 * Generic editor drawer for "which entities are assigned to this group".
 * A list of all entities, each a Card with a Switch; Save diffs the toggled
 * set against what was loaded. Config-driven (no module store references) so
 * Skills + Workflows (and later MCP/LLM) share one implementation.
 *
 * Mirrors the MCP `GroupSystemMcpServersAssignmentDrawer` layout + testid
 * conventions.
 */
export interface GroupEntityAssignmentDrawerProps<E extends { id: string }> {
  isOpen: boolean
  group: Group | null
  /** e.g. "Assign System Skills". */
  title: string
  /** testid namespace, e.g. "skill-group-assign". */
  testidPrefix: string
  canManage: boolean
  allEntities: E[]
  /** Resolve the ids currently assigned to the group. */
  loadAssigned: (groupId: string) => Promise<string[]>
  /** Persist the desired id set for the group. */
  save: (groupId: string, ids: string[]) => Promise<void>
  onClose: () => void
  entityLabel: (entity: E) => string
  /** Optional badges/description rendered next to the label. */
  entityBadges?: (entity: E) => ReactNode
  /** Copy for the "no entities available" state. */
  emptyText?: string
}

export function GroupEntityAssignmentDrawer<E extends { id: string }>({
  isOpen,
  group,
  title,
  testidPrefix,
  canManage,
  allEntities,
  loadAssigned,
  save,
  onClose,
  entityLabel,
  entityBadges,
  emptyText = 'None available',
}: GroupEntityAssignmentDrawerProps<E>) {
  const [assignedIds, setAssignedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (isOpen && group) {
      let cancelled = false
      setLoading(true)
      loadAssigned(group.id)
        .then(ids => {
          if (!cancelled) setAssignedIds(ids)
        })
        .catch(error => {
          console.error('Failed to load assigned entities:', error)
          if (!cancelled) message.error('Failed to load assignments')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => {
        cancelled = true
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, group])

  const handleToggle = (id: string, checked: boolean) => {
    setAssignedIds(prev =>
      checked ? [...prev, id] : prev.filter(x => x !== id),
    )
  }

  const handleSave = async () => {
    if (!group) return
    setSaving(true)
    try {
      await save(group.id, assignedIds)
      message.success('Assignments updated')
      onClose()
    } catch (error) {
      console.error('Failed to update assignments:', error)
      message.error('Failed to update assignments')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      title={`${title} - ${group?.name || ''}`}
      open={isOpen}
      onClose={onClose}
      size={600}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            onClick={onClose}
            disabled={saving}
            data-testid={`${testidPrefix}-cancel-btn`}
          >
            {canManage ? 'Cancel' : 'Close'}
          </Button>
          {canManage && (
            <Button
              variant="default"
              onClick={handleSave}
              loading={saving}
              disabled={loading}
              data-testid={`${testidPrefix}-save-btn`}
            >
              Save
            </Button>
          )}
        </div>
      }
    >
      {loading ? (
        <div className="flex justify-center p-8">
          <Spinner label="Loading" />
        </div>
      ) : (
        <Flex direction="column" className="w-full gap-4">
          {/* Every row's Switch disabled AND no Save button is a silent refusal —
              the caller's `canManage=false` must be stated, not just enacted. */}
          {!canManage && (
            <Alert
              data-testid={`${testidPrefix}-readonly-alert`}
              tone="info"
              title="Read-only view"
              description="You don't have permission to manage this group's assignments, so the toggles below are read-only."
            />
          )}

          <div>
            <Title level={5} className="mb-2">
              Available
            </Title>
            <Text type="secondary">
              Select which items this group can access
            </Text>
          </div>

          {allEntities.length === 0 ? (
            <div className="p-4 text-center">
              <Text type="secondary">{emptyText}</Text>
            </div>
          ) : (
            <Flex direction="column" className="w-full gap-4" role="list">
              {allEntities.map(entity => {
                const isChecked = assignedIds.includes(entity.id)
                return (
                  <Card
                    key={entity.id}
                    role="listitem"
                    data-cursor={canManage ? 'pointer' : 'default'}
                    data-testid={`${testidPrefix}-card-${entity.id}`}
                    onClick={() =>
                      canManage && handleToggle(entity.id, !isChecked)
                    }
                  >
                    <div className="flex items-start gap-3">
                      <div onClick={e => e.stopPropagation()}>
                        <Switch
                          tooltip="Assign to this group"
                          aria-label={`Assign ${entityLabel(entity)} to this group`}
                          checked={isChecked}
                          onChange={checked => handleToggle(entity.id, checked)}
                          disabled={!canManage}
                          className="mt-0.5"
                          data-testid={`${testidPrefix}-switch-${entity.id}`}
                        />
                      </div>
                      <div className="flex flex-col gap-1 flex-1">
                        <div className="flex items-center gap-2">
                          <Text strong className="text-sm">
                            {entityLabel(entity)}
                          </Text>
                          {entityBadges?.(entity)}
                        </div>
                      </div>
                    </div>
                  </Card>
                )
              })}
            </Flex>
          )}
        </Flex>
      )}
    </Drawer>
  )
}
