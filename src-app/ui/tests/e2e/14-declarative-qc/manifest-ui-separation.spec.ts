import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, createProject, openWorkbench } from '../14-workbench/_dock'
import { postSeedPlan, seededId } from './_seed'
import { DT } from './_fixtures'
// The fixture package TEXT lives in its own module so a vitest can parse it too — see
// `_probeSpecs.ts` and `core/runtime/droppedSpecCorpus.test.ts`. Extracting it is the guard:
// these specs are authored OUTSIDE the app tree, and until now only this 8-hour e2e read them.
import {
  fragmentViewText,
  manifestText,
  pickerViewText,
  type AnalysisShape,
} from './_probeSpecs'

// TEST-2 / TEST-3 / TEST-4 (e2e) [acceptance] [invariants: INV-2, INV-3, INV-4]
// [covers: ITEM-6, ITEM-7, ITEM-8, ITEM-10]
//
//   INV-2  The view owns everything the user sees and selects, and declares its own option
//          sources. The manifest does not define, constrain, or supply the UI.
//   INV-3  One analysis renders into ONE pane. Multiple UI files stack top to bottom in
//          declaration order.
//   INV-4  What is launched is what was shown. Every input the run consumes is visible in
//          the form before Run, and passed explicitly.
//
// ── Why every subject here is a NEW processor the repo has never seen ────────────────
//
// Each invariant is a claim about ANY processor, so driving the migrated in-tree packages
// would prove only that those packages work — a tautology against an app that special-cases
// them. Every test below therefore AUTHORS a processor package (manifest + view files, as
// text), DROPS it into the server's runtime processor folder, and drives it end to end
// through the real browser. Nothing in the shipped bundle has ever seen these ids, and no
// app code is written for them: that is the claim.
//
// Their vocabulary is deliberately NEUTRAL. A fixture drawn from the one domain the app
// already ships would both weaken "any processor works" and leak that domain back into the
// app surface the separability guard protects.
//
// The DATATYPES the fixtures pick over are pre-existing ones, reached through `_fixtures.ts`
// rather than written down here. That is not a compromise of the claim: INV-2/3/4 are
// invariants about the PROCESSOR contract — which form is rendered, into how many panes,
// and what the launch receives — not about the type lattice. Contributing new types as well
// would add a second unproven mechanism to a spec that already introduces one.
//
// ── HOST-CAPABILITY GATE ─────────────────────────────────────────────────────────────
//
// The drop writes the SERVER's `<data_root>/processors/`. That root defaults to a
// machine-shared directory several worktrees' servers read at once, so these run ONLY when
// the harness has isolated it via `TXR_APP_DATA_DIR` — the same env the backend reads, and
// the same gate `packages/runtime-dropin-registers.spec.ts` uses. The skip is
// describe-level, so it is COLLECTED unconditionally and REPORTED with its reason; it is
// never counted as passed.
//
// They are NOT `@acceptance`-tagged. That tag selects the specs that commit a genuine
// sandbox run, and none of these do: a launched run records its inputs at job CREATION (an
// unresolvable `code_ref` fails the job later, inside the runner), so TEST-4's claim — the
// launch received what the form displayed — is observable without a sandbox-executable
// host. Tagging them would move them into an invocation that only runs on such a host, for
// no capability reason.
//
// ── The one mechanism here with no prior coverage ────────────────────────────────────
//
// A runtime-dropped package's REGISTRATION is covered
// (`packages/runtime-dropin-registers.spec.ts`, `core/runtime/runtimeDropin.test.ts`);
// its RENDERING is not. The registries hold no subscribers, so a pane contributed after the
// shell has mounted appears on the next render the shell happens to perform (the artifact
// catalog resolving is the one that reliably follows). Each test below asserts the registry
// through the `window.__workbenchRegistry` seam FIRST, so a failure separates "never
// registered" from "registered but never painted". If the paint half proves flaky, the fix
// is a registry-change subscription in the shell — NOT a longer timeout here.

const DATA_ROOT = process.env.TXR_APP_DATA_DIR

/** How long to wait for a runtime-dropped pane to reach the DOM — see the note above. */
const PAINT_TIMEOUT = 30_000

