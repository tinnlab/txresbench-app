import type { ReactNode } from 'react'

/**
 * txrshell — PageFooterBar (app-shell ITEM-1).
 *
 * The fixed bottom bar of a page (primary actions, the run bar, the
 * "Showing n of N" counters and the retention statements). It sits in the
 * PageFrame's bottom slot — always visible while the region above scrolls.
 */
export interface PageFooterBarProps {
  children: ReactNode
  className?: string
  testId?: string
}

export function PageFooterBar({ children, className, testId }: PageFooterBarProps) {
  return (
    <div
      data-testid={testId ?? 'txr-page-footer-bar'}
      className={`txr-page-footer-bar ${className ?? ''}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flex: 'none',
        padding: '10px 24px',
        background: 'var(--txr-surface)',
        borderTop: '1px solid var(--txr-border-subtle)',
        minHeight: 0,
      }}
    >
      {children}
    </div>
  )
}
