/**
 * txrrun — the E run-request builder (PROV-UI-RUN-2; ITEM-3).
 *
 * Pressing Run on screen E posts exactly one request: the intake store's
 * input snapshot (built by its own builder — this module never re-derives
 * the tables, joins or mapping), the settings mapped to the engine config,
 * and the selected method ids, in `mode: train`. The emitted shape is the
 * frozen engine contract (PROV-EE-2) byte for byte; the builder itself
 * computes nothing (INV-4 — the bar's time text is the list hooks' own),
 * it only carries the user's choices.
 */
import type { CreateRunRequest, SingleMarkerChoice, TxrRunInput } from '@/api-client/types'
import type { RunSettings } from './settings'
import { toRunConfig } from './settings'

/**
 * The create-run request of screen E (PROV-EE-2's frozen shape
 * `{mode, input, config, method_ids}`):
 *
 * - `mode` is the train literal — reuse-mode run creation belongs to
 *   ui-models' path (the PROV-UI-RUN-2 boundary; this builder is the
 *   train half of the same request type);
 * - `input` is the intake store's `buildTxrRunInput` result VERBATIM —
 *   the CONS-UI-RUN-13 rule, the one builder for the whole analysis;
 * - `config` is the settings through `toRunConfig` (`label_day: null` =
 *   derive from the file per the engine, DEC-7), plus the step-3 marker
 *   choice as `single_marker` (single-marker-choice round 2: how the
 *   no-list methods pick their markers — absent = the runner's ranked rule);
 * - `method_ids` is the current selection (the engine validates ≥ 1).
 */
export function buildRunRequest(
  mode: 'train',
  input: TxrRunInput,
  settings: RunSettings,
  methodIds: string[],
  singleMarkerChoice: SingleMarkerChoice | null = null,
): CreateRunRequest {
  const config = toRunConfig(settings)
  if (singleMarkerChoice !== null) config.single_marker = singleMarkerChoice
  return {
    mode,
    input,
    config,
    method_ids: methodIds,
  }
}
