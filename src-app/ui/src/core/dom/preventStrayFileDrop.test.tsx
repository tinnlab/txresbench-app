// @vitest-environment jsdom
/**
 * preventStrayFileDrop — the window-level guard that stops the browser's
 * default file-drop navigation (a dropped file replacing the app / the tab)
 * while leaving the upload boxes untouched:
 *
 *  - a file `drop` anywhere OUTSIDE a box is `preventDefault`ed, so the
 *    webview never navigates to the dropped file (the desktop half of the fix
 *    is the harness's `on_navigation` file: refusal, sdk/desktop/harness);
 *  - a file `drop` ON a box (an element with `data-file-dropzone`) is
 *    `preventDefault`ed too, and the box's own drop handler still receives the
 *    event (the window listener runs last in the bubble order and never calls
 *    stopPropagation);
 *  - a file `dragover` outside a box is `preventDefault`ed AND its `dropEffect`
 *    is forced to 'none' (the cursor shows "not allowed");
 *  - a file `dragover` on a box is `preventDefault`ed and the box's `dropEffect`
 *    is left untouched (its copy cursor survives);
 *  - a drag without files (text) is left alone;
 *  - the returned cleanup actually removes the listeners.
 *
 * jsdom has no `DragEvent`/`DataTransfer`, so the events are plain `Event`s
 * carrying a fake `dataTransfer` (same stand-in FilesPage.test.tsx uses).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { preventStrayFileDrop } from './preventStrayFileDrop'
import { TxrFileDrop } from '@/modules/txrintake/components/TxrFileDrop'

/** A cancelable, bubbling drag event with a fake `dataTransfer`. */
function fileDragEvent(
  type: 'dragover' | 'drop',
  dataTransfer: Record<string, unknown> & { dropEffect?: string },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: dataTransfer,
    configurable: true,
  })
  return event
}

/** An upload box the test owns: an element carrying the `data-file-dropzone`
 *  marker, with a child that the drag targets (closest must find the box from
 *  the child). */
function makeBox(): { box: HTMLElement; target: HTMLElement } {
  const box = document.createElement('div')
  box.setAttribute('data-file-dropzone', '')
  const target = document.createElement('p')
  box.appendChild(target)
  document.body.appendChild(box)
  activeBoxes.push(box)
  return { box, target }
}

const activeBoxes: HTMLElement[] = []

/** The guard installed during the current test (uninstalled after each test,
 *  so a failure leaks no listeners into the next spec). */
let activeRemove: (() => void) | null = null
function installGuard(): void {
  activeRemove = preventStrayFileDrop()
}

afterEach(() => {
  activeRemove?.()
  activeRemove = null
  cleanup()
  for (const box of activeBoxes.splice(0)) box.remove()
})

describe('preventStrayFileDrop', () => {
  it('a file drop on the document body is prevented (no file:// navigation)', () => {
    installGuard()
    const event = fileDragEvent('drop', { types: ['Files'], files: [] })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('a file drop on a box is prevented and the box handler still gets the file', () => {
    installGuard()
    const { box, target } = makeBox()
    const received: File[] = []
    box.addEventListener('drop', event => {
      const dt = (event as DragEvent).dataTransfer
      if (dt) received.push(...Array.from(dt.files))
    })
    const file = new File(['patient_id\nP0001\n'], 'patients.csv', { type: 'text/csv' })
    const drop = fileDragEvent('drop', { types: ['Files'], files: [file] })
    target.dispatchEvent(drop)
    expect(received).toEqual([file])
    expect(drop.defaultPrevented).toBe(true)
  })

  it('a file dragover outside a box is prevented and the cursor shows "not allowed"', () => {
    installGuard()
    const dataTransfer = { types: ['Files'], files: [] as File[], dropEffect: 'copy' }
    const event = fileDragEvent('dragover', dataTransfer)
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(dataTransfer.dropEffect).toBe('none')
  })

  it('a file dragover on a box is prevented and the box effect is left alone', () => {
    installGuard()
    const { target } = makeBox()
    const dataTransfer = { types: ['Files'], files: [] as File[], dropEffect: 'copy' }
    const event = fileDragEvent('dragover', dataTransfer)
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(dataTransfer.dropEffect).toBe('copy')
  })

  it('a file drop on a kit Upload box still reaches the box handler', () => {
    installGuard()
    const onPick = vi.fn()
    render(<TxrFileDrop kind="patients" busy={false} onPick={onPick} />)
    // The kit Upload marks its dropzone (role="button") with
    // data-file-dropzone; the guard's target.closest must find it.
    const dropzone = screen
      .getByTestId('txr-intake-file-drop-patients')
      .querySelector('[data-file-dropzone]') as HTMLElement
    expect(dropzone).not.toBeNull()
    const file = new File(['patient_id\nP0001\n'], 'patients.csv', { type: 'text/csv' })
    const event = fileDragEvent('drop', { types: ['Files'], files: [file] })
    fireEvent(dropzone, event)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(file)
    // The box's own onDrop preventDefaults (its handler stops the navigation
    // default for its own drop); the window guard must not have interfered.
    expect(event.defaultPrevented).toBe(true)
  })

  it('a drag without files (text) is left alone', () => {
    installGuard()
    const over = fileDragEvent('dragover', { types: ['text/plain'] })
    document.body.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(false)
    const drop = fileDragEvent('drop', { types: ['text/plain'] })
    document.body.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(false)
  })

  it('the cleanup removes the listeners', () => {
    installGuard()
    activeRemove?.()
    activeRemove = null
    const event = fileDragEvent('drop', { types: ['Files'], files: [] })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
