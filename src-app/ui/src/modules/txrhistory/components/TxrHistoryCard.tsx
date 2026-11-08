/**
 * TxrHistoryCard — one K list card (PROV-HIST-5, board `History.dc.html`):
 * the collapsible header row (title, subtitle line, mode chip, status,
 * date, the Show/Hide-details toggle) and, when expanded, the detail
 * block (falling back to the board's collapsed data alone while the
 * detail loads or after a 404 — never a crash, never a fabricated block).
 *
 * Composition rules (the board's own shapes):
 *
 * - the title is ITEM-3's `titleFor` (the train "N methods on files…"
 *   / reuse "Model <set> on <file>" matrix);
 * - the subtitle line is the board's facts sentence — the joined method
 *   ids WHEN THE RUN HAS MORE THAN ONE METHOD (a one-method run's title
 *   already names it — the board's own shape), the learned/predicted
 *   pair ("learned from N patients, predicted M"), decision day and the
 *   endpoint line, joined " · ", each segment omitted when the run
 *   recorded no such fact; a REUSE run's subtitle is the board's own
 *   short shape — the capital-P "Predicted N patients" line + the
 *   endpoint line, with no method or decision-day segment (its title
 *   names the consumed model); a stopped/failed row shows the REASON
 *   line (the ITEM-3 `reasonLine`, the provider's detail verbatim, in
 *   the failure red — the board's failed row) INSTEAD of the facts
 *   line;
 * - the mode chip is the ui-list palette ('accent' / 'neutral' — the
 *   cards' hexes live here, the palette words in types.ts, DRIFT-1 #7);
 * - the status word is ITEM-3's `statusLabel` tone; the date is the
 *   board's "Today 10:02" / "19 Oct 14:36" from `created_at` (the
 *   list's own ordering key);
 * - the toggle is ONE at a time (DEC-8): the card reports `onToggle`,
 *   the store owns `expandedId`.
 *
 * The card is reported, never executed: the toggle + the action clicks
 * report ids; the page binds the store + the builders (ITEM-5).
 */
import type { CSSProperties } from 'react'
import { Button, Skeleton } from '@ziee/kit'
import type { TxrHistoryDetail, TxrHistoryItem } from '@/api-client/types'
import { endpointLabel, formatDate, modeChip, reasonLine, statusLabel } from '../lib/format'
import { titleFor } from '../lib/title'
import type { TxrChipTone } from '../types'
import { TxrHistoryDetailBlock } from './TxrHistoryDetailBlock'

/** The two chip palettes, verbatim from the boards (DEC-9, the ui-list
 *  module's own bytes — the words are shared, the hexes are the
 *  rendering component's, DRIFT-1 #7). */
export const TXRHISTORY_CHIP_TONES: Record<TxrChipTone, CSSProperties> = {
  accent: { background: '#e8eef6', color: '#143a68' },
  neutral: { background: '#eef0e6', color: '#3d4a14' },
}

/** The board's chip pill shape (both tones share it). */
const CHIP_PILL: CSSProperties = {
  fontSize: 12.5,
  padding: '2px 10px',
  borderRadius: 999,
  textAlign: 'center',
  whiteSpace: 'nowrap',
}

/** The header row (the board's wrap row: 14 px 18 px, 14 px gaps). */
const HEADER_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 14,
  padding: '14px 18px',
}

/** The title block (the board's flexible left column). */
const TITLE_BLOCK: CSSProperties = { flex: '1 1 360px', minWidth: 0 }

const ROW_TITLE: CSSProperties = { fontWeight: 700, overflowWrap: 'anywhere' }

const ROW_SUBTITLE: CSSProperties = { fontSize: 13.5, color: '#3a3a3a' }

const FAILURE_SUBTITLE: CSSProperties = { ...ROW_SUBTITLE, color: '#b3261e' }

