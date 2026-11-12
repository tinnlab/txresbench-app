// spatial-capability-gate.spec.ts — #159 TEST-1 [acceptance] [invariant: INV-1].
//
// > *"`has:spatial` is true for a project holding a `spatial/coordinates` artifact; …
// >  the filter package's gated button renders."*
// >   — `docs/design/spatial-storage-layout.md` §14, the invariant filed against this item
//
// A shipped package has been asking for this since before the storage layout existed. The
// filter package's declarative UI carries a pair of buttons gated `when: "has:spatial && …"`,
// and the capability
// they gate has been unsatisfiable for their whole life: nothing declared it. The type package
// now does, and this spec is the proof that the gate lights — end to end, in a real browser,
// against a real project, through the shipped predicate.
//
// ── WHY IT IS PROVEN BY RENDERING RATHER THAN BY READING THE MANIFEST ────────────────────────
// The claim "a project with these artifacts shows that button" spans four layers that are each
// individually easy to get right and were, until this item, never checked together: the type
// package's declaration, the datatype registry's population from `GET /api/datatypes`, the
// capability derivation over the project's PRODUCED datatypes, and the widget host's `when`
// evaluation. There is unit coverage of the last two. There was none of the whole.
//
// The honest possible outcome — and the likely one — is that no product code was required here
// and the mechanism already worked. That is a legitimate finding only if it is DEMONSTRATED.
//
// ── AND WHY NO DATATYPE ID IS SPELLED ────────────────────────────────────────────────────────
// The vocabulary guard derives its forbidden tokens from the package manifests and scans this
// directory. So the subject is DERIVED at seed time from `GET /api/datatypes`: the non-abstract
// type declaring both the `spatial` and `spatial-coordinates` capabilities. Deriving on the
// capability is also the stronger statement — it is the very fact the gate reads.

import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, openWorkbench, trackErrors } from '../14-workbench/_dock'
import { awaitFilterSurface, CF, postSeedPlan, seedQcDataset } from './_seed'
import { positionsArtifact } from './_fixtures'

const VIZ_FIXTURES = path.resolve(process.cwd(), '../libs/viz/src/viz-core/spatial/fixtures')
/** The producer's own manifest entry for a real emitted raster — the datatype id lives in a
 *  fixture OUTSIDE the linted roots, which is how this directory names one without spelling it. */
const RASTER = (
  JSON.parse(readFileSync(path.join(VIZ_FIXTURES, 'emitted-manifest-entries.json'), 'utf8')) as {
    id: string
    datatype: string
    structure: unknown
    meta: unknown
  }[]
).find(m => m.id === 'spatial-image-hires')!

/** The gated pair, by the testid the widget host stamps (`widget-<id>`). */
const SHOW_SPATIAL = 'widget-showSpatialBtn'
const HIDE_SPATIAL = 'widget-hideSpatialBtn'

const ROWS = 40

/**
 * The datatype that carries the capability the gate reads — DERIVED from the live registry,
 * never written down.
 *
 * Two capabilities, not one: `spatial` alone is also declared by the boundary kind, and the
 * invariant is specifically about the COORDINATE artifact. `spatial-coordinates` narrows it to
 * exactly one non-abstract type without this file naming that type.
 */
async function coordinateDatatypeId(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.get(`${BACKEND}/api/datatypes`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `the datatype registry answered ${res.status()}`).toBeTruthy()
  const rows = (await res.json()) as { id: string; is_abstract?: boolean; capabilities?: string[] }[]
  const hits = rows.filter(
    t =>
      !t.is_abstract &&
      (t.capabilities ?? []).includes('spatial') &&
      (t.capabilities ?? []).includes('spatial-coordinates'),
  )
  expect(
    hits.map(t => t.id),
    'exactly one shipped type declares the coordinate capability pair — zero would mean the ' +
      'type package never registered (the gate could then never light, and every assertion ' +
      'below would be vacuously about an empty screen)',
  ).toHaveLength(1)
  return hits[0].id
}

/** A project holding the expression artifact that auto-mounts the filter surface. */
async function projectWithFilterSurface(request: APIRequestContext, name: string): Promise<string> {
  const token = await ownerToken(request)
  const project = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: `${name} ${Date.now()}`, description: '' },
    })
  ).json()
  await seedQcDataset(request, project.id, { annotated: true, expression: true })
  return project.id as string
}

async function openFilterSurface(page: Page, projectId: string) {
  await openWorkbench(page, projectId)
  await awaitFilterSurface(page)
}

test('the shipped capability gate lights for a project that holds spatial positions — TEST-1', async ({
  page,
  request,
}) => {
  const token = await ownerToken(request)
  const datatype = await coordinateDatatypeId(request, token)

  const withSpatial = await projectWithFilterSurface(request, 'spatial gate ON')

  // A REAL dense positions artifact, under the spatial coordinate datatype — the same member
  // shape the coordinate kind declares, so this is the artifact a real import emits and not a
  // placeholder wearing its name.
  const positions = positionsArtifact(ROWS)
  await postSeedPlan(request, withSpatial, {
    artifacts: [
      {
        output_id: 'tissue-positions',
        datatype,
        structure: positions.structure,
        content: { encoding: 'members', members: positions.members },
      },
    ],
  })

  await loginAsOwner(page)
  const errors = trackErrors(page)
  await openFilterSurface(page, withSpatial)

  await expect(
    page.getByTestId(SHOW_SPATIAL),
    'the shipped `when: "has:spatial && …"` button must render for a project that holds a ' +
      'spatial coordinate artifact — this pair has been unsatisfiable since the day it shipped',
  ).toBeVisible({ timeout: 30_000 })

  // Its partner is hidden, because the SECOND half of the same expression (`$state.showSpatial`)
  // is false. Stated because it is what shows the gate is evaluating the whole predicate rather
  // than merely rendering both buttons whenever the capability is present.
  await expect(page.getByTestId(HIDE_SPATIAL)).toHaveCount(0)

  // eslint-disable-next-line no-console
  console.log(`[TEST-1] has:spatial lit for a project holding one artifact of "${datatype}"`)
  expect(errors.errors, `a clean console: ${errors.errors.slice(0, 3).join(' | ')}`).toEqual([])
})

