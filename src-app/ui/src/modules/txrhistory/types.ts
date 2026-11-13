/**
 * The history module's host-state vocabulary (PROV-HIST-2) — the K screen's
 * OWN words for the four filter options, the bucket/mode display words and
 * the paged view shape the store will own. The DATA vocabulary stays the
 * provider's: `TxrHistoryItem` / `TxrHistoryDetail` / `TxrHistoryBucket` /
 * `TxrHistoryKind` / `TxrHistoryUsage` / `TxrHistoryPreferences` come from
 * the generated client (`@/api-client`, provider-owned regen), and K's
 * strings map the provider's compact wire words to the board's display
 * words — the display map is the consumer's (history-store DEC-4), never a
 * third vocabulary.
 *
 * `TxrHistoryKindFilter` and `TxrHistoryStatusFilter` are the provider
 * query's `kind` / `status` parameters as the K store will send them
 * (unset = `null`, so a null filter sends no parameter); the values mirror
 * the generated `TxrHistoryKind` / `TxrHistoryBucket` unions exactly.
 * `TxrHistoryFilter` is the four board options the SELECT renders.
 */
import type { TxrHistoryItem } from '@/api-client/types'

/** The provider `kind` parameter: absent, or one of the two K modes. */
export type TxrHistoryKindFilter = 'learned' | 'saved-model' | null

/** The provider `status` parameter: absent, or one bucket of the four. */
export type TxrHistoryStatusFilter = 'running' | 'finished' | 'stopped' | 'failed' | null

/** The four board filter options ('all' sends no kind/status filter). */
export type TxrHistoryFilter = 'all' | 'learned' | 'saved-model' | 'stopped-failed'

/** The K display words for `TxrHistoryItem.bucket` (the consumer's map). */
export type TxrBucketLabel = 'running' | 'done' | 'stopped' | 'failed'

/** The K chip words for `TxrHistoryItem.mode`. */
export type TxrModeLabel = 'learned-and-predicted' | 'saved-model'

/** The paged list view the store owns (server order preserved, INV-1). */
export interface TxrHistoryView {
  items: TxrHistoryItem[]
  total: number
  page: number
  pageSize: number
  filter: TxrHistoryFilter
  q: string
}

/** The provider page default the K list binds (limit/offset paging). */
export const PAGE_SIZE = 20

/** The four K filter options, board labels verbatim. */
export const FILTER_OPTIONS: { value: TxrHistoryFilter; label: string }[] = [
  { value: 'all', label: 'All runs' },
  { value: 'learned', label: 'Learned and predicted' },
  { value: 'saved-model', label: 'Predicted with a saved model' },
  { value: 'stopped-failed', label: 'Stopped or failed' },
]

/**
 * The K row's resolved capabilities (PROV-HIST-4's `actionsFor` output) —
 * what the expanded block may offer for THIS run, from the run record's
 * capability flags (`can_reopen`, `can_rerun`, `can_download`, the
 * `bucket`) and the desktop mode. Each flag is a real capability of the
 * provider contract; a `false` flag hides its control, never a dead one.
 */
export interface TxrHistoryActions {
  openResults: boolean
  openRunning: boolean
  rerun: boolean
  settingsAgain: boolean
  download: boolean
  reveal: boolean
  log: boolean
  /**
   * qa-fixes4 ITEM-2 (f, results-r3 R3-results-4): "Delete this run" —
   * desktop mode only (the web demo runs in a browser where `isDesktop()`
   * is false, so the same gate carries the demo-mode spec's "delete and
   * clear-all hidden"; the server blocks the route in demo mode anyway).
   */
  deleteRun: boolean
}

/**
 * The K mode chip's palette words (PROV-HIST-4's `modeChip` tone) — the
 * ui-list module's own chip genres ('accent' / 'neutral', DEC-9),
 * declared here because the palette is part of the K display map; the
 * chip's hexes live with the rendering component.
 */
export type TxrChipTone = 'accent' | 'neutral'
