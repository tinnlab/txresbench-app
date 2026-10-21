import { expect, test, type Page } from '@playwright/test'
import { BACKEND, findDatasetRow, loginOwnerToDatasets, ownerToken } from './_helpers'

// TEST-16 / TEST-17 / TEST-18 [covers ITEM-6, ITEM-7, ITEM-8] — the FOLDER arm of the
// type-first upload wizard (#160).
//
// A container may declare members that carry their own directory, because three
// sibling directories can hold the same names and only the path tells them apart. This
// spec drives that end to end in a real browser: pick the type, switch the mode toggle
// to Folder, hand the picker a directory listing, and check that each declared member
// bound to ITS OWN relative path — then that the multipart actually leaving the browser
// carries those paths, which is the whole reason the server can group it.
//
// ── WHAT IS DERIVED, AND WHY ─────────────────────────────────────────────────
// The container is DERIVED from `GET /api/datatypes` — the deepest declaration the
// live registry offers — never written down. The catalog is DATA (`packages/**`
// manifests), so a spec that hardcoded an id or a member path would both go stale on a
// rename and plant a vendor literal in a tree whose guard
// (`scripts/lint-no-domain-in-builtin.mjs`) exists to keep it out. This is the same
// derivation `_helpers.ts::singleFileTypeTitle` already uses for the one-file journey.
// It also makes the assertions sharper rather than weaker: the expected path of every
// row is computed from that row's OWN declaration, so a render that bound twelve rows
// to one picked entry fails on eleven of them.
//
// ── HOW THE DIRECTORY PICK IS DRIVEN ─────────────────────────────────────────
// `setInputFiles` builds its `File`s from names alone and leaves `webkitRelativePath`
// empty, which is precisely the state the panel reports as "this was dropped, not
// picked" — so it cannot drive this surface. The pick is therefore constructed in the
// page: real `File` objects with `webkitRelativePath` defined on them, handed to the
// real `<input webkitdirectory>` through a `DataTransfer`, and released with a real
// `change` event. Nothing is stubbed — the component, its matcher and its submit path
// all run for real. `assertRelativePathsSurvived` fails loudly if a browser ever drops
// the property in transit, so a silent degradation shows up as a named failure rather
// than as a spec that quietly asserts the empty case.

/** One entry of a picked directory: its path relative to the directory chosen. */
type PickedEntry = { path: string; body: string }

/** The registry's DEEPEST manifest container: the one whose declaration carries the
 *  most path segments. That is the shape this item exists for. */
async function deepestContainer(
  request: import('@playwright/test').APIRequestContext,
  token: string,
): Promise<{ id: string; title: string; members: string[] }> {
  const res = await request.get(`${BACKEND}/api/datatypes`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `GET /datatypes -> ${res.status()}`).toBeTruthy()
  const rows = (await res.json()) as {
    id: string
    title?: string
    input_requirements?: { requires?: string; members?: string[] } | null
  }[]
  const depth = (m: string) => Math.max(...m.split('|').map(a => a.trim().split('/').length))
  const containers = rows
    .filter(r => r.input_requirements?.requires === 'manifest')
    .map(r => ({
      id: r.id,
      title: r.title ?? r.id,
      members: r.input_requirements?.members ?? [],
    }))
    .filter(c => c.members.some(m => depth(m) > 1))
    .sort((a, b) => b.members.length - a.members.length)
  expect(
    containers[0],
    'no manifest container in the live registry declares a member carrying a directory — ' +
      'there is no folder journey to drive (is the contributed package built?)',
  ).toBeTruthy()
  const pick = containers[0]
  // A floor, so the spec cannot pass by finding a trivial declaration.
  expect(pick.members.length, `${pick.id} declares too few members to be the deep case`).toBeGreaterThanOrEqual(3)
  return pick
}

/** The canonical spelling of a declared member (its first `|`-alternative). */
const canonical = (member: string): string => member.split('|')[0].trim()

/** A picked directory holding every declared member under a root the user named
 *  themselves, plus the noise a real run directory carries — scanned, never sent. */
function pickedTree(members: string[], root: string): PickedEntry[] {
  return [
    ...members.map((m, i) => ({ path: `${root}/nested/${canonical(m)}`, body: `member-${i}` })),
    { path: `${root}/summary.html`, body: '<html></html>' },
    { path: `${root}/nested/extra/report/table.csv`, body: 'a,b\n1,2\n' },
    { path: `${root}/nested/expanded/values.bin.gz`, body: 'noise' },
  ]
}

