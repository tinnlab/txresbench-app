import type { ReactNode } from 'react'

/**
 * txrshell — PageFrame (app-shell ITEM-1).
 *
 * Every page's layout, one frame (DEC-3): an optional fixed top area
 * (title, step, toolbar, filters, tabs), a body area that hosts the
 * page's ONE OR TWO ScrollRegions, and an optional fixed bottom area
 * (primary actions, the run bar, counters). The frame fills its routed
 * area (`height: 100%`) so the page itself never scrolls in shell mode —
 * the regions inside it do.
 *
 * The frame is a plain div, never a `<main>`: each route owns its own
 * main landmark (the shell layout's routed area is a div — the
 * nested-landmark ruling carried into this frame).
 */

export interface PageFrameProps {
  /** The fixed top area (or null — the audit's `/` body-only case). */
  top?: ReactNode
  /** The body area: the region host. */
  body?: ReactNode
  /** The fixed bottom area. */
  bottom?: ReactNode
  className?: string
  testId?: string
}

export function PageFrame({ top, body, bottom, className, testId }: PageFrameProps) {
  return (
    <div
      data-testid={testId ?? 'txr-page-frame'}
      className={`txr-page-frame ${className ?? ''}`}
      style={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--txr-bg)',
      }}
    >
      {top !== undefined ? (
        <div
          className="txr-page-frame-top"
          style={{ flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0 }}
        >
          {top}
        </div>
      ) : null}
      <div
        className="txr-page-frame-body"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        {body}
      </div>
      {bottom !== undefined ? (
        <div className="txr-page-frame-bottom" style={{ flex: 'none', minHeight: 0 }}>
          {bottom}
        </div>
      ) : null}
    </div>
  )
}
