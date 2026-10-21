// @vitest-environment jsdom
//
// THE UPLOAD BUTTON REFUSED FOR FOUR DIFFERENT REASONS AND NAMED NONE OF THEM.
//
// `disabled={!ready}` collapsed four causes into one grey button:
//   1. no data type picked yet          — the FIRST thing a new user hits, and the one whose
//                                          remedy is furthest from the button they are staring at;
//   2. a single-file type with no file;
//   3. a manifest type in archive mode with no archive;
//   4. a manifest type in files mode with one or more member slots empty — and it did not say
//      WHICH members, which is the whole difficulty of a multi-part upload.
//
// A dialog is the worst place for this: there is no page context to infer the remedy from, and
// natively `disabled` means the control cannot even be hovered or focused to ask.
//
// Asserted on the rendered DOM after a real hover — never a console spy (base-ui dedupes
// process-wide, so a spy can pass because an earlier render consumed the message).

import { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const store = {
  uploadOpen: true,
  uploading: false,
  uploadPct: 0,
  uploadError: null as string | null,
  closeUpload: vi.fn(),
  uploadTyped: vi.fn(async () => {}),
}
vi.mock('@/modules/datasets/stores/Datasets.store', () => ({ Datasets: store }))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  globalThis.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false },
  })) as never
  ;(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

const { UploadPanel, deriveConvertibleTypes } = await import('./UploadPanel')
const { datatypeRegistry } = await import('@/core/datatypes')


afterEach(cleanup)
beforeEach(() => {
  store.uploading = false
})

const byTestId = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"]`)
  return el
}

async function hover(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.pointerEnter(el, { pointerType: 'mouse', bubbles: true })
    fireEvent.mouseOver(el, { bubbles: true })
    fireEvent.mouseEnter(el, { bubbles: true })
    fireEvent.mouseMove(el, { bubbles: true })
  })
  await act(async () => { await new Promise(r => setTimeout(r, 700)) })
}

