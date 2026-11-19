/**
 * SavedFileNotice — the one line a page shows after the desktop app saved a
 * file through the Save dialog (`@/core/saveFile`): "Saved to <path>" and a
 * "Show in Finder" / "Show in folder" button that opens the file's folder.
 * Pages render it in the slot their error line already uses, so a save and a
 * failed save never show at the same time.
 */
import type { CSSProperties } from 'react'
import { Button } from '@txresbench/kit'
import { revealSavedFile, showSavedLabel } from '@/core/saveFile'

const LINE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: 'var(--txr-muted)',
}

const PATH: CSSProperties = {
  color: 'var(--txr-text)',
  wordBreak: 'break-all',
}

export interface SavedFileNoticeProps {
  /** The saved file's full path (the Save dialog's choice). */
  path: string
  /** The line's test id (the page's own name for it). */
  testId: string
}

export function SavedFileNotice({ path, testId }: SavedFileNoticeProps) {
  return (
    <div role="status" data-testid={testId} style={LINE}>
      <span>
        Saved to <span style={PATH}>{path}</span>
      </span>
      <Button
        variant="link"
        style={{ fontSize: 13, padding: 0, height: 'auto' }}
        data-testid={`${testId}-show`}
        onClick={() => void revealSavedFile(path)}
      >
        {showSavedLabel()}
      </Button>
    </div>
  )
}