// ── driving the single-artifact picker ────────────────────────────────────────────────
//
// It is a POPOVER control (the kit `Select`), not a native `<select>`: its rows do not exist
// in the DOM until it is opened, and the kit stamps each one `${testid}-opt-${artifactId}`.
// So "what does it offer" and "choose this one" are the two gestures below rather than an
// `option` query and `selectOption`.

/** The artifact ids a picker OFFERS, sorted. Opens the picker and closes it again. */
async function offeredArtifacts(page: Page, testid: string): Promise<string[]> {
  const trigger = page.getByTestId(testid)
  await trigger.click()
  const prefix = `${testid}-opt-`
  const ids = await page
    .locator(`[role="option"][data-testid^="${prefix}"]`)
    .evaluateAll((nodes, p) => nodes.map(n => (n.getAttribute('data-testid') ?? '').slice(p.length)), prefix)
  await page.keyboard.press('Escape')
  return ids.filter(Boolean).sort()
}

/** Choose an artifact THROUGH the picker, and wait until the control DISPLAYS it — the
 *  popover equivalent of `selectOption` + `toHaveValue`. The trigger's selected rendering
 *  carries the id of the artifact it names, so this reads what is on screen. */
async function chooseArtifact(page: Page, testid: string, artifactId: string): Promise<void> {
  await page.getByTestId(testid).click()
  await page.getByTestId(`${testid}-opt-${artifactId}`).click()
  await expect(page.getByTestId(testid).locator(`[data-artifact-id="${artifactId}"]`)).toBeVisible({
    timeout: PAINT_TIMEOUT,
  })
}

// ── dropping a package ───────────────────────────────────────────────────────────────

/** Write a package's files under `<data_root>/processors/<id>/` and make the server reflect
 *  the folder. Fails LOUD if the server did not load it — a silently-skipped package would
 *  present downstream as "the pane never rendered", which is a different bug. */
async function dropPackage(
  request: APIRequestContext,
  token: string,
  id: string,
  files: Record<string, string>,
): Promise<void> {
  const dir = path.join(DATA_ROOT as string, 'processors', id)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text, 'utf8')
  }
  const reload = await request.post(`${BACKEND}/api/processors/reload`, {
    headers: { authorization: `Bearer ${token}` },
    data: {},
  })
  expect(reload.ok(), `reload -> ${reload.status()} ${await reload.text()}`).toBeTruthy()
  const body = (await reload.json()) as {
    packages: { id: string; ok: boolean; error?: string | null }[]
  }
  const row = body.packages.find(p => p.id === id)
  expect(row, `the server did not discover "${id}": ${JSON.stringify(body.packages)}`).toBeTruthy()
  expect(row?.ok, `"${id}" failed server-side load: ${row?.error}`).toBe(true)
}

function removePackage(id: string): void {
  if (!DATA_ROOT) return
  rmSync(path.join(DATA_ROOT, 'processors', id), { recursive: true, force: true })
}

// ── reading the live app ─────────────────────────────────────────────────────────────

const registeredViews = () =>
  (window as unknown as { __workbenchRegistry: { views: () => string[] } }).__workbenchRegistry.views()

/** Bring a contributed pane's tab to the front — only the ACTIVE tab renders its body. */
async function openPane(page: Page, title: string): Promise<void> {
  const tab = page.getByRole('tab', { name: title, exact: true })
  await expect(tab, `the dropped pane "${title}" never reached the dock`).toHaveCount(1, {
    timeout: PAINT_TIMEOUT,
  })
  await tab.click()
}

/** Wait until the dropped analysis' pane contribution is in the registry the app renders
 *  from, then open the workbench view of it. */
async function openDroppedPane(
  page: Page,
  projectId: string,
  analysisId: string,
  title: string,
): Promise<void> {
  await openWorkbench(page, projectId)
  await expect
    .poll(() => page.evaluate(registeredViews), {
      timeout: PAINT_TIMEOUT,
      message: `the runtime-dropped view "${analysisId}" must reach workbenchRegistry.views`,
    })
    .toContain(analysisId)
  await openPane(page, title)
}

// ── the fixture packages, as text ────────────────────────────────────────────────────

