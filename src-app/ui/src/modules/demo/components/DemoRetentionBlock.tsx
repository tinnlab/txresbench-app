import type { CSSProperties } from 'react'
import { DEMO_POOL_STATEMENT, formatDemoCounter } from '../copy'

/**
 * DemoRetentionBlock — the demo's shared-pool + retention paragraph
 * (demo-mode ITEM-7; the audit's "clearly, a visible paragraph, not a
 * tooltip" byte): the plan's exact shared-pool statement with the "n of 50"
 * counter, on History (runs), Models and Saved models (models) and in Help.
 *
 * The block is presentational: the page feeds the counted figure + the
 * limit (the demo usage read — the server's numbers, never invented).
 * Before the read lands the counter shows the limit with a quiet ellipsis
 * for the count, so the paragraph's height is stable (the pages' fixed
 * tops never jump).
 */
const BLOCK: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '10px 14px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 10,
  background: 'var(--txr-accent-soft)',
  fontSize: 13.5,
  color: 'var(--txr-text-2)',
}

const COUNTER: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 700,
  color: 'var(--txr-brand-ink)',
}

export interface DemoRetentionBlockProps {
  /** The counted entries ("n of 50"): 'runs' on History, 'models' on the
   *  model pages. */
  kind: 'runs' | 'models'
  /** The counted (non-pinned) figure; null while the usage read is in
   *  flight (the counter renders the quiet ellipsis). */
  count: number | null
  /** The configured limit (the audit's 50). */
  limit: number
}

export function DemoRetentionBlock({ kind, count, limit }: DemoRetentionBlockProps) {
  return (
    <div data-testid="txr-demo-retention" style={BLOCK}>
      <p data-testid="txr-demo-retention-statement" style={{ margin: 0 }}>
        {DEMO_POOL_STATEMENT}
      </p>
      <span data-testid="txr-demo-retention-counter" style={COUNTER}>
        {formatDemoCounter(count, limit, kind)}
      </span>
    </div>
  )
}
