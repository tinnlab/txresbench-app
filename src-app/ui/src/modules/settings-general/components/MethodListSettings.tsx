import { Button, Card, message } from '@txresbench/kit'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from '@txresbench/kit/shadcn/field'
import type { MethodListStatus } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { runAction } from '@/core/actions/defineAction'
import { useMethodListChecking, useMethodListUpdates } from '@/lib/txr-method-list/revision'

/** A date the way the card says it ("20 Nov 2026"). */
function day(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** A time the way the card says it ("20 Nov 2026, 10:05"). */
function moment(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
}

/** The card's two lines for a status (pure: the unit tests pin the words). */
export function methodListLines(status: MethodListStatus | null): { title: string; detail: string } {
  if (status === null) return { title: 'Method list', detail: 'Reading the method list…' }
  const title = `Method list #${status.sequence}`
  const parts: string[] = []
  parts.push(
    status.sequence === 0
      ? 'built into this app'
      : `published ${day(status.assembled_at)}`,
  )
  if (!status.updates_enabled) {
    parts.push('updates are off in this demo')
    return { title, detail: capitalise(parts.join(', ')) }
  }
  parts.push(
    status.last_checked_at ? `last checked ${moment(status.last_checked_at)}` : 'not checked yet',
  )
  let detail = capitalise(parts.join(', '))
  const found = resultLine(status)
  if (found !== null) detail = `${detail}. ${found}`
  return { title, detail }
}

/** What the last check found, in a sentence (`null`: nothing to add). */
function resultLine(status: MethodListStatus): string | null {
  switch (status.last_check) {
    case 'current':
      return 'It is up to date.'
    case 'updated':
      return status.last_error ?? 'A newer list was downloaded: your next run uses it.'
    case 'unreachable':
    case 'unavailable':
    case 'refused':
    case 'needs_newer_app':
      return status.last_error ?? null
    default:
      return null
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Settings > General: the method list in use and "Check for method updates" (the
 * `methodList.checkForUpdates` action, so the palette and the AI agent run the same
 * check). The status is read when the card mounts, on window focus and every 10 minutes.
 */
export function MethodListSettings() {
  const status = useMethodListUpdates()
  const checking = useMethodListChecking()
  const canCheck = usePermission(Permissions.ProjectsUse)
  const { title, detail } = methodListLines(status)

  const onCheck = async (): Promise<void> => {
    try {
      const next = (await runAction('methodList.checkForUpdates', {})) as MethodListStatus
      if (next.last_check === 'updated') {
        message.success(`Method list #${next.sequence} is in use from your next run`)
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'The check for method updates failed')
    }
  }

  const unavailable = !canCheck
    ? 'You do not have access to the methods'
    : status !== null && !status.updates_enabled
      ? 'Method updates are off in this demo'
      : undefined

  return (
    <Card title="Methods" data-testid="settingsgen-method-list-card">
      <FieldGroup>
        <Field orientation="responsive">
          <FieldContent>
            <FieldTitle data-testid="settingsgen-method-list-title">{title}</FieldTitle>
            <FieldDescription data-testid="settingsgen-method-list-detail">{detail}</FieldDescription>
          </FieldContent>
          <Button
            data-testid="settingsgen-method-list-check"
            variant="outline"
            loading={checking}
            unavailableReason={unavailable}
            onClick={() => void onCheck()}
          >
            Check for method updates
          </Button>
        </Field>
      </FieldGroup>
    </Card>
  )
}
