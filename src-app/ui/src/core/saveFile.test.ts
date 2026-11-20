// @vitest-environment jsdom
//
// The one save helper (`saveFile.ts`): the website keeps the browser download
// (Blob + temporary <a download>, URL revoked); the desktop app opens the
// native Save dialog and sends the bytes to the `save_file` command with the
// chosen path in the `x-txr-save-path` header. A cancelled dialog writes
// nothing and is not an error; a failed write rejects.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SAVE_FILE_COMMAND,
  SAVE_PATH_HEADER,
  folderOf,
  revealSavedFile,
  saveFile,
  saveLabel,
  savesWithDialog,
  showSavedLabel,
} from './saveFile'

type TauriWindow = { __TAURI__?: unknown }

function captureAnchor() {
  const createObjectURL = vi.fn(() => 'blob:txr-save')
  const revokeObjectURL = vi.fn()
  const clickSpy = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    value: clickSpy,
    writable: true,
    configurable: true,
  })
  const createElement = vi.spyOn(document, 'createElement')
  const anchor = () =>
    createElement.mock.results
      .map(result => result.value)
      .find(value => value instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined
  return { createObjectURL, revokeObjectURL, clickSpy, anchor, restore: () => createElement.mockRestore() }
}

describe('saveFile on the website (no Tauri bridge)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('downloads text through a Blob + anchor and revokes the URL', async () => {
    const capture = captureAnchor()
    await expect(saveFile({ filename: 'a.csv', data: 'x,y\n1,2\n' })).resolves.toEqual({
      status: 'downloaded',
    })
    expect(capture.anchor()?.download).toBe('a.csv')
    expect(capture.anchor()?.href).toBe('blob:txr-save')
    expect(capture.clickSpy).toHaveBeenCalledTimes(1)
    expect(capture.revokeObjectURL).toHaveBeenCalledWith('blob:txr-save')
    const blob = (capture.createObjectURL.mock.calls[0] as unknown[])[0] as Blob
    expect(blob.type).toBe('text/csv;charset=utf-8')
    capture.restore()
  })

  it('downloads a Blob as given', async () => {
    const capture = captureAnchor()
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' })
    await saveFile({ filename: 'm.txr', data: blob })
    expect((capture.createObjectURL.mock.calls[0] as unknown[])[0]).toBe(blob)
    expect(capture.anchor()?.download).toBe('m.txr')
    capture.restore()
  })

  it('uses the website wording and never opens a dialog', () => {
    expect(savesWithDialog()).toBe(false)
    expect(saveLabel('Save as CSV…', 'Download CSV')).toBe('Download CSV')
  })

  it('revealing a saved file does nothing', async () => {
    await expect(revealSavedFile('/a/b.csv')).resolves.toBeUndefined()
  })
})

describe('saveFile in the desktop app (the Save dialog)', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    ;(window as unknown as TauriWindow).__TAURI__ = { core: { invoke } }
  })

  afterEach(() => {
    delete (window as unknown as TauriWindow).__TAURI__
    vi.restoreAllMocks()
  })

  it('uses the app wording', () => {
    expect(savesWithDialog()).toBe(true)
    expect(saveLabel('Save as CSV…', 'Download CSV')).toBe('Save as CSV…')
  })

  it('a cancelled dialog writes nothing', async () => {
    invoke.mockResolvedValue(null)
    const capture = captureAnchor()
    await expect(saveFile({ filename: 'a.csv', data: 'x' })).resolves.toEqual({ status: 'cancelled' })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][0]).toBe('plugin:dialog|save')
    expect(capture.anchor()).toBeUndefined()
    capture.restore()
  })

  it('writes text as UTF-8 bytes to the chosen path, the path percent-encoded in the header', async () => {
    const chosen = '/Users/me/Documents/prédictions run.csv'
    invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === 'plugin:dialog|save' ? chosen : null))
    await expect(
      saveFile({ filename: 'a.csv', data: 'é,1\n', filter: { name: 'CSV', extensions: ['csv'] } }),
    ).resolves.toEqual({ status: 'saved', path: chosen })
    expect(invoke.mock.calls[0][1]).toEqual({
      options: {
        defaultPath: 'a.csv',
        canCreateDirectories: true,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      },
    })
    const [cmd, bytes, options] = invoke.mock.calls[1]
    expect(cmd).toBe(SAVE_FILE_COMMAND)
    expect(ArrayBuffer.isView(bytes)).toBe(true)
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('é,1\n')
    expect(options).toEqual({ headers: { [SAVE_PATH_HEADER]: encodeURIComponent(chosen) } })
  })

  it('writes a Blob as its raw bytes', async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'plugin:dialog|save' ? '/Users/me/m.txr' : null),
    )
    const blob = new Blob([new Uint8Array([0, 255, 7])])
    await saveFile({ filename: 'm.txr', data: blob })
    expect(Array.from(invoke.mock.calls[1][1] as Uint8Array)).toEqual([0, 255, 7])
  })

  it('omits the filter when none is given', async () => {
    invoke.mockResolvedValue(null)
    await saveFile({ filename: 'a.bin', data: 'x' })
    expect(invoke.mock.calls[0][1]).toEqual({ options: { defaultPath: 'a.bin', canCreateDirectories: true } })
  })

  it('rejects when the write fails', async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === 'plugin:dialog|save' ? Promise.resolve('/a/b.csv') : Promise.reject(new Error('read-only')),
    )
    await expect(saveFile({ filename: 'b.csv', data: 'x' })).rejects.toThrow('read-only')
  })

  it('rejects an unexpected dialog answer instead of writing', async () => {
    invoke.mockResolvedValue(['/a/b.csv'])
    await expect(saveFile({ filename: 'b.csv', data: 'x' })).rejects.toThrow(
      'the Save dialog returned an unexpected value',
    )
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('reveals the saved file\'s folder, and swallows a failure', async () => {
    invoke.mockResolvedValueOnce(undefined)
    await revealSavedFile('/Users/me/Desktop/run.csv')
    expect(invoke).toHaveBeenCalledWith('reveal_in_file_manager', { path: '/Users/me/Desktop' })
    invoke.mockRejectedValueOnce(new Error('gone'))
    await expect(revealSavedFile('/Users/me/x.csv')).resolves.toBeUndefined()
  })
})

describe('folderOf / showSavedLabel', () => {
  it('cuts the file name, for both separators', () => {
    expect(folderOf('/a/b/c.csv')).toBe('/a/b')
    expect(folderOf('C:\\Users\\me\\c.csv')).toBe('C:\\Users\\me')
    expect(folderOf('/c.csv')).toBe('/')
  })

  it('keeps the separator of a Windows drive root, and UNC paths whole', () => {
    expect(folderOf('C:\\x.csv')).toBe('C:\\')
    expect(folderOf('d:/x.csv')).toBe('d:/')
    expect(folderOf('C:\\a\\x.csv')).toBe('C:\\a')
    expect(folderOf('\\\\server\\share\\x.csv')).toBe('\\\\server\\share')
    expect(folderOf('\\\\server\\x.csv')).toBe('\\\\server')
  })

  it('names Finder on a Mac only', () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get')
    ua.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
    expect(showSavedLabel()).toBe('Show in Finder')
    ua.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(showSavedLabel()).toBe('Show in folder')
    ua.mockRestore()
  })
})
