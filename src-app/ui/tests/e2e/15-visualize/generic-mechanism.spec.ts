// TEST-A14 (e2e) [acceptance] [invariant: INV-14] [covers: ITEM-65]
// TEST-A20 (e2e) [acceptance] [invariant: INV-20] [covers: ITEM-62, ITEM-31c]
//
// TEST-A20's e2e half was DEFERRED FROM PARTITION D (DRIFT-1.45) for the reason recorded
// there: it drives TWO packages that both contribute sections, and there were none until
// ITEM-65 shipped. Its mechanism halves stayed unit-pinned meanwhile
// (`canvasComposition.test.ts`, `SectionStack.test.tsx`); this is the leg neither can cover.
//
// ── Why the fixture packages carry no domain vocabulary ───────────────────────────────
//
// INV-14 claims the Visualize pane's mechanism is GENERIC — *"the whole pane could be
// contributed by a package that produces nothing, against datatypes contributed by another
// package entirely."* Asserting that by driving the package the app was built alongside
// would be a tautology: it would prove that one package works. So the two packages here are
// AUTHORED IN THIS FILE as text, DROPPED into the server's runtime package folder, and their
// ids, titles, section ids and widget ids are all neutral. The only thing they name from the
// shipped world is a DATATYPE somebody else contributed, which is exactly the arrangement
// INV-14 describes.
//
// They ship `ui/*.yaml`, NOT `visualize/*.yaml` (DRIFT-1.8): three discovery surfaces
// hardcode `ui/`, so a section declaring any other folder resolves to nothing and the loader
// reports *"declared in `ui:` … but no such view file"*.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { expect, test, type APIRequestContext } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { BACKEND, ownerApiToken } from '../_owner'
import { createProject } from '../14-workbench/_dock'
import { seedQcDataset } from '../14-declarative-qc/_seed'
import { DT } from '../14-declarative-qc/_fixtures'
import { openVisualize, renderedOrder } from './_visualize'

const DATA_ROOT = process.env.TXR_APP_DATA_DIR

/** The kind both fixture sections declare they apply to. Contributed by a DIFFERENT package
 *  than either of these, which is the half of INV-14 that a self-contributed datatype would
 *  quietly not prove. Taken from the harness's own id table rather than spelled here, so the
 *  app tree gains no new contributed-vocabulary literal. */
const APPLIES_TO = DT.metadataColumn

interface Probe {
  pkg: string
  section: string
  title: string
  order: number
  widget: string
}

const ALPHA: Probe = { pkg: 'e2e-viz-alpha', section: 'e2e.alpha.block', title: 'Probe alpha', order: 5, widget: 'alphaNote' }
const BETA: Probe = { pkg: 'e2e-viz-beta', section: 'e2e.beta.block', title: 'Probe beta', order: 6, widget: 'betaNote' }

function manifestText(p: Probe): string {
  return `id: ${p.pkg}
name: ${p.title} package
publisher: txr-e2e
version: 0.0.1
apiVersion: "1.0"
contributes:
  sections:
    - id: ${p.section}
      title: ${p.title}
      pane: visualize
      order: ${p.order}
      collapsed: false
      applies_to: [{ type_id: ${APPLIES_TO} }]
      ui: [ui/block.yaml]
`
}

function viewText(p: Probe): string {
  return `id: ${p.section}.view
title: ${p.title}
permission: projects::use
state: {}
widgets:
  - id: ${p.widget}
    kind: stat
    label: ${p.title}
    value: "contributed"
actions: []
`
}

async function dropPackage(request: APIRequestContext, token: string, p: Probe): Promise<void> {
  const dir = path.join(DATA_ROOT as string, 'processors', p.pkg)
  mkdirSync(path.join(dir, 'ui'), { recursive: true })
  writeFileSync(path.join(dir, 'manifest.yaml'), manifestText(p), 'utf8')
  writeFileSync(path.join(dir, 'ui', 'block.yaml'), viewText(p), 'utf8')
  const reload = await request.post(`${BACKEND}/api/processors/reload`, {
    headers: { authorization: `Bearer ${token}` },
    data: {},
  })
  expect(reload.ok(), `reload -> ${reload.status()} ${await reload.text()}`).toBeTruthy()
  const body = (await reload.json()) as { packages: { id: string; ok: boolean; error?: string | null }[] }
  const row = body.packages.find(x => x.id === p.pkg)
  expect(row, `the server did not discover "${p.pkg}": ${JSON.stringify(body.packages)}`).toBeTruthy()
  expect(row?.ok, `"${p.pkg}" failed server-side load: ${row?.error}`).toBe(true)
}

function removePackage(p: Probe): void {
  if (!DATA_ROOT) return
  rmSync(path.join(DATA_ROOT, 'processors', p.pkg), { recursive: true, force: true })
}

test.describe('a package with no analysis contributes Visualize sections, with zero app change (TEST-A14, TEST-A20)', () => {
  // Skipped at DESCRIBE level and only for a missing data root — never for a failure. The
  // runner's own config exports `TXR_APP_DATA_DIR`, so this is the "someone ran playwright
  // by hand against a foreign server" case, not a routine one.
  test.skip(!DATA_ROOT || !existsSync(DATA_ROOT), 'needs the harness app-data root to drop a runtime package')

  test.afterAll(() => {
    removePackage(ALPHA)
    removePackage(BETA)
  })

  test('two packages contribute sections for the same kind, and BOTH appear — composition adds', async ({
    page,
    request,
  }) => {
    const token = await ownerApiToken(request)
    await dropPackage(request, token, ALPHA)
    await dropPackage(request, token, BETA)

    await loginAsOwner(page)
    const id = await createProject(request, `Visualize generic ${Date.now()}`)
    // Only the kind the fixture sections declare. Deliberately NOT the two-section seed the
    // other specs use: this project proves the sections that render are the DROPPED ones.
    await seedQcDataset(request, id, { annotated: true })
    await openVisualize(page, id)

    // INV-14 — a package shipping only `manifest.yaml` + `ui/*.yaml` DATA, whose ids the
    // shipped bundle has never seen, renders a working Visualize section. No `src-app` edit,
    // no rebuild: the bytes were written to disk while the server was running.
    await expect(page.getByTestId(`section-frame-${ALPHA.section}`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId(`widget-${ALPHA.widget}`)).toBeVisible()

    // INV-20 — COMPOSITION ADDS; ARBITRATION DISCARDS. Both packages contribute a section
    // for the SAME kind of data, and both appear, stacked. There is no "pick the best
    // contributor" step, and its absence is the invariant: under the section model that is
    // not a policy, it is the literal rendering.
    await expect(page.getByTestId(`section-frame-${BETA.section}`)).toBeVisible()
    await expect(page.getByTestId(`widget-${BETA.widget}`)).toBeVisible()

    const order = await renderedOrder(page)
    expect(order).toContain(ALPHA.section)
    expect(order).toContain(BETA.section)
    // …and they stack in their DECLARED order, interleaved with the shipped sections by the
    // same rule rather than appended after them — the arrangement is one list, not "ours
    // then theirs". `order: 5`/`6` place both above the shipped `10`/`20`.
    expect(order.indexOf(ALPHA.section)).toBeLessThan(order.indexOf(BETA.section))

    // The centre reservation stays unreachable from this path (INV-12): a contributed
    // section is not a view, so nothing here acquires a pane or a dock tab.
    await expect(page.getByRole('tab', { name: ALPHA.title, exact: true })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: BETA.title, exact: true })).toHaveCount(0)
  })
})
