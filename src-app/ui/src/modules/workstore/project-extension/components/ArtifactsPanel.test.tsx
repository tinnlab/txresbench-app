// @vitest-environment jsdom
//
// THE ARTIFACTS PANE, MOUNTED — what a reader actually sees.
//
// Three claims the pure suite beside it cannot make, because all three are about the
// rendered tree rather than about a returned value:
//
//   1. NO RAW DATATYPE ID SURVIVES ON THE PAGE. The pane used to print `a.datatype`
//      verbatim, so a reader met internal ids. A source-text scan for that expression
//      would be trivially evaded; querying the mounted DOM is not, because the thing
//      being forbidden is the STRING A READER SEES, so that is what is looked for.
//   2. EVERY LISTED ROW REACHES THE PAGE, including the two the schema permits and the
//      convention forbids (a row scoped to BOTH a project and a dataset, and one scoped
//      to NEITHER). A row with no defined home is a row that vanishes.
//   3. THE PHRASE COMES FROM THE ONE REGISTRY THE DATASET SUMMARY ALREADY USES. The
//      contribution is registered through the shared singleton, never a local one, so a
//      second source of truth for the same declaration cannot pass this file.
//
// The ONLY things stubbed are the two boundaries a unit mount has no access to: the
// control-plane read (the network) and the datatype registry (populated at boot from
// `GET /api/datatypes`). The real grouping, the real preview registry, the real kit.

import { beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ListedArtifact } from '@/api-client/types'
import { datasetPreviewRegistry } from '@/modules/dataset/project-extension/preview'
import { useProjectDetailStore } from '@/modules/project/stores/ProjectDetail.store'

const A = 'ns/alpha'
const B = 'ns/beta'
const TITLES: Record<string, string> = { [A]: 'Alpha thing', [B]: 'Beta thing' }

let listed: ListedArtifact[] = []

vi.mock('@/core/workstore', async importOriginal => {
  const actual = await importOriginal<typeof import('@/core/workstore')>()
  return { ...actual, listArtifacts: async () => listed }
})

/** What the stubbed registry currently knows — emptied to model the pre-boot registry. */
let known: Record<string, string> = TITLES

vi.mock('@/core/datatypes', async importOriginal => {
  const actual = await importOriginal<typeof import('@/core/datatypes')>()
  return {
    ...actual,
    // Spread first: `subscribe` / `getVersion` are arrow-bound instance fields, and they
    // are kept REAL so a `replaceAll` on the true singleton drives the pane's
    // subscription exactly as the boot-time populate does. Only the two LOOKUPS are
    // replaced, because the real ones would answer from the true (empty) type map.
    datatypeRegistry: {
      ...actual.datatypeRegistry,
      get: (id: string) => (known[id] ? { id, title: known[id] } : undefined),
      ancestors: () => [],
    },
  }
})

/** The TRUE singleton (mock-bypassing), so a test can drive a real `replaceAll` — which
 *  is what `GET /api/datatypes` does after first paint. */
const { datatypeRegistry: realDatatypeRegistry } =
  await vi.importActual<typeof import('@/core/datatypes')>('@/core/datatypes')

const { ArtifactsPanel } = await import('./ArtifactsPanel')

