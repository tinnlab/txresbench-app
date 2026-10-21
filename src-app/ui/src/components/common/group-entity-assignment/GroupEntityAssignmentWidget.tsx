import type { ReactNode } from 'react'
import { Button, Card, Flex, Space, Spin, Tag, Text } from '@ziee/kit'
import { Pencil } from 'lucide-react'
import type { Group } from '@/api-client/types'

/**
 * Generic "entities assigned to a group" widget for the User Groups page.
 * Config-driven so Skills + Workflows (and later MCP/LLM) share one shell:
 * icon + title + count header, a gated Edit button that opens the caller's
 * drawer, and a tag list / empty / error body. The caller owns data loading
 * (via a per-module store) and passes the resolved `data` in.
 *
 * Mirrors the shape + testid/aria conventions of the MCP
 * `GroupSystemMcpServersWidget`.
 */
export interface GroupEntityAssignmentWidgetProps<E extends { id: string }> {
  group: Group
  /** e.g. "System Skills" — also drives the empty text + Edit aria-label. */
  title: string
  icon: ReactNode
  /** testid namespace, e.g. "skill-group-widget". */
  testidPrefix: string
  canManage: boolean
  data?: { entities: E[]; loading?: boolean; error?: string | null }
  onEdit: (group: Group) => void
  entityLabel: (entity: E) => string
  /** Whether the entity should render as an emphasized (info-tone) tag. */
  entityActive?: (entity: E) => boolean
}

export function GroupEntityAssignmentWidget<E extends { id: string }>({
  group,
  title,
  icon,
  testidPrefix,
  canManage,
  data,
  onEdit,
  entityLabel,
  entityActive,
}: GroupEntityAssignmentWidgetProps<E>) {
  const entities = data?.entities ?? []
  const loading = data?.loading ?? false
  const error = data?.error ?? null

  return (
    <Card data-group-id={group.id} data-testid={`${testidPrefix}-card-${group.id}`}>
      <Flex vertical gap="small" className="w-full">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Space size="small">
            {icon}
            <Text strong>{title}</Text>
            {loading ? (
              <Spin size="sm" label="Loading" />
            ) : (
              <Text type="secondary">({entities.length})</Text>
            )}
          </Space>
          {canManage && (
            <Button
              size="default"
              variant="ghost"
              icon={<Pencil aria-hidden="true" />}
              onClick={() => onEdit(group)}
              aria-label={`Edit ${title} for ${group.name}`}
              data-testid={`${testidPrefix}-edit-btn-${group.id}`}
            >
              Edit
            </Button>
          )}
        </div>

        {/* Content */}
        {error ? (
          <Text type="danger" className="text-xs">
            {error}
          </Text>
        ) : loading ? (
          <Text type="secondary" className="text-xs">
            Loading...
          </Text>
        ) : entities.length === 0 ? (
          <Text type="secondary" className="text-xs">
            No {title} assigned
          </Text>
        ) : (
          <Space wrap size="small">
            {entities.map(entity => (
              <Tag
                key={entity.id}
                tone={entityActive?.(entity) ? 'info' : undefined}
                variant="outline"
                data-testid={`${testidPrefix}-tag-${group.id}-${entity.id}`}
              >
                {entityLabel(entity)}
              </Tag>
            ))}
          </Space>
        )}
      </Flex>
    </Card>
  )
}