/**
 * Hand a real `<input webkitdirectory>` a set of `File`s that carry
 * `webkitRelativePath`, exactly as a directory pick does, and release a real `change`.
 *
 * Returns what the input actually held at the moment of the change — read back BEFORE
 * dispatching, because the dropzone clears `input.value` in its own handler. The
 * caller asserts on it, so a browser that ever dropped the property in transit fails
 * by name instead of leaving the spec quietly exercising the dropped-directory case.
 */
async function pickFolder(page: Page, entries: PickedEntry[]): Promise<string[]> {
  const input = page.locator('[data-testid="dataset-upload-folder-input"] input[type="file"]')
  await expect(input).toHaveCount(1)
  return input.evaluate((el, list: PickedEntry[]) => {
    const target = el as HTMLInputElement
    const transfer = new DataTransfer()
    for (const entry of list) {
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
      const file = new File([entry.body], name, { type: 'application/octet-stream' })
      Object.defineProperty(file, 'webkitRelativePath', { value: entry.path })
      transfer.items.add(file)
    }
    target.files = transfer.files
    const held = Array.from(target.files ?? []).map(f => f.webkitRelativePath)
    target.dispatchEvent(new Event('change', { bubbles: true }))
    return held
  }, entries)
}

/**
 * What a folder DROP produces, as opposed to a folder PICK: real `File`s whose
 * `webkitRelativePath` is the empty string, because `DataTransfer.files` carries no
 * directory context (`kit/upload.tsx` reads `e.dataTransfer.files`, with no
 * `webkitGetAsEntry` walk). Deliberately a SEPARATE helper from `pickFolder` — an
 * earlier version of this leg reused `pickFolder` with the basenames as paths, which
 * left `webkitRelativePath` NON-empty and therefore exercised "twelve members not
 * found" rather than the dropped-folder case it claimed to. Returns what the input
 * held, so the caller can assert the paths really were empty.
 */
async function dropFolder(page: Page, entries: PickedEntry[]): Promise<string[]> {
  const input = page.locator('[data-testid="dataset-upload-folder-input"] input[type="file"]')
  await expect(input).toHaveCount(1)
  return input.evaluate((el, list: PickedEntry[]) => {
    const target = el as HTMLInputElement
    const transfer = new DataTransfer()
    for (const entry of list) {
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
      // No `webkitRelativePath` is defined: the property reads `''`, exactly as it does
      // for a file that arrived through `dataTransfer.files`.
      transfer.items.add(new File([entry.body], name, { type: 'application/octet-stream' }))
    }
    target.files = transfer.files
    const held = Array.from(target.files ?? []).map(f => f.webkitRelativePath)
    target.dispatchEvent(new Event('change', { bubbles: true }))
    return held
  }, entries)
}

/** Fail by NAME if the relative paths did not survive the hand-off. */
function assertRelativePathsSurvived(held: string[], entries: PickedEntry[]): void {
  expect(
    held,
    'the picked Files lost their webkitRelativePath before reaching the component — ' +
      'the rest of this spec would be exercising the DROPPED-directory path instead',
  ).toEqual(entries.map(e => e.path))
}

/**
 * Open the wizard on the deepest container. It lands in Folder mode WITHOUT a click:
 * a declaration whose members carry a directory cannot be satisfied by the per-member
 * dropzones (a non-directory picker gives the browser no relative path), so that arm is
 * not offered and Folder is the default. Asserting the default here rather than clicking
 * past it is the point — a click would hide a regression that put the user back on an arm
 * that always 400s.
 */
