// @vitest-environment jsdom
/**
 * Upload — the marker the app's stray-file-drop guard relies on. The app
 * installs window-level `dragover`/`drop` listeners
 * (src-app/ui/src/core/dom/preventStrayFileDrop.ts) that stop the browser's
 * default file-open navigation; they must not disturb a drop onto an Upload
 * box, and they decide "inside a box" by the `data-file-dropzone` marker. If
 * the marker moves off the dropzone, the guard loses every Upload on every
 * screen — so the kit asserts it here, at the source.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Upload } from './upload'

describe('Upload', () => {
  afterEach(cleanup)

  it('the dropzone root carries the data-file-dropzone marker', () => {
    render(
      <Upload onFiles={() => {}} label="Pick a file" data-testid="up">
        <span>Drop here</span>
      </Upload>,
    )
    const marker = document.querySelector('[data-file-dropzone]')
    expect(
      marker,
      'the kit must mark its dropzone so the app-level stray-file-drop guard can find every Upload box',
    ).not.toBeNull()
    // The marker sits on the dropzone itself (the role="button" element the
    // drag events hit), not on the display:contents wrapper that carries the
    // testid — a drop anywhere inside the zone must resolve to the box.
    expect(marker?.getAttribute('role')).toBe('button')
    expect(marker?.parentElement?.getAttribute('data-testid')).toBe('up')
  })
})
