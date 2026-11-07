/**
 * txrhistory run-title + model-link builders (PROV-HIST-4) — the K card's
 * title line and the detail's model-set links, from the run record ONLY.
 * Nothing here derives a name or a count the provider did not record
 * (GAP-HIST-2's honesty rule: a REUSE run's title names the consumed SET
 * only when the record carries it — never a fabricated name, never a
 * fake count).
 *
 * The title matrix (DEC-9):
 *
 * - train: "N methods on patients.csv + new_measurements.csv" — the
 *   provider's `file_names` in the run's own order, joined with the
 *   board's " + "; with no file names (GAP-HS-1 un-grown) the title is
 *   "N methods";
 * - reuse, grown (the provider's `models_used` carries the consumed
 *   set): "Model CRC cohort, day 56 on march_new.csv" — ONE distinct set
 *   name; the un-grown form ("Saved models on <file>" / "Saved models")
 *   is the honest fallback for a reuse run whose record names no single
 *   set (an empty list, or several distinct sets — the board's title
 *   shows one set and no join idiom is the board's).
 *
 * `modelLinks` returns the detail's saved sets with their names only —
 * a set with an unrecorded/blank name is dropped, never given an invented
 * one (the links render from `set_name` verbatim).
 */
import type { TxrHistoryItem, TxrHistoryModelsMade } from '@/api-client/types'

/** One model-set link of the K detail's "Made" line (the ui-models
 *  `modelsPath(setId)` target's facts — PROV-UI-MODELS-1, DEC-5). */
export interface TxrModelSetLink {
  setId: string
  setName: string
}

/** The distinct, non-blank set names of a reuse run's consumed models,
 *  in the provider's order, deduplicated by name. */
function distinctSetNames(models: TxrHistoryItem['models_used']): string[] {
  const names: string[] = []
  for (const model of models) {
    if (model.set_name.trim().length === 0) continue
    if (!names.includes(model.set_name)) names.push(model.set_name)
  }
  return names
}

/**
 * The K card's title (board words, DEC-9). The board's own example
 * titles are DESIGN examples — this function renders whatever the run
 * record carries (INV-6).
 */
export function titleFor(item: TxrHistoryItem): string {
  const files = item.file_names.join(' + ')
  if (item.mode === 'reuse') {
    const setNames = distinctSetNames(item.models_used)
    if (setNames.length === 1) {
      return files.length > 0 ? `Model ${setNames[0]} on ${files}` : `Model ${setNames[0]}`
    }
    return files.length > 0 ? `Saved models on ${files}` : 'Saved models'
  }
  const word = item.method_count === 1 ? 'method' : 'methods'
  return files.length > 0 ? `${item.method_count} ${word} on ${files}` : `${item.method_count} ${word}`
}

/**
 * The detail's named model-set links (DEC-5): every saved set whose name
 * the record carries, verbatim, in the provider's order. A set with a
 * blank/unrecorded name is skipped — the "Made" line never fabricates a
 * link label.
 */
export function modelLinks(savedSets: TxrHistoryModelsMade['saved_sets']): TxrModelSetLink[] {
  const links: TxrModelSetLink[] = []
  for (const set of savedSets) {
    if (set.set_name.trim().length === 0) continue
    links.push({ setId: set.set_id, setName: set.set_name })
  }
  return links
}
