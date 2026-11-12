/**
 * TxrHistoryFooter — the K board's accountability footer (PROV-HIST-5):
 * the usage line (the run count + the data dir + the size + the board's
 * trailing promise — the count from the usage record, the path segment
 * only when the provider reports it, GAP-HIST-1 grown, never a
 * hardcoded path) and the two retention links: "Do not keep copies of
 * my files" ↔ "Keep copies of my files" (the preference's state) plus
 * the red "Clear all history".
 *
 * The links REPORT, the page coordinates: the confirm dialog
 * (`TxrConfirmDialog`) is the destructive gate (INV-2 — the store's
 * own confirmation state assertion is TEST-HIST-4), so this footer's
 * onCopiesOff/onCopiesOn/onClearAll are the dialog-open reports, never
 * the destructive calls. `working` (the store's in-flight action marker)
 * disables the three links — no double fire.
 *
 * The usage line's facts: count = `usage.run_count` (the provider's
 * engine-truth count); the DEC-3 fallback to the list's `total` when the
 * usage figure is unavailable keeps the board's "N runs" honest — the
 * bytes/path segments are the usage record's own and omit when it is
 * absent (never a fabricated figure, INV-6). A one-run count reads the
 * singular.
 */
import type { CSSProperties } from 'react'
import { Button } from '@txresbench/kit'
import type { TxrHistoryPreferences, TxrHistoryUsage } from '@/api-client/types'
import { formatBytes, HISTORY_USAGE_TRAIL } from '../lib/format'

/** The board's footer row (wrap, spaced, the quiet 13.5 px tone). */
const FOOTER: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  marginTop: 'auto',
  paddingTop: 8,
  fontSize: 13.5,
  color: 'var(--txr-muted)',
}

/** The mono data-dir segment (the board's path bytes). */
const MONO: CSSProperties = {
  fontFamily: "'Source Code Pro', monospace",
  fontSize: 12.5,
}

/** The retention links row (the board's 18 px gap). */
const LINKS: CSSProperties = { display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }

/** The link look (the board's 13.5 px quiet links). */
const LINK: CSSProperties = { fontSize: 13.5, fontWeight: 400, padding: 0, height: 'auto', color: 'var(--txr-brand)' }

/** The clear-all's danger look (the board's red). */
const DANGER_LINK: CSSProperties = { ...LINK, color: 'var(--txr-danger)' }

/** The board's separator between the count and the usage segments. */
const SEP = ' \u00b7 '

export interface TxrHistoryFooterProps {
  /** The provider's usage figure (null until the first load/failure — the
   *  bytes/path segments then omit, the count falls back to `total`). */
  usage: TxrHistoryUsage | null
  /** The list's engine-truth count (the DEC-3 honest fallback). */
  total: number
  /** The keep-copies preference (null until loaded — the board's default
   *  `true` renders conservatively, the provider's own default). */
  preferences: TxrHistoryPreferences | null
  /** The in-flight retention action (the links' shared busy state). */
  working: boolean
  /** "Do not keep copies of my files" clicked (the copies-off dialog). */
  onCopiesOff: () => void
  /** "Keep copies of my files" clicked (the copies-on dialog). */
  onCopiesOn: () => void
  /** "Clear all history" clicked (the clear-all dialog). */
  onClearAll: () => void
}

export function TxrHistoryFooter({
  usage,
  total,
  preferences,
  working,
  onCopiesOff,
  onCopiesOn,
  onClearAll,
}: TxrHistoryFooterProps) {
  const count = usage?.run_count ?? total
  const countText = `${count} ${count === 1 ? 'run' : 'runs'}`
  const keepCopies = preferences?.keep_file_copies ?? true
  return (
    <footer data-testid="txr-history-footer" style={FOOTER}>
      <span data-testid="txr-history-usage">
        {countText}
        {usage !== null ? (
          <>
            {SEP}
            <span style={MONO}>{usage.data_dir}</span>
            {` uses ${formatBytes(usage.total_bytes)}`}
          </>
        ) : null}
        {` ${HISTORY_USAGE_TRAIL}`}
      </span>
      <span style={LINKS}>
        {keepCopies ? (
          <Button
            data-testid="txr-history-copies-off"
            variant="link"
            style={LINK}
            disabled={working}
            onClick={onCopiesOff}
          >
            Do not keep copies of my files
          </Button>
        ) : (
          <Button
            data-testid="txr-history-copies-on"
            variant="link"
            style={LINK}
            disabled={working}
            onClick={onCopiesOn}
          >
            Keep copies of my files
          </Button>
        )}
        <Button
          data-testid="txr-history-clear-all"
          variant="link"
          style={DANGER_LINK}
          disabled={working}
          onClick={onClearAll}
        >
          Clear all history
        </Button>
      </span>
    </footer>
  )
}