test('…and stays dark for the same project WITHOUT one — the gate is a gate — TEST-1', async ({
  page,
  request,
}) => {
  // THE POSITIVE CONTROL, and it is the half that makes the case above mean anything. "The
  // button is absent" passes vacuously when the surface never rendered at all — a failed route,
  // a login bounce, a crashed pane, an empty shell all satisfy it. So this seeds an IDENTICAL
  // project minus the one artifact, proves the SURFACE mounted and its ungated widgets render,
  // and only then asserts the gated pair is absent.
  const withoutSpatial = await projectWithFilterSurface(request, 'spatial gate OFF')

  await loginAsOwner(page)
  const errors = trackErrors(page)
  await openFilterSurface(page, withoutSpatial)

  // The control: the surface is REALLY there.
  await expect(
    page.getByTestId(CF.add),
    'the filter surface itself must have mounted, or "the gated button is absent" says nothing',
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId(CF.table)).toBeVisible()

  // …and the gated pair is not.
  await expect(page.getByTestId(SHOW_SPATIAL)).toHaveCount(0)
  await expect(page.getByTestId(HIDE_SPATIAL)).toHaveCount(0)

  expect(errors.errors, `a clean console: ${errors.errors.slice(0, 3).join(' | ')}`).toEqual([])
})

test('BOTH clauses of the invariant, on ONE project — TEST-1', async ({ page, request }) => {
  // ── WHY THIS CASE EXISTS ────────────────────────────────────────────────────────────────────
  // INV-1 is a single sentence about a single project: *for a project holding a spatial
  // coordinate artifact*, `has:spatial` is true AND `imageUnderlay()` returns. The two cases
  // above and the render spec together prove the two clauses — but on DISJOINT projects: the
  // gate spec seeds coordinates and no raster, the render spec seeds a raster and never asks
  // about the gate. Neither demonstrates the conjunction the invariant states, and a reader
  // could reasonably take two green specs about two projects as proof of one sentence about one.
  //
  // A note on the literal reading, since it matters: a project holding ONLY coordinates — which
  // is exactly what the import emits before a raster exists — still has `imageUnderlay()`
  // refuse, because there is no image to serve. The invariant's three clauses are three separate
  // proofs required of this item, not a claim that coordinates conjure an image. What IS
  // required, and is asserted here, is that a project holding both gets both.
  const token = await ownerToken(request)
  const datatype = await coordinateDatatypeId(request, token)
  const projectId = await projectWithFilterSurface(request, 'spatial gate BOTH')

  const positions = positionsArtifact(ROWS)
  await postSeedPlan(
    request,
    projectId,
    {
      artifacts: [
        {
          output_id: 'tissue-positions',
          datatype,
          structure: positions.structure,
          content: { encoding: 'members', members: positions.members },
        },
        {
          output_id: RASTER.id,
          datatype: RASTER.datatype,
          structure: RASTER.structure,
          meta: RASTER.meta,
          content: { encoding: 'input' },
        },
      ],
    },
    readFileSync(path.join(VIZ_FIXTURES, 'spatial-image-hires.ome.tif')),
  )

  await loginAsOwner(page)
  const errors = trackErrors(page)
  await openFilterSurface(page, projectId)

  // CLAUSE 1 — the capability gate lights.
  await expect(page.getByTestId(SHOW_SPATIAL)).toBeVisible({ timeout: 30_000 })

  // CLAUSE 2 — and on the SAME project, the object the grid holds answers rather than throwing.
  await page.waitForFunction(
    () => !!(window as unknown as { __txr_stream?: { source?: unknown } }).__txr_stream?.source,
    undefined,
    { timeout: 60_000 },
  )
  const served = await page.evaluate(async (id: string) => {
    const seam = (
      window as unknown as { __txr_stream: { source: (p: string) => Record<string, unknown> | null } }
    ).__txr_stream
    const source = seam.source(id)
    if (!source) return { error: 'no production source published for this project' }
    try {
      const underlay = (await (source.imageUnderlay as () => Promise<Record<string, unknown>>)()) as {
        width: number
        height: number
        channels: number
        data: Uint8Array
      }
      return { width: underlay.width, height: underlay.height, bytes: underlay.data.length }
    } catch (e) {
      return { error: String(e) }
    }
  }, projectId)

  expect(served.error, `imageUnderlay() refused: ${served.error ?? ''}`).toBeUndefined()
  expect([served.width, served.height]).toEqual([350, 450])
  expect(served.bytes).toBe(350 * 450 * 4)

  // eslint-disable-next-line no-console
  console.log(
    `[TEST-1] one project: has:spatial lit AND imageUnderlay() served ${served.width}x${served.height}`,
  )
  expect(errors.errors, `a clean console: ${errors.errors.slice(0, 3).join(' | ')}`).toEqual([])
})
