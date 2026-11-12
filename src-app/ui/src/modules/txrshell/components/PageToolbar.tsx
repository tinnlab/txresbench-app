import type { ReactNode } from 'react'

/**
 * txrshell — PageToolbar (app-shell ITEM-1).
 *
 * The fixed top bar of a page (title block, search, filters, chips). It is
 * a flex row whose OWN height comes from its content; the PageFrame's top
 * slot keeps it out of the page's scroll. A toolbar is `flex: none` and
 * never scrolls with the region below it.
 */
export interface PageToolbarProps {
  children: ReactNode
  className?: string
  testId?: string
  /** Column layout (a tall toolbar: title + a controls row). */
  stacked?: boolean
}

export function PageToolbar({ children, className, testId, stacked = false }: PageToolbarProps) {
  return (
    <div
      data-testid={testId ?? 'txr-page-toolbar'}
      className={`txr-page-toolbar ${className ?? ''}`}
      style={{
        display: 'flex',
        alignItems: stacked ? 'stretch' : 'center',
        gap: 12,
        flexDirection: stacked ? 'column' : 'row',
        flex: 'none',
        padding: '12px 24px',
        background: 'var(--txr-surface)',
        borderBottom: '1px solid var(--txr-border-subtle)',
        minHeight: 0,
      }}
    >
      {children}
    </div>
  )
}