/** The two datatypes the fixture forms pick over, named through `_fixtures.ts`. Two of them
 *  is what makes "changing only the view's source changes the offered options" a real
 *  discrimination rather than a re-assertion of one constant. */
const ALPHA = DT.metadataColumn
const BETA = DT.clustering

// ── seeding the candidates ───────────────────────────────────────────────────────────

/** Seed `n` artifacts of `datatype`, each declaring ONE named member so the picker's option
 *  READS as that name — a legible, unique label per candidate (`candidateLabel`). */
async function seedCandidates(
  request: APIRequestContext,
  projectId: string,
  datatype: string,
  names: string[],
): Promise<Record<string, string>> {
  const resp = await postSeedPlan(request, projectId, {
    artifacts: names.map(name => ({
      output_id: name,
      datatype,
      structure: { encoding: 'zarr_v3', axis: 'rows', columns: [{ name, kind: 'numeric' }] },
      content: { encoding: 'json' as const, value: { probe: name } },
    })),
  })
  const out: Record<string, string> = {}
  for (const name of names) {
    const id = seededId(resp, name)
    expect(id, `the seed produced an artifact for "${name}"`).toBeTruthy()
    out[name] = id as string
  }
  return out
}

// ── the specs ────────────────────────────────────────────────────────────────────────

