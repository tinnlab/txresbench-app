/**
 * txrrun — the ITEM-2 run-bar copy layer (qa-fixes3 ITEM-2 (c)).
 *
 * The E screen's new sticky run bar reads the plan's sentence: "6 methods
 * selected · about 2 min (3 at a time on 8 CPUs)" — the selected count
 * (the picker's own, `countSelected`), the estimate's long-form total and
 * the run's lane facts, plus the "Save the trained models" switch's
 * one-line meaning and the disabled run-button reason. Every string here is
 * the redesign's plain voice; nothing derives a timing locally (INV-4 —
 * the total is the estimate response, `formatDurationShort`'s bytes).
 *
 * The CPU fact is the run's own: when the user picked a count (the More
 * settings CPU selector) the bar names it; the Auto choice resolves at run
 * start (the engine's detect-at-run-start contract), so the bar states the
 * lanes only — a count it does not know is never printed.
 */
import { formatDurationShort } from '@/modules/txrlist'

/** The run button's disabled reason (the plan's "Select at least one method"). */
export const RUN_BAR_EMPTY_REASON = 'Select at least one method'

/** The save-switch's one-line meaning (beside the label, at 13.5 px). */
export const SAVE_MODELS_MEANING =
  'Keeps each trained model so you can reuse it on new patients.'

/** The More-settings estimate fact (the plan's "the estimate explained"). */
export const ESTIMATE_EXPLAINED =
  'The times are the methods\u2019 measured benchmark run times scaled to your file, patients and CPUs.'

/** The More-settings reproducibility fact (the engine contract's fixed
 *  seed — see the drift note in DRIFT-1 ITEM-2). */
export const FIXED_SEED_FACT =
  'The analysis runs with one fixed seed, so the same settings give the same numbers.'

/**
 * The bar's time line: the long-form total plus the lanes in parentheses —
 * "about 14 minutes (3 at a time on 8 CPUs)" / "about 2 min (3 at a time)"
 * — and the loading ellipsis while the estimate is in flight (`null`
 * total). The CPU count appears only when the screen knows it (Auto names
 * no machine fact the bar did not measure).
 */
export function formatRunBarTime(
  seconds: number | null,
  atATime: number,
  cpus: number | null,
): string {
  if (seconds === null) return '…'
  const lanes = cpus === null ? `${atATime} at a time` : `${atATime} at a time on ${cpus} CPUs`
  return `${formatDurationShort(seconds)} (${lanes})`
}
