// TEST-15 [covers ITEM-7] — the multipart part filename is the picked file's
// directory-RELATIVE path when it has one, and its bare name when it does not (#160).
//
// WHY THIS IS A TEST AND NOT A ONE-LINE READ. The server decides which declared member
// an uploaded part satisfies by comparing as many TRAILING path segments as the member
// declares. A part sent under its bare name can only ever answer a declaration that
// carries no directory — which is why a nested bundle arrived as three copies of one
// name and grouped into nothing. So the assertion is on the BUILT `FormData`, part by
// part: what actually goes on the wire.
//
// The other half is the regression: `webkitRelativePath` is `''` for every picker
// except a `webkitdirectory` one, so every path that worked before must still send the
// bare name, byte for byte. Both arms are asserted over the same call.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ upload: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Dataset: {
      upload: api.upload,
      listMine: vi.fn(async () => []),
      listShared: vi.fn(async () => []),
      listFolders: vi.fn(async () => []),
    },
  },
}))
// The store is self-gated on a permission and echoes a sync frame per created dataset;
// neither is what this suite is about, so both are stubbed to a no-op.
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => false }))
vi.mock('@/core/sync/localEcho', () => ({ echoLocalSync: async () => {} }))

const { Datasets, uploadErrorMessage } = await import('./Datasets.store')

/** A picked entry that carries its directory-relative path (what a `webkitdirectory`
 *  picker produces). `File.webkitRelativePath` is read-only, hence `defineProperty`. */
function pickedAt(relativePath: string): File {
  const f = new File(['x'], relativePath.slice(relativePath.lastIndexOf('/') + 1))
  Object.defineProperty(f, 'webkitRelativePath', { value: relativePath })
  return f
}

/** A picked entry with NO relative path — every non-directory picker. */
const picked = (name: string): File => new File(['x'], name)

/** The `file` part filenames of the single `FormData` the store built. */
function sentNames(): string[] {
  expect(api.upload).toHaveBeenCalledTimes(1)
  const form = api.upload.mock.calls[0][0] as FormData
  return form.getAll('file').map(p => (p as File).name)
}

beforeEach(() => {
  api.upload.mockReset()
  api.upload.mockResolvedValue({ datasets: [] })
})

describe('TEST-15 — the part filename carries the relative path (ITEM-7, #160)', () => {
  it('uploadFiles: a directory-picked entry is sent under its relative path', async () => {
    await Datasets.uploadFiles([pickedAt('a/b/c.bin'), picked('loose.bin')])
    expect(sentNames()).toEqual(['a/b/c.bin', 'loose.bin'])
  })

  it('uploadTyped: every primary part carries its own path, in order', async () => {
    await Datasets.uploadTyped({
      datatype: 'x/container',
      files: [
        pickedAt('root/bin_a/table.tsv'),
        pickedAt('root/bin_b/table.tsv'),
        picked('table.tsv'),
      ],
    })
    // Three parts, THREE distinct filenames — a store that sent `f.name` would send
    // the same string three times, which is exactly the defect.
    expect(sentNames()).toEqual(['root/bin_a/table.tsv', 'root/bin_b/table.tsv', 'table.tsv'])
    expect(new Set(sentNames()).size).toBe(3)
  })

  it('uploadTyped: a SUPPORTING part follows the same rule', async () => {
    await Datasets.uploadTyped({
      datatype: 'x/container',
      files: [picked('primary.bin')],
      supporting: [
        { file: pickedAt('root/notes/table.csv'), axis: 'rows' },
        { file: picked('other.csv'), axis: 'rows' },
      ],
    })
    expect(sentNames()).toEqual(['primary.bin', 'root/notes/table.csv', 'other.csv'])
  })

  it('the REGRESSION: with no relative path anywhere, every part filename is the name', async () => {
    const names = ['one.bin', 'two.tsv', 'three.json']
    await Datasets.uploadTyped({
      datatype: 'x/container',
      files: names.map(picked),
      slots: { one: 'one.bin' },
    })
    expect(sentNames()).toEqual(names)
    // And the declared type + slot map still ride along untouched.
    const form = api.upload.mock.calls[0][0] as FormData
    expect(form.get('datatype')).toBe('x/container')
    expect(form.get('slots')).toBe(JSON.stringify({ one: 'one.bin' }))
  })

  it('an empty relative path is treated as absent, not sent as an empty name', async () => {
    const f = picked('plain.bin')
    Object.defineProperty(f, 'webkitRelativePath', { value: '' })
    await Datasets.uploadFiles([f])
    expect(sentNames()).toEqual(['plain.bin'])
  })
})

