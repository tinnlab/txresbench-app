/**
 * TxrDownloadState — the D screen's per-card download view (PROV-UI-MODELS-5,
 * the PROV-PC-6 / CONS-UM-20 download manager; ITEM-6).
 *
 * Screen D owns the pre-Run availability guarantee: a selected card whose
 * asset is not on this computer must be downloaded + verified before the
 * run can be created. The list row is the SHARED component's board row (no
 * per-row slot), so the download life is rendered by the HOST as this
 * widget — one per card with a download entry, in the D page's downloads
 * strip between the list and the bottom bar. The widget is the
 * environment-download idiom applied to an asset download (the same
 * vocabulary the F screen's method-env line uses: bytes + total + a
 * progress view — one order of magnitude simpler, a request/response
 * manager, no SSE).
 *
 * States (all never-blank):
 *
 * - `downloading` — the spinner + "downloading" + the bytes line
 *   ("12.3 MB of 45.0 MB") + the percent, from the provider's
 *   `bytes_downloaded` / `bytes_total` (a null total renders the bytes
 *   only — the F-row precedent);
 * - `ready` — the verified asset: a done line (the D Run is now enabled
 *   for the card; the entry leaves the strip on its own);
 * - `failed` — the provider's verify failure (`status.error`, else the
 *   module's constant) + the Retry button — a terminal provider failure is
 *   the human's call, never auto-retried (ITEM-5's schedule covers only a
 *   failed START);
 * - start failure — no status, the request-level error line + Retry
 *   (the store never reported a download state);
 * - `retrying` — the ITEM-5 hook's automatic re-issue is armed (the
 *   card's "retrying…" line while the backoff schedule is pending).
 *
 * The entry is the store's `TxrModelDownloadState` verbatim; the widget
 * only shapes its text. The bytes are formatted by the module's own
 * `formatBytes` (the ONE bytes formatter; never a second spelling).
 */
import type { CSSProperties } from 'react'
import { Button, Spinner } from '@ziee/kit'
import { formatBytes } from '../lib/format'
import type { TxrModelDownloadState } from '../types'

/** The one failure line for a provider status without one (never blank). */
const DOWNLOAD_FAILED_LINE = 'The download could not be verified.'

/** The start-failure line (the request never reached a download state). */
const DOWNLOAD_START_FAILED_LINE = 'The download could not be started.'

/** The widget line's look (the board's muted small text). */
const LINE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: '#3a3a3a',
}

/** The error line's look (the board's red). */
const ERROR_LINE: CSSProperties = { fontSize: 13, color: '#b3261e' }

/** The progress fraction: 0–100, or null when the total is unknown. */
function progressPct(entry: TxrModelDownloadState): number | null {
  const total = entry.status?.bytes_total
  if (total === undefined || total === null || total <= 0) return null
  const done = entry.status?.bytes_downloaded ?? 0
  return Math.min(100, Math.round((done / total) * 100))
}

/** The download's bytes line: "12.3 MB of 45.0 MB", or the bytes alone
 *  when the total is not yet known (the F-row precedent). */
function bytesLine(entry: TxrModelDownloadState): string {
  const done = formatBytes(entry.status?.bytes_downloaded ?? 0)
  const total = entry.status?.bytes_total
  if (total === undefined || total === null) return done
  return `${done} of ${formatBytes(total)}`
}

export interface TxrDownloadStateProps {
  /** The catalogue card id — the widget's test-id key (`txr-models-download-<id>`). */
  id: string
  /** The card's label in the strip (the mono catalogue id). */
  label: string
  /** The store's per-card view, `undefined` before any start. The page
   *  renders the widget only for cards with an entry — this widget's
   *  no-entry state is a nothing, never a blank download. */
  entry: TxrModelDownloadState | undefined
  /** The ITEM-5 hook's automatic re-issue is armed (the "retrying…" line). */
  retrying: boolean
  /** The Retry / start path (the hook's `retry`; a manual Retry cancels a
   *  pending automatic re-issue — no doubled starts). */
  onRetry: () => void
}

export function TxrDownloadState({ id, label, entry, retrying, onRetry }: TxrDownloadStateProps) {
  const state = entry?.status?.state ?? null

  if (state === 'downloading') {
    // `state` derives from `entry?.status` — a `downloading` branch implies
    // the entry exists; the type-safe read is the narrowed object.
    const download = entry as TxrModelDownloadState
    return (
      <span data-testid={`txr-models-download-${id}`} style={LINE}>
        <Spinner label={`Downloading ${label}`} />
        <span data-testid={`txr-models-download-${id}-bytes`}>
          downloading · {bytesLine(download)}
        </span>
        <span
          data-testid={`txr-models-download-${id}-pct`}
          style={{ fontVariantNumeric: 'tabular-nums', color: '#5e5e5e' }}
        >
          {progressPct(download) === null ? '' : `${progressPct(download)}%`}
        </span>
      </span>
    )
  }

  if (state === 'ready') {
    return (
      <span data-testid={`txr-models-download-${id}-ready`} style={LINE}>
        {label} is ready
      </span>
    )
  }

  if (state === 'failed') {
    return (
      <span data-testid={`txr-models-download-${id}`} style={LINE}>
        <span data-testid={`txr-models-download-${id}-error`} data-kind="verify" style={ERROR_LINE}>
          {entry?.status?.error ?? DOWNLOAD_FAILED_LINE}
        </span>
        {retrying ? (
          <span data-testid={`txr-models-download-${id}-retrying`} style={LINE}>
            retrying…
          </span>
        ) : (
          <Button
            data-testid={`txr-models-download-${id}-retry`}
            variant="outline"
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
      </span>
    )
  }

  if (entry !== undefined && entry.status === null && entry.error !== null) {
    // A failed START: the store never reported a download state (the
    // request itself failed) — the ITEM-5 hook re-issues on the backoff
    // schedule, and the Retry path is the same start.
    return (
      <span data-testid={`txr-models-download-${id}`} style={LINE}>
        <span data-testid={`txr-models-download-${id}-error`} data-kind="start" style={ERROR_LINE}>
          {DOWNLOAD_START_FAILED_LINE}
        </span>
        {retrying ? (
          <span data-testid={`txr-models-download-${id}-retrying`} style={LINE}>
            retrying…
          </span>
        ) : (
          <Button
            data-testid={`txr-models-download-${id}-retry`}
            variant="outline"
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
      </span>
    )
  }

  return null
}