/** The status word's look (bold, the status tone). */
const STATUS: CSSProperties = { fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap' }

const DATE: CSSProperties = { fontSize: 13.5, color: '#5e5e5e', whiteSpace: 'nowrap' }

/** The Show/Hide-details toggle (the board's quiet text button). */
const TOGGLE: CSSProperties = { fontSize: 13.5, padding: '2px 4px' }

/** The expanded block's loading area (the detail is on its way). */
const LOADING_BLOCK: CSSProperties = {
  borderTop: '1px solid #e7e5e0',
  padding: '14px 18px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  background: '#fbfaf8',
  borderRadius: '0 0 8px 8px',
}

/**
 * The board's subtitle sentence. `null` when no segment exists (the line
 * omits entirely — never an empty spacer). A stopped/failed row with a
 * reason READS the reason line here instead (the board's failed row: the
 * provider's detail verbatim, in the failure red).
 */
export function subtitleFor(item: TxrHistoryItem): string | null {
  const reason = reasonLine(item.bucket, item.reason)
  if (reason !== null) return reason
  const segments: string[] = []
  if (item.methods.length > 1) {
    segments.push(item.methods.map(method => method.id).join(', '))
  }
  if (item.mode === 'reuse') {
    if (item.predicted != null) {
      segments.push(`Predicted ${item.predicted} ${item.predicted === 1 ? 'patient' : 'patients'}`)
    }
    segments.push(endpointLabel(item.endpoint, item.look_ahead_day))
    return segments.join(' · ')
  }
  const learned =
    item.learned_from != null
      ? `learned from ${item.learned_from} ${item.learned_from === 1 ? 'patient' : 'patients'}`
      : null
  const predicted = item.predicted != null ? `predicted ${item.predicted}` : null
  const pair = [learned, predicted].filter(Boolean).join(', ')
  if (pair.length > 0) segments.push(pair)
  segments.push(`decision day ${item.decision_day}`, endpointLabel(item.endpoint, item.look_ahead_day))
  return segments.join(' · ')
}

export interface TxrHistoryCardProps {
  /** The run row (the store's list item). */
  item: TxrHistoryItem
  /** Whether this row is the one expanded row (the store's `expandedId`). */
  expanded: boolean
  /** The expanded row's detail (the store's `detail`; null while loading
   *  or after a failed/404 fetch — the card keeps the collapsed data). */
  detail: TxrHistoryDetail | null
  detailLoading: boolean
  isDesktop: boolean
  /** The toggle (the store's `expand` — one expanded row at a time). */
  onToggle: (runId: string) => void
  onOpenResults?: (runId: string) => void
  onOpenRunning?: (runId: string) => void
  onRerun?: (runId: string) => void
  onSettingsAgain?: (runId: string) => void
  onDownload?: (runId: string) => void
  onReveal?: (runId: string) => void
  onLog?: (runId: string) => void
  onOpenSet?: (setId: string) => void
}

export function TxrHistoryCard({
  item,
  expanded,
  detail,
  detailLoading,
  isDesktop,
  onToggle,
  onOpenResults,
  onOpenRunning,
  onRerun,
  onSettingsAgain,
  onDownload,
  onReveal,
  onLog,
  onOpenSet,
}: TxrHistoryCardProps) {
  const chip = modeChip(item.mode)
  const status = statusLabel(item.bucket)
  const subtitle = subtitleFor(item)
  const failed = item.bucket === 'failed' || item.bucket === 'stopped'
  const openDetail = expanded && detail !== null && detail.id === item.id
  const rowStyle: CSSProperties = {
    borderWidth: expanded ? 2 : 1,
    borderStyle: 'solid',
    borderColor: expanded ? '#1d4e89' : '#cfcdc7',
    borderRadius: 10,
    background: '#ffffff',
  }
  return (
    <li data-testid={`txr-history-row-${item.id}`} style={rowStyle}>
      <div style={HEADER_ROW}>
        <div style={TITLE_BLOCK}>
          <div style={ROW_TITLE}>{titleFor(item)}</div>
          {subtitle !== null ? (
            <div data-testid={`txr-history-subtitle-${item.id}`} style={failed ? FAILURE_SUBTITLE : ROW_SUBTITLE}>
              {subtitle}
            </div>
          ) : null}
        </div>
        <span
          data-testid={`txr-history-chip-${item.id}`}
          data-tone={chip.tone}
          style={{ ...CHIP_PILL, ...TXRHISTORY_CHIP_TONES[chip.tone] }}
        >
          {chip.label}
        </span>
        <span
          data-testid={`txr-history-status-${item.id}`}
          style={{ ...STATUS, color: status.tone }}
        >
          {status.text}
        </span>
        <span style={DATE}>{formatDate(item.created_at)}</span>
        <Button
          data-testid={`txr-history-toggle-${item.id}`}
          variant="link"
          style={TOGGLE}
          aria-expanded={expanded}
          onClick={() => onToggle(item.id)}
        >
          {expanded ? 'Hide details' : 'Show details'}
        </Button>
      </div>
      {expanded && detailLoading ? (
        <div data-testid={`txr-history-detail-loading-${item.id}`} style={LOADING_BLOCK}>
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : null}
      {openDetail ? (
        <TxrHistoryDetailBlock
          detail={detail}
          isDesktop={isDesktop}
          onOpenResults={onOpenResults}
          onOpenRunning={onOpenRunning}
          onRerun={onRerun}
          onSettingsAgain={onSettingsAgain}
          onDownload={onDownload}
          onReveal={onReveal}
          onLog={onLog}
          onOpenSet={onOpenSet}
        />
      ) : null}
    </li>
  )
}
