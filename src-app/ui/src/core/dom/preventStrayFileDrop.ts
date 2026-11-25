/**
 * preventStrayFileDrop — window-level guard against the browser's default
 * file-drop navigation.
 *
 * ## Why this exists
 *
 * The desktop shell turns Tauri's drag-drop handler OFF so the page's own HTML
 * drag and drop reaches the upload boxes. With Tauri's handler off, a drop
 * ANYWHERE else in the window does what a plain browser tab does: the webview
 * navigates to the dropped file and shows its content — the whole app is
 * replaced, with no way back except quitting. The website has the same default:
 * a drop outside a box replaces the tab.
 *
 * ## What it does
 *
 * A single pair of window-level `dragover` / `drop` listeners, installed once
 * at app start:
 *  - `drop`: a drag that carries files is `preventDefault`ed wherever it lands,
 *    inside a box or not. The box's own handler has already run in the bubble
 *    order and has the files, so this only stops the browser from opening the
 *    file — never the box.
 *  - `dragover`: a drag that carries files is `preventDefault`ed so the browser
 *    recognises the drop. Outside a box the `dropEffect` is also forced to
 *    'none' (the cursor shows "not allowed"); inside a box the effect is left
 *    untouched so the box keeps its copy cursor.
 *  - A drag without files (e.g. selected text) is left alone.
 *
 * The guard never calls `stopPropagation`.
 *
 * ## How "inside a box" is decided
 *
 * By a marker: an upload box is simply an element carrying
 * `data-file-dropzone`. The kit `Upload` (sdk/packages/kit/src/kit/upload.tsx)
 * puts that attribute on its dropzone root, so every screen that mounts a kit
 * Upload is recognised without the guard knowing any page or DOM structure.
 *
 * ## Cleanup
 *
 * Returns an uninstall function so a test can prove the listeners leave no
 * trace. Installation is idempotent per target (an HMR re-run of the entry does
 * not double-register); the uninstall from a re-entry call is a no-op, exactly
 * like `installChunkLoadRecovery`.
 */

type ListenerTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

/** True when the drag carries FILES (the browser exposes the kind in
 *  `dataTransfer.types`, e.g. "Files"; a text-selection drag carries
 *  "text/plain" — left alone by the guard). */
function carriesFiles(event: Event): boolean {
  const types = (event as DragEvent).dataTransfer?.types
  return types != null && Array.from(types).includes('Files')
}

/** The nearest element carrying the `data-file-dropzone` marker, or null. */
function closestDropZone(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null
  return target.closest('[data-file-dropzone]')
}

/** Targets that already carry the guard — PER TARGET, not a module boolean, so
 *  an uninstalled window and a fresh test window each get their own listeners
 *  (the same discipline as `installChunkLoadRecovery`). */
const installedTargets = new WeakSet<ListenerTarget>()

/**
 * Install the stray-file-drop guard. The default target is `window`; the
 * parameter exists for tests.
 *
 * @returns an uninstall function.
 */
export function preventStrayFileDrop(
  target: ListenerTarget | undefined = typeof window === 'undefined'
    ? undefined
    : window,
): () => void {
  if (!target || installedTargets.has(target)) return () => {}
  installedTargets.add(target)

  const onDragOver = (event: Event) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    // The box keeps its own dropEffect (the copy cursor); only a drop
    // OUTSIDE a box shows "not allowed".
    if (closestDropZone(event.target) !== null) return
    const dataTransfer = (event as DragEvent).dataTransfer
    if (dataTransfer) dataTransfer.dropEffect = 'none'
  }

  const onDrop = (event: Event) => {
    if (!carriesFiles(event)) return
    // Inside or outside a box: the box's own handler already ran (it gets the
    // event first in the bubble order and has the files), so preventDefault
    // here only stops the browser's file-open default.
    event.preventDefault()
  }

  target.addEventListener('dragover', onDragOver)
  target.addEventListener('drop', onDrop)
  return () => {
    target.removeEventListener('dragover', onDragOver)
    target.removeEventListener('drop', onDrop)
    installedTargets.delete(target)
  }
}
