/**
 * The model step's empty message (a whole-page state) and its none-can-run
 * line (above a list), rendered from `lib/emptyState.ts`. Each button runs a
 * registered action (`runModelsEmptyAction`), except Retry, which is the
 * page's own data reload (the list's Retry is the same kind of refetch).
 */
import type { CSSProperties } from 'react'
import { Alert, Button, message as toast } from '@txresbench/kit'
import { runAction } from '@/core/actions/defineAction'
import { modelsPath } from '../routes'
import type {
  TxrModelsEmptyActionId,
  TxrModelsEmptyMessage,
  TxrModelsNoneCanRunLine,
} from '../lib/emptyState'

const BOX: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  alignItems: 'flex-start',
  padding: '24px 0',
}

const TITLE: CSSProperties = {
  margin: 0,
  fontSize: 15.5,
  color: 'var(--txr-text-2)',
  fontWeight: 600,
  maxWidth: '62ch',
}

const BODY: CSSProperties = { margin: 0, color: 'var(--txr-text-2)', maxWidth: '62ch' }

const ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }

const PRIMARY: CSSProperties = {
  borderRadius: 8,
  background: 'var(--txr-brand)',
  color: 'var(--txr-on-brand)',
  fontWeight: 700,
}

const OUTLINE: CSSProperties = {
  borderRadius: 8,
  background: 'var(--txr-surface)',
  color: 'var(--txr-text)',
  fontWeight: 600,
  border: '1px solid var(--txr-border)',
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The action could not be done.'
}

/**
 * Run a message button's registered action: the list switch
 * (`models.switchList`), the learn path (`flow.startPath`), or Your models
 * (`app.navigate`). Retry is not an action here: the page reloads its data.
 */
export function runModelsEmptyAction(id: Exclude<TxrModelsEmptyActionId, 'retry'>): void {
  const run = (): Promise<unknown> => {
    switch (id) {
      case 'use-saved':
      case 'see-saved':
        return runAction('models.switchList', { list: 'saved' })
      case 'use-published':
      case 'see-published':
        return runAction('models.switchList', { list: 'published' })
      case 'learn':
        return runAction('flow.startPath', { intent: 'train' })
      case 'your-models':
        return runAction('app.navigate', { path: modelsPath() })
    }
  }
  run().catch((error: unknown) => {
    toast.error(errorText(error))
  })
}

export interface TxrModelsEmptyStateProps {
  message: TxrModelsEmptyMessage
  testId: string
  /** Retry's reload (the page's own data refetch). */
  onRetry(): void
}

/** The whole-page message: the lead line, the body, the buttons (the first is the primary). */
export function TxrModelsEmptyState({ message, testId, onRetry }: TxrModelsEmptyStateProps) {
  return (
    <div data-testid={testId} role="status" aria-live="polite" style={BOX}>
      <p data-testid={`${testId}-title`} style={TITLE}>
        {message.title}
      </p>
      {message.body !== null ? (
        <p data-testid={`${testId}-body`} style={BODY}>
          {message.body}
        </p>
      ) : null}
      {message.actions.length > 0 ? (
        <div style={ROW}>
          {message.actions.map((action, index) => (
            <Button
              key={action.id}
              data-testid={`${testId}-action-${action.id}`}
              variant={index === 0 ? 'default' : 'outline'}
              style={index === 0 ? PRIMARY : OUTLINE}
              onClick={() => {
                if (action.id === 'retry') onRetry()
                else runModelsEmptyAction(action.id)
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The none-can-run line above a list, with its button (the other list) when it has one. */
export function TxrModelsNoneCanRun({
  line,
  testId,
}: {
  line: TxrModelsNoneCanRunLine
  testId: string
}) {
  return (
    <Alert tone="info" data-testid={testId} title={line.text}>
      {line.actions.length > 0 ? (
        <div style={ROW}>
          {line.actions.map(action => (
            <Button
              key={action.id}
              data-testid={`${testId}-action-${action.id}`}
              variant="outline"
              style={OUTLINE}
              onClick={() => {
                if (action.id !== 'retry') runModelsEmptyAction(action.id)
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </Alert>
  )
}