const shown = (): string =>
  Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
    .map(t => (t.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join('|')

const describedText = (el: Element): string =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/).filter(Boolean)
    .map(id => el.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ').trim()

async function mount(seed?: Parameters<typeof UploadPanel>[0] extends infer P ? (P extends { initial?: infer I } ? I : never) : never): Promise<void> {
  await act(async () => { render(<UploadPanel initial={seed} />) })
  await act(async () => { await Promise.resolve() })
}

const submit = (): HTMLElement => byTestId('dataset-upload-submit')

/** The full contract for a refused Upload, in the order a user meets it. */
async function expectRefusal(match: RegExp): Promise<void> {
  const el = submit()
  await hover(el)
  expect(shown(), 'hovering a refused Upload must show WHY').toMatch(match)
  expect(describedText(el), 'and the reason must reach assistive tech').toMatch(match)
  expect(el.getAttribute('aria-disabled')).toBe('true')
  expect(
    el.hasAttribute('disabled'),
    'a natively disabled button is pointer-events:none AND out of the tab order',
  ).toBe(false)
}

describe('UploadPanel — each cause of a refused Upload names itself', () => {
  it('with no data type picked, it says to pick one — the first thing a new user hits', async () => {
    await mount()
    await expectRefusal(/data type/i)
  })

  it('with a type picked but no file, it says a file is needed', async () => {
    // Reached through the panel's own seed rather than by staging `ready`: a test that sets the
    // boolean would pass against a component that never computes the cause.
    await mount({ datatype: FIRST_SINGLE_TYPE })
    await expectRefusal(/file/i)
  })
})

/**
 * The datatype registry is a real singleton the panel subscribes to, so the seed has to name a
 * type the registry actually carries. Resolved at module scope so a registry with NO convertible
 * single-file type fails loudly here rather than silently turning the second test into a
 * duplicate of the first.
 */
/**
 * A single-file convertible datatype, REGISTERED rather than looked up.
 *
 * The `single` branch is not reachable from the bootstrap lattice at all — `input_requirements`
 * (the "directly uploadable" marker `deriveConvertibleTypes` filters on) arrives from the server's
 * `/api/datatypes`, so a test that merely READ the registry found nothing and would have
 * degenerated into a second copy of the "no data type picked" case, green and proving nothing.
 * (Measured: that is exactly what the first draft did, and the loud throw is what caught it.)
 * So the fixture is built — the smallest real `Datatype` the derivation accepts — and the derived
 * shape is asserted before any test relies on it.
 */
const SINGLE_TYPE = {
  id: 'test/single',
  title: 'Test single',
  input_requirements: { requires: 'single' },
  ingest: { extensions: ['csv'] },
} as unknown as Parameters<typeof deriveConvertibleTypes>[0][number]

datatypeRegistry.replaceAll([SINGLE_TYPE])
const FIRST_SINGLE_TYPE = (() => {
  const t = deriveConvertibleTypes(datatypeRegistry.all()).find(x => x.requirements.kind === 'single')
  if (!t) throw new Error('the seeded single-file datatype did not survive derivation — fixture is dead')
  return t.value
})()

/**
 * TEST-29 [covers ITEM-6] — FOLDER mode names each cause of a refusal, over the real panel.
 *
 * The refusal copy was rewritten to be ONE sentence per gap KIND (it had been one clause per
 * gap, ~550 characters, and that string is also the submit button's accessible description).
 * Five of the seven branches were then covered by nothing but "it rendered without a console
 * error": swap the scattered and multiClaim strings, drop the `labelOf` mapping so the raw
 * `|` wire separator leaks to the user, or delete the over-long-path pre-flight entirely, and
 * every gate stayed green.
 *
 * Driven through the panel's own seed — a test that staged `notReadyReason` directly would
 * pass against a component that never computes it.
 */
describe('TEST-29 — folder mode names each cause of a refusal', () => {
  const NESTED = 'test/nested-folder-container'
  const BINS = ['bin_a', 'bin_b']
  const MEMBERS = BINS.flatMap(b => [`${b}/counts.h5`, `${b}/geo/positions.csv`])

  const container = (id: string, members: string[]) =>
    ({
      id,
      title: id,
      extends: 'data/opaque',
      is_abstract: false,
      input_requirements: { requires: 'manifest', members, allow_archive: true },
    }) as never

  const pickedAt = (relativePath: string): File => {
    const f = new File(['x'], relativePath.slice(relativePath.lastIndexOf('/') + 1))
    Object.defineProperty(f, 'webkitRelativePath', { value: relativePath })
    return f
  }
  const treeUnder = (root: string, members: string[]) =>
    members.map(m => pickedAt(`${root}/${m}`))

  beforeEach(() => {
    const noArchive = container('test/deep-no-archive', ['bin_a/counts.h5', 'bin_b/counts.h5']) as unknown as Record<string, unknown>
    ;(noArchive.input_requirements as Record<string, unknown>).allow_archive = false
    datatypeRegistry.replaceAll([
      ...datatypeRegistry.all(),
      container(NESTED, MEMBERS),
      container('test/overlapping-folder-container', ['bin_a/counts.h5', 'bin_a/counts.h5|bin_a/x.h5']),
      noArchive as never,
    ])
  })

  it('MISSING names the members, by their derived label — never the wire declaration', async () => {
    const partial = treeUnder('Run', MEMBERS).slice(0, 2)
    await mount({ datatype: NESTED, inputMode: 'folder', folderFiles: partial })
    await expectRefusal(/still needed/i)
    // …and never the `|` the wire syntax uses.
    expect(describedText(submit())).not.toContain('|')
  })

  it('AMBIGUOUS says the folder holds more than one run, with a count', async () => {
    // Two complete runs at once: every member has two candidates.
    await mount({
      datatype: NESTED,
      inputMode: 'folder',
      folderFiles: [...treeUnder('Exp/RunA', MEMBERS), ...treeUnder('Exp/RunB', MEMBERS)],
    })
    await expectRefusal(/more than one run/i)
  })

  it('SCATTERED says the parts are not one bundle, and names the folders', async () => {
    // One bin from each of two DIFFERENT runs: every member binds exactly once, so nothing
    // is ambiguous — only WHERE they came from is wrong.
    const scattered = [
      ...treeUnder('Exp/RunA', MEMBERS.filter(m => m.startsWith('bin_a/'))),
      ...treeUnder('Exp/RunB', MEMBERS.filter(m => m.startsWith('bin_b/'))),
    ]
    await mount({ datatype: NESTED, inputMode: 'folder', folderFiles: scattered })
    await expectRefusal(/different folders/i)
    expect(describedText(submit())).toMatch(/RunA|RunB/)
  })

  it('MULTI-CLAIM says a file matches more than one declared file', async () => {
    await mount({
      datatype: 'test/overlapping-folder-container',
      inputMode: 'folder',
      folderFiles: [pickedAt('Run/bin_a/counts.h5')],
    })
    await expectRefusal(/more than one of the declared files/i)
  })

  it('a DROPPED folder says its contents did not come with it, and names a control that exists', async () => {
    // No `webkitRelativePath` at all — what every browser gives for a directory DROP, and
    // what a picker without directory support gives too.
    await mount({
      datatype: NESTED,
      inputMode: 'folder',
      folderFiles: [new File(['x'], 'counts.h5'), new File(['x'], 'positions.csv')],
    })
    await expectRefusal(/without their folder structure/i)
    expect(describedText(submit())).toContain('Choose a folder')
    // …and the hint must not promise a list here: the member rows are suppressed in this
    // state (they would all read "Not found" about a scan that never meaningfully
    // happened), so "(listed below)" would point at nothing. This is the exact defect an
    // earlier half-applied fix left behind — the hint's gate and the rows' gate must be
    // the same condition.
    expect(document.querySelector('[data-testid="dataset-upload-folder-matches"]')).toBeNull()
    expect(byTestId('dataset-upload-folder').textContent ?? '').not.toContain('listed below')
  })

  it('an OVER-LONG path is refused before the transfer, not after it', async () => {
    // The one server refusal the matcher cannot see. Every member binds; the paths are
    // simply longer than `files.filename` can store, so uploading them would spend the whole
    // transfer to earn a 400.
    const deepRoot = Array.from({ length: 30 }, (_, i) => `folder_number_${i}`).join('/')
    await mount({
      datatype: NESTED,
      inputMode: 'folder',
      folderFiles: treeUnder(deepRoot, MEMBERS),
    })
    await expectRefusal(/longer than the 255 characters/i)
  })

  it('the mode toggle renders only when it has MORE THAN ONE arm', async () => {
    // A one-option Segmented is a tab rail with a single permanently-selected pill that
    // cannot be operated. The gate was hand-written and counted a Folder option that
    // renders only for a DEEP declaration, so it merely moved the unusable rail from the
    // deep-without-archive case to the flat-without-archive one. Both are asserted, with
    // the two-arm cases as the control that the toggle can render at all.
    const flatNoArchive = container('test/flat-no-archive', ['counts.h5', 'positions.csv']) as unknown as Record<string, unknown>
    ;(flatNoArchive.input_requirements as Record<string, unknown>).allow_archive = false
    datatypeRegistry.replaceAll([...datatypeRegistry.all(), flatNoArchive as never])

    for (const id of ['test/deep-no-archive', 'test/flat-no-archive']) {
      cleanup()
      await mount({ datatype: id })
      expect(
        document.querySelector('[data-testid="dataset-upload-mode"]'),
        `${id} offers one arm, so the toggle must not render`,
      ).toBeNull()
    }
    // CONTROL: the same two shapes WITH the archive arm do render it.
    for (const id of [NESTED, 'test/overlapping-folder-container']) {
      cleanup()
      await mount({ datatype: id })
      expect(
        document.querySelector('[data-testid="dataset-upload-mode"]'),
        `${id} offers two arms, so the toggle must render`,
      ).not.toBeNull()
    }
  })

  it("the folder hint's count agrees with the rows it points at", async () => {
    // The hint tells the user how many files are uploaded. That number is a CLAIM of
    // agreement with the member rows below it and with the summary line — all three read
    // the declaration — so it is real logic, not prose, and it is the half worth pinning.
    await mount({ datatype: NESTED, inputMode: 'folder', folderFiles: treeUnder('Run', MEMBERS) })
    const hint = byTestId('dataset-upload-folder').textContent ?? ''
    expect(hint).toContain(`Only the ${MEMBERS.length} files`)
    expect(
      document.querySelectorAll('[data-testid^="dataset-upload-folder-row-"]:not([data-testid$="-path"])'),
    ).toHaveLength(MEMBERS.length)
    expect(byTestId('dataset-upload-folder-summary').textContent).toContain(
      `${MEMBERS.length} of ${MEMBERS.length} members matched`,
    )
    // …and it points at the ARCHIVE arm exactly when the type declares one — BOTH
    // directions, because the manifest's own prose leans on that coupling.
    expect(hint).toContain('use Archive instead')

    // A SECOND container with a DIFFERENT member count. Without it the assertion above is
    // satisfied by a hardcoded literal: replacing `{req.members.length}` with `{4}` left
    // the entire datasets suite green, so the "reads the declaration" claim was untested.
    cleanup()
    await mount({
      datatype: 'test/overlapping-folder-container',
      inputMode: 'folder',
      folderFiles: [pickedAt('Run/bin_a/counts.h5')],
    })
    expect(byTestId('dataset-upload-folder').textContent ?? '').toContain('Only the 2 files')

    // And the deep container that declares NO archive must not offer one.
    cleanup()
    await mount({ datatype: 'test/deep-no-archive' })
    expect(byTestId('dataset-upload-folder').textContent ?? '').not.toContain('use Archive')
  })

  it('a COMPLETE folder is not refused at all', async () => {
    // The control. Without it, every assertion above is equally satisfied by a panel that
    // refuses everything.
    await mount({ datatype: NESTED, inputMode: 'folder', folderFiles: treeUnder('Run', MEMBERS) })
    expect(submit().getAttribute('aria-disabled')).not.toBe('true')
  })
})