async function openFolderMode(page: Page, title: string) {
  await page.getByTestId('datasets-upload-button').click()
  const dialog = page.getByTestId('dataset-upload-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('dataset-upload-type').click()
  await page.getByRole('option', { name: title, exact: true }).click()
  // No click on the toggle: the deep container must OPEN here.
  await expect(page.getByTestId('dataset-upload-folder')).toBeVisible()
  // …and the dead arm is not even offered.
  await expect(page.getByTestId('dataset-upload-mode-opt-files')).toHaveCount(0)
  await expect(page.getByTestId('dataset-upload-member-slots')).toHaveCount(0)
  return dialog
}

/**
 * A FLAT container is the CONTROL for the two absence assertions in `openFolderMode`.
 * Without it, "the files arm is absent" and "the member slots are absent" are equally
 * true of a dialog that rendered nothing at all, and of a build where those testids were
 * renamed. Called with the wizard already open.
 */
async function assertFlatContainerStillOffersTheMemberSlots(page: Page, deepTitle: string) {
  await page.getByTestId('dataset-upload-type').click()
  const options = page.getByRole('option')
  const count = await options.count()
  for (let i = 0; i < count; i += 1) {
    const name = (await options.nth(i).textContent())?.trim()
    if (!name || name === deepTitle) continue
    await options.nth(i).click()
    const slots = page.getByTestId('dataset-upload-member-slots')
    if ((await slots.count()) > 0) {
      await expect(slots).toBeVisible()
      // …and such a container is NOT offered the folder arm (its stored filenames, and
      // therefore its content hash, must not depend on which arm was used).
      await expect(page.getByTestId('dataset-upload-mode-opt-folder')).toHaveCount(0)
      return
    }
    await page.getByTestId('dataset-upload-type').click()
  }
  throw new Error(
    'no flat manifest container was reachable in the picker, so the absence assertions in ' +
      'openFolderMode are uncontrolled — they would pass over a dialog that rendered nothing',
  )
}

test.describe('folder upload — a nested container picked as ONE directory', () => {
  test('the mode a container OPENS in follows its declaration — TEST-16 (control)', async ({
    page,
    request,
  }) => {
    await loginOwnerToDatasets(page)
    const token = await ownerToken(request)
    const container = await deepestContainer(request, token)
    // The deep container opens in Folder with no click, and is not offered the dead arm.
    await openFolderMode(page, container.title)
    // …and a FLAT container in the same dialog still gets the per-member slots and is not
    // offered Folder. This is what makes the two absences above mean "gated by the
    // declaration" rather than "nothing rendered".
    await assertFlatContainerStillOffersTheMemberSlots(page, container.title)
  })

  test('every declared member binds to its own relative path, and those paths go on the wire — TEST-16', async ({
    page,
    request,
  }) => {
    await loginOwnerToDatasets(page)
    const token = await ownerToken(request)
    const container = await deepestContainer(request, token)
    const root = `E2EFolder_${Date.now()}`
    const entries = pickedTree(container.members, root)

    // Capture the multipart the browser actually sends, then let it go through for
    // real — this is an observation of a LIVE route, not a stub of one.
    const sentFilenames: string[] = []
    await page.route('**/api/datasets/upload', async route => {
      const body = route.request().postDataBuffer()?.toString('latin1') ?? ''
      for (const m of body.matchAll(/name="file";\s*filename="([^"]*)"/g)) sentFilenames.push(m[1])
      await route.continue()
    })

    await openFolderMode(page, container.title)
    assertRelativePathsSurvived(await pickFolder(page, entries), entries)

    // ONE row per DECLARED member — never a listing of the picked directory.
    const rows = page.getByTestId('dataset-upload-folder-matches').locator('> div')
    await expect(rows).toHaveCount(container.members.length)
    await expect(page.getByTestId('dataset-upload-folder-summary')).toContainText(
      `${entries.length} files scanned, ${container.members.length} of ${container.members.length} members matched`,
    )
    // Each row shows ITS OWN path. A render that bound every row to one picked entry
    // satisfies the count above and fails here on all but one member.
    for (let i = 0; i < container.members.length; i += 1) {
      await expect(rows.nth(i)).toContainText(`${root}/nested/${canonical(container.members[i])}`)
    }
    const shown = await rows.allInnerTexts()
    expect(new Set(shown).size, 'every row shows a distinct binding').toBe(shown.length)

    await expect(page.getByTestId('dataset-upload-folder-gap')).toHaveCount(0)
    await expect(page.getByTestId('dataset-upload-submit')).toBeEnabled()
    await page.getByTestId('dataset-upload-submit').click()
    await expect(page.getByTestId('dataset-upload-dialog')).toBeHidden({ timeout: 60_000 })

    // ITEM-7 — only the bound entries were transferred, each under its RELATIVE path.
    expect(sentFilenames).toEqual(
      container.members.map(m => `${root}/nested/${canonical(m)}`),
    )
    expect(sentFilenames).not.toContain(`${root}/summary.html`)

    // The group became ONE dataset instead of degrading into one dataset per part — and
    // it is named after the FOLDER the user picked, not after whichever member sorted
    // first. Twelve members and a dataset called `counts.h5` is both uninformative and
    // indistinguishable from the single-resolution container's.
    await expect(await findDatasetRow(page, root)).toBeVisible()
  })

  test('a folder missing two members refuses BY NAME, and a dropped folder says so — TEST-17', async ({
    page,
    request,
  }) => {
    await loginOwnerToDatasets(page)
    const token = await ownerToken(request)
    const container = await deepestContainer(request, token)
    const root = `E2EGap_${Date.now()}`
    const absent = container.members.slice(-2)
    const partial = pickedTree(container.members, root).filter(
      e => !absent.some(m => e.path.endsWith(`/${canonical(m)}`)),
    )

    await openFolderMode(page, container.title)
    assertRelativePathsSurvived(await pickFolder(page, partial), partial)

    // The refusal is VISIBLE and names BOTH absent members — never a grey button.
    const gap = page.getByTestId('dataset-upload-folder-gap')
    await expect(gap).toBeVisible()
    for (const m of absent) await expect(gap).toContainText(m)
    await expect(page.getByTestId('dataset-upload-submit')).toBeDisabled()
    // The rows that DID bind still show their paths, so the user can see what is fine.
    const rows = page.getByTestId('dataset-upload-folder-matches').locator('> div')
    await expect(rows).toHaveCount(container.members.length)
    await expect(rows.filter({ hasText: 'Not found' })).toHaveCount(absent.length)

    // DEC-7 — the SAME entries with no relative path at all: what a browser gives for
    // a folder DROP. The panel states the remedy instead of matching nothing silently.
    const dropped = await dropFolder(page, partial)
    expect(
      dropped.every(p => p === ''),
      'a dropped file must carry NO relative path, or this leg is exercising the picked ' +
        'case again and the assertion below would be about the wrong message',
    ).toBe(true)
    // The copy must name a control that EXISTS (the dropzone reads "Choose a folder";
    // there is no button) and must cover BOTH causes of this state — a folder drop, and a
    // browser whose picker cannot do directories, where the user HAD used the affordance.
    await expect(gap).toContainText('arrived without their folder structure')
    await expect(gap).toContainText('Choose a folder')
    await expect(page.getByTestId('dataset-upload-submit')).toBeDisabled()
    // …and the per-member rows are suppressed here: they would all read "Not found" about
    // a scan that never meaningfully happened.
    await expect(page.getByTestId('dataset-upload-folder-matches')).toHaveCount(0)
  })

  test('the populated match list fits a 390 px viewport — TEST-18', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loginOwnerToDatasets(page)
    const token = await ownerToken(request)
    const container = await deepestContainer(request, token)
    const root = `E2ENarrow_${Date.now()}`

    await openFolderMode(page, container.title)
    await pickFolder(page, pickedTree(container.members, root))
    const rows = page.getByTestId('dataset-upload-folder-matches').locator('> div')
    await expect(rows).toHaveCount(container.members.length)

    // The page itself must not scroll sideways.
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement!
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
    })
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)

    // Every row is TRUNCATED, asserted on the MECHANISM rather than on a width identity.
    // A block-level child's `boundingBox().width` equals its parent's whether or not its
    // text is clipped — and if the dialog itself were pushed wider, the comparison would
    // widen with it — so the earlier `box.width <= dialogBox.width` leg was satisfied by a
    // row whose long path visually overflowed. What actually has to be true is that the
    // path element clips, and that its content is genuinely wider than its box.
    const dialogBox = (await page.getByTestId('dataset-upload-dialog').boundingBox())!
    let clipped = 0
    for (let i = 0; i < container.members.length; i += 1) {
      const box = (await rows.nth(i).boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1)
      const path = rows.nth(i).locator('[data-testid$="-path"]').first()
      if ((await path.count()) === 0) continue
      const m = await path.evaluate(el => {
        const cs = getComputedStyle(el)
        return {
          overflow: cs.overflow,
          textOverflow: cs.textOverflow,
          whiteSpace: cs.whiteSpace,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }
      })
      expect(m.overflow).toBe('hidden')
      expect(m.textOverflow).toBe('ellipsis')
      expect(m.whiteSpace).toBe('nowrap')
      if (m.scrollWidth > m.clientWidth) clipped += 1
    }
    // …and at least one of the twelve is ACTUALLY overflowing at 390 px, or the three
    // style assertions above are being made about text that never needed them.
    expect(
      clipped,
      'no row overflows its box at 390px, so the truncation assertions are unexercised',
    ).toBeGreaterThan(0)

    // And the Upload button is still reachable, not clipped off the bottom.
    const submit = page.getByTestId('dataset-upload-submit')
    await submit.scrollIntoViewIfNeeded()
    await expect(submit).toBeVisible()
    const submitBox = (await submit.boundingBox())!
    expect(submitBox.width).toBeGreaterThan(0)
    expect(submitBox.x).toBeGreaterThanOrEqual(0)
    expect(submitBox.x + submitBox.width).toBeLessThanOrEqual(390)
  })
})