// TEST-26 [covers ITEM-7 / the round-4 CRITICAL] — the server's own refusal reaches the user.
//
// The SDK's progress transport is XMLHttpRequest, and its non-2xx path rejects with
// `HTTP error! status: <n>` WITHOUT reading `xhr.responseText`; the body parsing that
// extracts `{error, error_code}` lives only in its `fetch` branch, which an upload never
// takes. So every refusal this item words carefully — naming exactly which declared
// members are missing — arrived as an unactionable status line. `uploadErrorMessage` is the
// recovery, and it is asserted here directly because the store's transport is the SDK's.
describe('TEST-26 — the upload error the user sees is the SERVER\'s message', () => {
  const xhrWith = (responseText: string): XMLHttpRequest =>
    ({ responseText }) as unknown as XMLHttpRequest

  it('prefers the server\'s worded refusal over the transport\'s status line', () => {
    const body = JSON.stringify({
      error:
        "'demo/nested-container' is a multi-file type whose 12 declared members must " +
        'jointly form ONE dataset, and this upload does not supply them: no file matches ' +
        "'grid_016/geo/scale.json'. Nothing was created.",
      error_code: 'MANIFEST_GROUP_INCOMPLETE',
    })
    const shown = uploadErrorMessage(new Error('HTTP error! status: 400'), xhrWith(body))
    expect(shown).toContain('grid_016/geo/scale.json')
    expect(shown).toContain('Nothing was created')
    // …and NOT the thing the user used to get.
    expect(shown).not.toContain('HTTP error! status')
  })

  it('falls back safely on every shape a body can take', () => {
    const err = new Error('HTTP error! status: 500')
    // no xhr at all (a fetch-branch failure, or a network error before send)
    expect(uploadErrorMessage(err, null)).toBe('HTTP error! status: 500')
    // an empty body
    expect(uploadErrorMessage(err, xhrWith(''))).toBe('HTTP error! status: 500')
    // not JSON (a proxy's HTML error page)
    expect(uploadErrorMessage(err, xhrWith('<html>502</html>'))).toBe('HTTP error! status: 500')
    // JSON without an `error`, and JSON whose `error` is not a string — neither may render
    // as `[object Object]` or throw.
    expect(uploadErrorMessage(err, xhrWith('{"error_code":"X"}'))).toBe('HTTP error! status: 500')
    expect(uploadErrorMessage(err, xhrWith('{"error":{"m":1}}'))).toBe('HTTP error! status: 500')
    expect(uploadErrorMessage(err, xhrWith('{"error":"   "}'))).toBe('HTTP error! status: 500')
    // a non-Error rejection, and an Error with no message
    expect(uploadErrorMessage('boom', null)).toBe('Upload failed')
    expect(uploadErrorMessage(new Error(''), null)).toBe('Upload failed')
  })
})

// TEST-27 [covers ITEM-7] — the WIRING, not the parser.
//
// TEST-26 proves `uploadErrorMessage` reads a body. It proves nothing about the store:
// delete the `__init` registration, misspell it (the SDK calls it optionally, so a typo is
// a silent no-op), or revert the catch to `error.message`, and TEST-26 stays green while the
// user is back to "HTTP error! status: 400". This drives the real `performUpload` against a
// mock that behaves like the SDK's XHR branch — hands over the handle, then rejects with the
// status line — and asserts what lands in the store.
describe('TEST-27 — the store WIRES the recovered message into uploadError', () => {
  const serverBody = JSON.stringify({
    error: "'demo/nested' needs 12 declared members: no file matches 'grid_016/geo/scale.json'.",
    error_code: 'MANIFEST_GROUP_INCOMPLETE',
  })

  beforeEach(() => {
    api.upload.mockReset()
  })

  it('the message the store shows is the SERVER body, not the transport status line', async () => {
    let handedOver: unknown = 'never called'
    api.upload.mockImplementation(async (_form: FormData, opts: any) => {
      // Exactly what the SDK does: `fileUploadProgress.__init?.(xhr)` before send, then a
      // bare status-line rejection on a non-2xx.
      handedOver = opts?.fileUploadProgress?.__init
      opts?.fileUploadProgress?.__init?.({ responseText: serverBody } as XMLHttpRequest)
      throw new Error('HTTP error! status: 400')
    })

    await expect(
      Datasets.uploadTyped({ datatype: 'demo/nested', files: [new File(['x'], 'a.h5')] }),
    ).rejects.toThrow()

    expect(typeof handedOver, 'the store must REGISTER the __init seam').toBe('function')
    const shown = Datasets.$.uploadError
    expect(shown).toContain('grid_016/geo/scale.json')
    expect(shown).not.toContain('HTTP error! status')
    expect(Datasets.$.uploading).toBe(false)
  })

  it('falls back to the transport message when the seam hands over nothing', async () => {
    api.upload.mockImplementation(async () => {
      throw new Error('Network error during file upload')
    })
    await expect(
      Datasets.uploadTyped({ datatype: 'demo/nested', files: [new File(['x'], 'a.h5')] }),
    ).rejects.toThrow()
    expect(Datasets.$.uploadError).toBe('Network error during file upload')
  })
})