let seq = 0
function row(partial: Partial<ListedArtifact> = {}): ListedArtifact {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-0000000000${String(seq).padStart(2, '0')}`,
    content_hash: `sha256:${seq}`,
    created_at: '2026-07-15T00:00:00Z',
    datatype: A,
    hidden: false,
    is_multifile: false,
    meta: {},
    object_key: `key-${seq}`,
    output_id: `out-${seq}`,
    role: 'artifact',
    // 0 stored bytes with a non-zero LOGICAL size is the gathered shape, and it is
    // the default here on purpose: any consumer that reads `stored_bytes` as a
    // display size sees 0 and fails these assertions instead of passing quietly.
    stored_bytes: 0,
    logical_bytes: 1,
    status: 'ready',
    structure: {},
    updated_at: '2026-07-15T00:00:00Z',
    // The wire always carries the source-dataset SET; a fixture that omitted it would be a
    // row no endpoint can produce. `...partial` still overrides it where a case needs to.
    source_dataset_ids: partial.source_dataset_id ? [partial.source_dataset_id] : [],
    source_dataset_names: partial.source_dataset_name ? [partial.source_dataset_name] : [],
    ...partial,
  }
}

const PROJECT_ID = '00000000-0000-4000-8000-0000000000e1'

beforeEach(() => {
  cleanup()
  known = TITLES
  // The shipped declarations are registered at import of the seam; this file's types are
  // placeholders no package speaks for, so it starts from silence and registers its own.
  datasetPreviewRegistry.clear()
  useProjectDetailStore.setState({
    projectId: PROJECT_ID,
    project: {
      id: PROJECT_ID,
      owner_id: '00000000-0000-4000-8000-00000000000f',
      name: 'A project',
      description: '',
      effective_permission: 'owner',
      dataset_count: 1,
      created_at: '2026-07-15T00:00:00Z',
      updated_at: '2026-07-15T00:00:00Z',
    },
  })
})

it('groups the catalog by dataset and by what this project produced', async () => {
  listed = [
    row({ dataset_id: 'ds1', source_dataset_id: 'ds1', source_dataset_name: 'Batch One' }),
    row({
      dataset_id: 'ds1',
      source_dataset_id: 'ds1',
      source_dataset_name: 'Batch One',
      datatype: B,
    }),
    row({ project_id: PROJECT_ID, datatype: B }),
  ]
  render(<ArtifactsPanel />)

  await waitFor(() => expect(screen.getByTestId('project-artifacts-list')).toBeTruthy())
  // One heading per scope, and the dataset's is the dataset's NAME.
  expect(screen.getByTestId('project-artifacts-scope-ds1').textContent).toContain('Batch One')
  expect(screen.getByTestId('project-artifacts-scope-unassigned')).toBeTruthy()
  // Each scope holds only its own rows.
  expect(screen.getByTestId('project-artifacts-scope-ds1').textContent).toContain(
    listed[0].output_id,
  )
  expect(screen.getByTestId('project-artifacts-scope-unassigned').textContent).not.toContain(
    listed[0].output_id,
  )
  // The manifest SLOT NAME stays on the row, inside `project-artifacts-list`. Asserted
  // through that exact locator because a live e2e under `tests/e2e/14-declarative-qc/`
  // reads a committed output through it — a regrouping that moved rows out of the list,
  // or dropped the slot name in favour of the datatype title, would break a real spec
  // that costs a sandbox run to notice.
  const list = screen.getByTestId('project-artifacts-list').textContent ?? ''
  for (const a of listed) expect(list).toContain(a.output_id)
})

it('heads each type with its DECLARED title and prints no raw datatype id', async () => {
  listed = [
    row({ dataset_id: 'ds1', source_dataset_name: 'Batch One' }),
    row({ datatype: B, project_id: PROJECT_ID }),
  ]
  render(<ArtifactsPanel />)

  await waitFor(() => expect(screen.getByTestId('project-artifacts-list')).toBeTruthy())
  const page = document.body.textContent ?? ''
  expect(page).toContain('Alpha thing')
  expect(page).toContain('Beta thing')
  // The bug this pane shipped with: the internal id, rendered to a human.
  expect(page).not.toContain(A)
  expect(page).not.toContain(B)
})

it("shows the PROCESSOR's phrase for a type whose package contributes one", async () => {
  datasetPreviewRegistry.register({
    datatype: A,
    order: 10,
    phrase: (group, title) => `${group.count} × ${title}, widest ${group.representative_output_id}`,
  })
  listed = [
    row({ dataset_id: 'ds1', source_dataset_name: 'Batch One', logical_bytes: 1, output_id: 'thin' }),
    // `wide` is the representative because it DECLARES a structure — not because it is
    // the bigger row (see `core/workstore/representative.ts`).
    row({
      dataset_id: 'ds1',
      source_dataset_name: 'Batch One',
      logical_bytes: 9,
      output_id: 'wide',
      structure: { dims: [2] },
    }),
  ]
  render(<ArtifactsPanel />)

  await waitFor(() => expect(screen.getByTestId('project-artifacts-list')).toBeTruthy())
  expect(screen.getByTestId(`project-artifacts-type-summary-ds1-${A}`).textContent).toBe(
    '2 × Alpha thing, widest wide',
  )
})

it('falls back to a count and the declared title when no package contributes', async () => {
  listed = [row({ project_id: PROJECT_ID }), row({ project_id: PROJECT_ID })]
  render(<ArtifactsPanel />)

  await waitFor(() => expect(screen.getByTestId('project-artifacts-list')).toBeTruthy())
  expect(screen.getByTestId(`project-artifacts-type-summary-unassigned-${A}`).textContent).toBe(
    '2 Alpha thing',
  )
})

it('gives the two rows the schema permits a home instead of dropping them', async () => {
  const both = row({ project_id: PROJECT_ID, dataset_id: 'ds1', source_dataset_name: 'Batch One' })
  const neither = row({})
  listed = [both, neither]
  render(<ArtifactsPanel />)

  await waitFor(() => expect(screen.getByTestId('project-artifacts-list')).toBeTruthy())
  // BOTH → the narrower scope wins: it is stored under a dataset, so it shows there.
  expect(screen.getByTestId('project-artifacts-scope-ds1').textContent).toContain(both.output_id)
  // NEITHER → the residual bucket. It came back from THIS project's catalog, so that is
  // the only true thing the pane can say about it.
  expect(screen.getByTestId('project-artifacts-scope-unassigned').textContent).toContain(
    neither.output_id,
  )
})

it('corrects itself when the datatype registry lands AFTER first paint', async () => {
  // The registry is populated from the API after the first render, so a pane that read it
  // once would show raw ids forever — the very bug it exists to fix, arriving late.
  known = {}
  listed = [row({ project_id: PROJECT_ID })]
  render(<ArtifactsPanel />)
  await waitFor(() => expect(screen.getByTestId('project-artifacts-list')).toBeTruthy())
  expect(document.body.textContent ?? '').toContain(A)

  known = TITLES
  await act(async () => {
    realDatatypeRegistry.replaceAll([])
  })
  await waitFor(() => expect(document.body.textContent ?? '').toContain('Alpha thing'))
  expect(document.body.textContent ?? '').not.toContain(A)
})

it('keeps the empty state when the catalog is empty', async () => {
  listed = []
  render(<ArtifactsPanel />)
  await waitFor(() => expect(screen.getByTestId('project-artifacts-empty')).toBeTruthy())
  expect(screen.queryByTestId('project-artifacts-list')).toBeNull()
})

it('accounts for the gap between its count and the dataset summary′s, on the page', async () => {
  // The defect this fixes: the same datatype reported 3 here and 1 in the dataset
  // summary, with nothing on screen saying why. The pane now states its composition —
  // and only when there IS something to state, so the qualifier's presence is the signal.
  listed = [
    row({ dataset_id: 'ds1', source_dataset_name: 'Batch One' }),
    row({ dataset_id: 'ds1', source_dataset_name: 'Batch One', status: 'failed' }),
    row({ dataset_id: 'ds1', source_dataset_name: 'Batch One', role: 'intermediate' }),
  ]
  render(<ArtifactsPanel />)

  await waitFor(() => expect(screen.getByTestId('project-artifacts-list')).toBeTruthy())
  const qualifier = screen.getByTestId(`project-artifacts-type-readiness-ds1-${A}`)
  expect(qualifier.textContent).toBe('(1 ready · 1 failed · 1 intermediate)')
  // The account itself is reachable, not merely implied by the numbers.
  expect(qualifier.getAttribute('title')).toBe(
    'This list shows everything in the store; summaries count only ready artifacts (1 of 3 here).',
  )
  // The contributed/fallback phrase is UNTOUCHED — the qualifier is the app's arithmetic
  // beside the package's sentence, never a rewrite of it.
  expect(screen.getByTestId(`project-artifacts-type-summary-ds1-${A}`).textContent).toBe(
    '3 Alpha thing',
  )
})

it('stays silent when every row is a ready artifact — there is nothing to explain', async () => {
  listed = [
    row({ dataset_id: 'ds1', source_dataset_name: 'Batch One' }),
    row({ dataset_id: 'ds1', source_dataset_name: 'Batch One' }),
  ]
  render(<ArtifactsPanel />)

  await waitFor(() => expect(screen.getByTestId('project-artifacts-list')).toBeTruthy())
  expect(screen.queryByTestId(`project-artifacts-type-readiness-ds1-${A}`)).toBeNull()
})


// ── ITEM-48 — the bucket is an absence, and every row says who made it ───────────
//
// Both claims are about the RENDERED TREE, which is why they live here and not beside
// the pure grouping tests: the first forbids a SENTENCE A READER SEES (a source scan for
// the literal would be evaded by any indirection), and the second is about an element
// existing on a row.

it('never shows "Produced in this project" — the empty bucket is an absence, not a category', async () => {
  listed = [
    row({ dataset_id: 'ds1', source_dataset_id: 'ds1', source_dataset_name: 'Batch One' }),
    row({ project_id: PROJECT_ID }),
    row({}),
  ]
  render(<ArtifactsPanel />)
  await waitFor(() => expect(screen.getByTestId('project-artifacts-list')).toBeTruthy())

  // The whole pane, not just the heading: the sentence must not survive anywhere.
  expect(screen.getByTestId('project-artifacts-card').textContent).not.toContain(
    'Produced in this project',
  )
  // POSITIVE CONTROL — the unassigned rows still REACH the page. Without this, deleting
  // the bucket entirely would satisfy the assertion above, and a row with no defined home
  // is a row that vanishes (claim 2 of this file's header).
  const unassigned = screen.getByTestId('project-artifacts-scope-unassigned')
  expect(unassigned.textContent).toContain(listed[1].output_id)
  expect(unassigned.textContent).toContain(listed[2].output_id)
})

it('explains the unassigned bucket, and says it only where it applies', async () => {
  // ADDED AFTER A MUTATION FAILED TO GO RED. Deleting the note entirely left this file
  // green — I had rendered it and asserted nothing about it, so the heading's "reads as an
  // absence, not a category" claim rested on a testid nobody looked at. A control that
  // does not go red is a finding about the test (`BASE.md`), and this is the finding.
  listed = [
    row({ dataset_id: 'ds1', source_dataset_id: 'ds1', source_dataset_name: 'Batch One' }),
    row({ project_id: PROJECT_ID }),
  ]
  render(<ArtifactsPanel />)
  await waitFor(() => expect(screen.getByTestId('project-artifacts-list')).toBeTruthy())

  const note = screen.getByTestId('project-artifacts-unassigned-note')
  expect(note.textContent).toContain('could not be traced to a dataset')

  // ...and ONCE, under the unassigned heading only. A note repeated under every dataset
  // group is chrome a reader learns to skip, which is the failure mode the heading change
  // exists to avoid — so "it renders" is not the whole claim.
  expect(screen.getAllByTestId('project-artifacts-unassigned-note')).toHaveLength(1)
  expect(screen.getByTestId('project-artifacts-scope-unassigned').textContent).toContain(
    'could not be traced to a dataset',
  )
  expect(screen.getByTestId('project-artifacts-scope-ds1').textContent).not.toContain(
    'could not be traced to a dataset',
  )
})

it('tags a row with the analysis that produced it, and tags nothing when none is recorded', async () => {
  listed = [
    row({ project_id: PROJECT_ID, generator_id: 'pkg.thing' }),
    row({ project_id: PROJECT_ID }),
  ]
  render(<ArtifactsPanel />)
  await waitFor(() => expect(screen.getByTestId('project-artifacts-list')).toBeTruthy())

  const made = screen.getByTestId(`project-artifact-producer-${listed[0].id}`)
  expect(made.textContent).toContain('pkg.thing')

  // THE NEGATIVE HALF, and it is the one that matters. `generator_id` is NULL for an
  // import, an upload, a seeded row, and for a run that recorded no provenance — all
  // "not attributable". Rendering a tag there (an em-dash, "unknown", the run id) would
  // assert an attribution the wire explicitly declines to make.
  expect(screen.queryByTestId(`project-artifact-producer-${listed[1].id}`)).toBeNull()
})
