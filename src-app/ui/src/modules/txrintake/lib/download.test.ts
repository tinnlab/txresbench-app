// @vitest-environment jsdom
/**
 * TEST-INT-8's download rows (the ITEM-6 part — `lib/download.ts` ships
 * here because the C/N cards' download links are ITEM-6's content; the
 * module's fixture rows of the same row stay with ITEM-8/11):
 * `downloadText` saves a `text/csv` Blob under the right filename and
 * revokes the object URL (the ProvenanceExport precedent); the filename
 * convention is `<kind>_template.csv` / `<kind>_example.csv`; the
 * fetch helper goes through the generated client with the byte guard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadText, fetchTemplateCsv, templateFilename } from './download'

const api = vi.hoisted(() => ({
  template: vi.fn(),
  example: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    FileValidation: {
      template: api.template,
      example: api.example,
    },
  },
}))

const createObjectURL = vi.fn((_blob: Blob) => 'blob:txr-test')
const revokeObjectURL = vi.fn((url: string) => {})

// jsdom implements no `download` attribute navigation: a real anchor click
// would fire its "Not implemented: navigation" path (a leftover timer that
// starves later tests on a loaded box). Stub the click and assert it; the
// blob + filename + revoke facts are the real code path's.
const clickSpy = vi.fn()
beforeEach(() => {
  clickSpy.mockClear()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  api.template.mockReset()
  api.example.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    value: clickSpy,
    writable: true,
    configurable: true,
  })
})

describe('lib/download.ts (TEST-INT-8 rows, ITEM-6)', () => {
  it('downloadText saves a text/csv blob, names it and revokes the object URL', () => {
    const createElement = vi.spyOn(document, 'createElement')
    const appendChild = vi.spyOn(document.body, 'appendChild')
    downloadText('patients_template.csv', 'patient_id,pfs_days\nP0001,214\n')

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const args = createObjectURL.mock.calls[0][0]
    expect(args.type).toBe('text/csv;charset=utf-8')
    expect(args.size).toBeGreaterThan(0)

    const anchor = createElement.mock.results
      .map(result => result.value)
      .find(value => value instanceof HTMLAnchorElement) as HTMLAnchorElement
    expect(anchor.download).toBe('patients_template.csv')
    expect(anchor.href).toBe('blob:txr-test')
    expect(appendChild).toHaveBeenCalledWith(anchor)
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:txr-test')
    createElement.mockRestore()
    appendChild.mockRestore()
  })

  it('names the downloads by the file kind and source', () => {
    expect(templateFilename('patients', 'template')).toBe('patients_template.csv')
    expect(templateFilename('measurements', 'example')).toBe('measurements_example.csv')
  })

  it('fetchTemplateCsv goes through the generated client and returns the CSV text', async () => {
    api.template.mockResolvedValue('patient_id,pfs_days\n')
    expect(await fetchTemplateCsv('patients', 'template')).toBe('patient_id,pfs_days\n')
    expect(api.template).toHaveBeenCalledWith({ kind: 'patients' })

    api.example.mockResolvedValue('patient_id,day,marker,value\n')
    expect(await fetchTemplateCsv('measurements', 'example')).toBe(
      'patient_id,day,marker,value\n',
    )
    expect(api.example).toHaveBeenCalledWith({ kind: 'measurements' })
  })

  it('refuses an empty body instead of saving nothing (the byte guard)', async () => {
    api.template.mockResolvedValue('')
    await expect(fetchTemplateCsv('patients', 'template')).rejects.toThrow(
      'the patients template came back empty',
    )
    api.template.mockResolvedValue(undefined)
    await expect(fetchTemplateCsv('patients', 'template')).rejects.toThrow(
      'the patients template came back empty',
    )
  })
})