test.describe('a NEW processor renders + launches from its own declarations', () => {
  test.skip(
    !DATA_ROOT,
    'needs TXR_APP_DATA_DIR (an isolated server data root) — the fixture processor is DROPPED into the server folder',
  )

  // ── TEST-2 · INV-2 ────────────────────────────────────────────────────────────────
  test('the form label and the offered options come from the VIEW SPEC alone (INV-2)', async ({
    page,
    request,
  }) => {
    const PKG = 'e2e-probe-source'
    const ANALYSIS = `${PKG}.run`
    const PANE = 'Probe source form'
    const LABEL = 'Chosen probe input'
    const shape: AnalysisShape = {
      id: ANALYSIS,
      title: PANE,
      slot: 'source',
      datatype: ALPHA,
      ui: ['ui/form.yaml'],
    }
    // The MANIFEST text is built once and reused verbatim for both drops. Holding it
    // byte-identical is what makes the second half say "only the view changed".
    const manifest = manifestText(PKG, shape)

    try {
      const token = await ownerToken(request)
      await loginAsOwner(page)
      const projectId = await createProject(request, `INV2 ${Date.now()}`)
      const alpha = await seedCandidates(request, projectId, ALPHA, ['probe_alpha_1', 'probe_alpha_2'])
      const beta = await seedCandidates(request, projectId, BETA, ['probe_beta_1', 'probe_beta_2'])

      // ── drop 1: the view offers the ALPHA candidates ──────────────────────────────
      await dropPackage(request, token, PKG, {
        'manifest.yaml': manifest,
        'ui/form.yaml': pickerViewText({
          specId: 'probe/form',
          title: 'Probe form',
          label: LABEL,
          sourceDatatype: ALPHA,
        }),
      })
      await openDroppedPane(page, projectId, ANALYSIS, PANE)

      // The LABEL is the view's — and it appears nowhere in the manifest, so it cannot
      // have come from the registration file.
      expect(
        manifest.includes(LABEL),
        'the manifest must not carry the control label — the view owns it (INV-2)',
      ).toBe(false)
      const field = page.getByTestId('widget-probePicker-field')
      await expect(field).toBeVisible({ timeout: PAINT_TIMEOUT })
      await expect(field).toContainText(LABEL)

      // The OPTION SET is the view's `source`, and it is exactly the ALPHA artifacts.
      const select = page.getByTestId('widget-probePicker-select')
      await expect(select).toBeVisible({ timeout: PAINT_TIMEOUT })
      const alphaOffered = await offeredArtifacts(page, 'widget-probePicker-select')
      expect(alphaOffered).toEqual([alpha.probe_alpha_1, alpha.probe_alpha_2].sort())

      // ── drop 2: ONLY the view's `source` changes ──────────────────────────────────
      await dropPackage(request, token, PKG, {
        'manifest.yaml': manifest,
        'ui/form.yaml': pickerViewText({
          specId: 'probe/form',
          title: 'Probe form',
          label: LABEL,
          sourceDatatype: BETA,
        }),
      })
      await openDroppedPane(page, projectId, ANALYSIS, PANE)

      const selectAfter = page.getByTestId('widget-probePicker-select')
      await expect(selectAfter).toBeVisible({ timeout: PAINT_TIMEOUT })
      const betaOffered = await offeredArtifacts(page, 'widget-probePicker-select')
      expect(
        betaOffered,
        'the offered set follows the VIEW`s source — the manifest was byte-identical across both drops',
      ).toEqual([beta.probe_beta_1, beta.probe_beta_2].sort())
      // …and it genuinely CHANGED, so the assertion above is not true of both sets.
      expect(betaOffered).not.toEqual(alphaOffered)
    } finally {
      removePackage(PKG)
    }
  })

  // ── TEST-3 · INV-3 ────────────────────────────────────────────────────────────────
  test('TWO declared ui files render into ONE pane, in declaration order (INV-3)', async ({
    page,
    request,
  }) => {
    const PKG = 'e2e-probe-stack'
    const ANALYSIS = `${PKG}.run`
    const PANE = 'Probe stacked form'
    // Declaration order is deliberately NOT alphabetical: a loader that scanned the folder
    // instead of reading the manifest's list would paint these the other way round.
    const FIRST = { file: 'ui/second.yaml', spec: 'probe/second', title: 'Probe fragment two', widget: 'probeSecond' }
    const SECOND = { file: 'ui/first.yaml', spec: 'probe/first', title: 'Probe fragment one', widget: 'probeFirst' }

    try {
      const token = await ownerToken(request)
      await loginAsOwner(page)
      const projectId = await createProject(request, `INV3 ${Date.now()}`)
      await seedCandidates(request, projectId, ALPHA, ['probe_stack_1'])

      await dropPackage(request, token, PKG, {
        'manifest.yaml': manifestText(PKG, {
          id: ANALYSIS,
          title: PANE,
          slot: 'source',
          datatype: ALPHA,
          ui: [FIRST.file, SECOND.file],
        }),
        [FIRST.file]: fragmentViewText(FIRST.spec, FIRST.title, FIRST.widget, 'Fragment two body'),
        [SECOND.file]: fragmentViewText(SECOND.spec, SECOND.title, SECOND.widget, 'Fragment one body'),
      })
      await openDroppedPane(page, projectId, ANALYSIS, PANE)

      // ONE pane, bearing the ANALYSIS title, exactly once.
      await expect(page.getByRole('tab', { name: PANE, exact: true })).toHaveCount(1)
      // …and NO pane bearing either FRAGMENT's title — that is what a second pane would
      // read as, and it is the shape the per-file contribution produced.
      for (const fragment of [FIRST, SECOND]) {
        await expect(
          page.getByRole('tab', { name: fragment.title, exact: true }),
          `"${fragment.title}" got its own pane — a view file is a fragment, not a pane`,
        ).toHaveCount(0)
      }

      // BOTH files' widgets are in the one pane…
      const first = page.getByTestId(`widget-${FIRST.widget}`)
      const second = page.getByTestId(`widget-${SECOND.widget}`)
      await expect(first).toBeVisible({ timeout: PAINT_TIMEOUT })
      await expect(second).toBeVisible({ timeout: PAINT_TIMEOUT })

      // …top to bottom in the order the MANIFEST listed the files.
      const order = await page.evaluate(
        ([a, b]) => {
          const ea = document.querySelector(`[data-testid="${a}"]`)
          const eb = document.querySelector(`[data-testid="${b}"]`)
          if (!ea || !eb) return 'missing'
          return ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING
            ? 'declared'
            : 'reversed'
        },
        [`widget-${FIRST.widget}`, `widget-${SECOND.widget}`],
      )
      expect(order, 'the declared `ui:` order is the paint order (INV-3)').toBe('declared')
    } finally {
      removePackage(PKG)
    }
  })

  // ── TEST-4 · INV-4 ────────────────────────────────────────────────────────────────
  test('the launched run records exactly what the form displayed (INV-4)', async ({
    page,
    request,
  }) => {
    const PKG = 'e2e-probe-launch'
    const ANALYSIS = `${PKG}.run`
    const PANE = 'Probe launch form'
    const SLOT = 'source'

    try {
      const token = await ownerToken(request)
      const auth = { authorization: `Bearer ${token}` }
      await loginAsOwner(page)
      const projectId = await createProject(request, `INV4 ${Date.now()}`)
      const seeded = await seedCandidates(request, projectId, ALPHA, ['probe_pick_1', 'probe_pick_2'])

      await dropPackage(request, token, PKG, {
        'manifest.yaml': manifestText(PKG, {
          id: ANALYSIS,
          title: PANE,
          slot: SLOT,
          datatype: ALPHA,
          ui: ['ui/form.yaml'],
        }),
        'ui/form.yaml': pickerViewText({
          specId: 'probe/launch',
          title: 'Probe launch',
          label: 'Chosen probe input',
          sourceDatatype: ALPHA,
          analysisId: ANALYSIS,
          slot: SLOT,
        }),
      })
      await openDroppedPane(page, projectId, ANALYSIS, PANE)

      // TWO compatible artifacts: a PICKER, not a throw. The behaviour this replaces
      // resolved the input between click and job and threw whenever the candidate count
      // was not exactly one — with the user shown nothing either way.
      const select = page.getByTestId('widget-probePicker-select')
      await expect(select).toBeVisible({ timeout: PAINT_TIMEOUT })
      expect(await offeredArtifacts(page, 'widget-probePicker-select')).toHaveLength(2)

      /** Launch with `artifactId` chosen in the form, and return the inputs the JOB
       *  recorded. `before` excludes the jobs this project already had, so a second launch
       *  cannot read the first one's row. */
      const launchAndRead = async (artifactId: string, before: string[]): Promise<unknown> => {
        // VISIBLE BEFORE RUN: the value the run will consume is on screen and is the one
        // the user chose. Read off the control, not off the state we just set.
        await chooseArtifact(page, 'widget-probePicker-select', artifactId)

        await page.getByTestId('widget-probeRun').click()

        let recorded: unknown
        await expect
          .poll(
            async () => {
              const r = await request.get(`${BACKEND}/api/jobs?project_id=${projectId}`, {
                headers: auth,
              })
              if (!r.ok()) return null
              // `GET /jobs` answers ROWS, not jobs: `{ job, can_stop }`. The stop right became a
              // server-stated fact rather than a predicate the client re-derives, and the job
              // moved a level down with it. Reading `j.params` off the ROW found `undefined` on
              // every row, so this poll could only ever time out — the claim it is making is
              // unchanged, and is still checked against the SAME key the launcher writes
              // (`params.analysis_id`, which the server parses as `AnalysisSpec::analysis_id`).
              const body = (await r.json()) as {
                jobs?: { job: { id: string; params?: Record<string, unknown> } }[]
              }
              const fresh = (body.jobs ?? [])
                .map(row => row.job)
                .filter(
                  j =>
                    !before.includes(j.id) &&
                    (j.params as { analysis_id?: string } | undefined)?.analysis_id === ANALYSIS,
                )
              if (fresh.length === 0) return null
              recorded = (fresh[0].params as { inputs?: unknown }).inputs
              before.push(fresh[0].id)
              return 'found'
            },
            { timeout: 30_000, message: 'the launched run must appear as a job for this analysis' },
          )
          .toBe('found')
        return recorded
      }

      const seen: string[] = []
      const firstRun = await launchAndRead(seeded.probe_pick_1, seen)
      expect(
        firstRun,
        'the run consumed the artifact the form displayed, on the slot the manifest names',
      ).toMatchObject([{ slot: SLOT, artifact_ref: seeded.probe_pick_1 }])

      // Change the picker: the NEXT launch must record the CHANGED artifact. Without this
      // half, a launch that ignored the form entirely and always bound the first candidate
      // would satisfy the assertion above.
      const secondRun = await launchAndRead(seeded.probe_pick_2, seen)
      expect(secondRun).toMatchObject([{ slot: SLOT, artifact_ref: seeded.probe_pick_2 }])
    } finally {
      removePackage(PKG)
    }
  })
})
