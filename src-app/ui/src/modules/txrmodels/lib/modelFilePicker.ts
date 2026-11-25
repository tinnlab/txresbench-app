/**
 * txrmodels — the `models.openModelFile` picker channel (the human-gesture
 * half of the registered action). A browser file picker can only open from
 * the human's OWN gesture, so the action cannot click the hidden input
 * itself (the agent path has no gesture at all). Instead:
 *
 * - a mounted picker host (the Start card, the Models page — every
 *   `useModelFileImport` mount) registers its hidden input through
 *   `registerModelFilePicker`;
 * - `models.openModelFile` asks `requestModelFilePicker()`: answered (the
 *   host is mounted AND a user activation is active) → the picker opens in
 *   place, over the page the click happened on; unanswered (no host — the
 *   agent's path — or no user activation) → the action navigates to the
 *   Models page and returns the "choose the model file there" line.
 *
 * ONE slot (a host wins), mirroring `models.deleteSet`'s request-channel
 * pattern (`lib/setActions.ts`): the answer is synchronous and stays in the
 * click's user-activation window.
 */
export type ModelFilePickerHandler = () => boolean

let handler: ModelFilePickerHandler | null = null

/** Ask the mounted picker host (if any) to open the `.txr` picker.
 *  `true` = a host answered (the picker is opening); `false` = no host. */
export function requestModelFilePicker(): boolean {
  return handler !== null ? handler() : false
}

/** Register the host's picker; returns the unregister (the host's cleanup). */
export function registerModelFilePicker(next: ModelFilePickerHandler): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}
