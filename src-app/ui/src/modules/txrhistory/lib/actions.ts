/**
 * txrhistory capability resolution (PROV-HIST-4) — the K row's action
 * affordances, derived from the run record's own capability flags and the
 * desktop mode. The output shape is `TxrHistoryActions` (types.ts); a
 * `false` flag HIDES its control, never a dead one (INV-3 — every offered
 * action works on its provider route).
 *
 * The resolution rules (DEC-6 / PROV-HIST-4 / TEST-HIST-6):
 *
 * - "Open the results" is the finished-rows action (`can_reopen` =
 *   `predictions_ready`); a RUNNING row never offers it — that row's
 *   action is "Open the running run" (`openRunning`), the F screen link;
 * - "Run again with the same settings" is the `can_rerun` row (stored
 *   input copies exist — the engine replays them); a copy-cleared row
 *   (and only that row) offers "Use these settings again" — the settings
 *   prefill (DEC-6). The two are EXCLUSIVE: `rerun` and `settingsAgain`
 *   are never both true, and a running row offers neither.
 * - "Download predictions" follows `can_download`.
 * - "Open the folder" is a terminal-run affordance and desktop-only:
 *   `revealRunDir` is the ui-results helper with its own `isDesktop()`
 *   gate (PROV-UR-7, GAP-HIST-4); web mode renders the path text
 *   instead, so `reveal` is false there (TEST-HIST-6).
 * - "Show the log" is every row's affordance — the log dialog's data is
 *   the engine's run log, independent of the run's state.
 *
 * Pure: no route navigation, no client call — the page binds the flags to
 * the providers' builders/actions.
 */
import type { TxrHistoryItem } from '@/api-client/types'
import type { TxrHistoryActions } from '../types'

/** The row facts the resolution reads (the list row and the expanded
 *  detail share the four fields — both shapes satisfy this pick, so the
 *  expanded block resolves actions against the loaded detail record). */
export type TxrActionFacts = Pick<
  TxrHistoryItem,
  'bucket' | 'can_reopen' | 'can_rerun' | 'can_download'
>

/**
 * The K row's action flags. `isDesktop` is the host mode (the PROV-UR-7
 * helper's own gate — K never re-derives it).
 */
export function actionsFor(item: TxrActionFacts, options: { isDesktop: boolean }): TxrHistoryActions {
  const running = item.bucket === 'running'
  return {
    openResults: item.can_reopen && !running,
    openRunning: running,
    rerun: item.can_rerun,
    settingsAgain: !item.can_rerun && !running,
    download: item.can_download,
    reveal: !running && options.isDesktop,
    log: true,
  }
}
