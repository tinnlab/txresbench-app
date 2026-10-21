// Headless unit test of the project attach-picker's share-aware candidate logic
// (ITEM-3 FE). Same idiom as `cellSetSelectorBuilder.test.ts` — this app has no
// vitest; the monorepo unit-tests pure TS via node's built-in runner:
//
//   node --test --experimental-strip-types \
//     'src/modules/dataset/project-extension/components/attachOptions.test.ts'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  candidateSearchText,
  isReady,
  mergeAttachCandidates,
  notReadyNote,
} from './attachOptions.ts'
import type { DatasetListItem } from '@/api-client/types'

const ds = (
  id: string,
  name: string,
  datatype?: string,
  processing?: { status?: string; error?: string },
): DatasetListItem =>
  ({
    id,
    name,
    datatype,
    metadata: {},
    owner_id: 'u1',
    source: 'upload',
    processing_status: processing?.status,
    processing_error: processing?.error,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }) as DatasetListItem

test('owned ∪ shared are BOTH offered, tagged by source, owned first', () => {
  const out = mergeAttachCandidates(
    [ds('o1', 'Owned A')],
    [ds('s1', 'Shared B')],
    new Set(),
  )
  assert.deepEqual(
    out.map(c => [c.id, c.source]),
    [
      ['o1', 'owned'],
      ['s1', 'shared'],
    ],
  )
})

test('datasets already linked to THIS project are filtered out (both sources)', () => {
  const out = mergeAttachCandidates(
    [ds('o1', 'Owned A'), ds('o2', 'Owned B')],
    [ds('s1', 'Shared A')],
    new Set(['o1', 's1']),
  )
  assert.deepEqual(out.map(c => c.id), ['o2'])
})

test('a dataset NOT linked to this project stays selectable — M:N allows many-to-one', () => {
  // The candidate carries no notion of "linked to OTHER projects"; only this
  // project's attachedIds prune it, so a multi-project dataset remains attachable.
  const out = mergeAttachCandidates([ds('o1', 'Cross-project set')], [], new Set())
  assert.deepEqual(out.map(c => c.id), ['o1'])
})

test('id collision is deduped — owned wins over shared', () => {
  const out = mergeAttachCandidates(
    [ds('x', 'From owned')],
    [ds('x', 'From shared')],
    new Set(),
  )
  assert.equal(out.length, 1)
  assert.deepEqual([out[0].id, out[0].source, out[0].name], ['x', 'owned', 'From owned'])
})

test('datatype passes through; an untyped dataset yields undefined (no cell/gene counts — DEC-1)', () => {
  const out = mergeAttachCandidates(
    [ds('o1', 'Typed', 'single-cell/expression'), ds('o2', 'Untyped')],
    [],
    new Set(),
  )
  assert.equal(out.find(c => c.id === 'o1')?.datatype, 'single-cell/expression')
  assert.equal(out.find(c => c.id === 'o2')?.datatype, undefined)
})

test('each source is sorted by name, case-insensitively', () => {
  const out = mergeAttachCandidates(
    [ds('o1', 'beta'), ds('o2', 'Alpha'), ds('o3', 'gamma')],
    [],
    new Set(),
  )
  assert.deepEqual(out.map(c => c.name), ['Alpha', 'beta', 'gamma'])
})

// ── readiness ────────────────────────────────────────────────────────────────
//
// "Still show all datasets" was already true — nothing here has ever filtered on
// readiness, so a test that only asserts a failed dataset is LISTED passes on the
// code that lost the status entirely. Each test below therefore asserts BOTH: that
// it is offered, and that it arrives carrying what makes it markable.

test('a dataset whose processing FAILED is still offered, and CARRIES its status', () => {
  const out = mergeAttachCandidates(
    [
      ds('ok', 'Fine', 'probe/alpha', { status: 'completed' }),
      ds('bad', 'Broken', 'probe/alpha', { status: 'failed', error: 'converter exited 2' }),
    ],
    [],
    new Set(),
  )
  // listed …
  assert.deepEqual(out.map(c => c.id), ['bad', 'ok'], 'both are offered (sorted by name)')
  // … and MARKABLE: the status + reason survive the mapping.
  const bad = out.find(c => c.id === 'bad')
  assert.equal(bad?.processingStatus, 'failed')
  assert.equal(bad?.processingError, 'converter exited 2')
  assert.equal(isReady(bad!), false)
  // The healthy one is not accidentally marked.
  assert.equal(isReady(out.find(c => c.id === 'ok')!), true)
})

test('a dataset with no processing job at all reads as ready (no badge, no note)', () => {
  const [only] = mergeAttachCandidates([ds('o1', 'Plain')], [], new Set())
  assert.equal(only.processingStatus, undefined)
  assert.equal(isReady(only), true)
  assert.equal(notReadyNote(only), null)
})

test('the not-ready note names the CONSEQUENCE, and never blocks the link', () => {
  const failed = notReadyNote({ processingStatus: 'failed', processingError: 'exit 2' })
  assert.ok(failed, 'a failed dataset gets a note')
  assert.match(failed!, /still link it/i, 'the note says the link is allowed')
  assert.match(failed!, /exit 2/, 'the reason is carried through when the server sent one')

  const running = notReadyNote({ processingStatus: 'running' })
  assert.ok(running, 'an in-flight dataset gets a note too')
  assert.match(running!, /still being processed/i)
  assert.doesNotMatch(running!, /failed/i, 'and it is NOT worded as a failure')

  assert.equal(notReadyNote({ processingStatus: 'completed' }), null, 'a ready one is silent')
})

test('the search haystack is the NAME and the visible type label — never the id', () => {
  const [c] = mergeAttachCandidates([ds('11111111-2222-3333-4444-555555555555', 'Donor A')], [], new Set())
  const haystack = candidateSearchText(c, 'Table')
  assert.match(haystack, /Donor A/, 'the name is searchable')
  assert.match(haystack, /Table/, 'so is the type label the row shows')
  assert.doesNotMatch(
    haystack,
    /11111111/,
    'the uuid is NOT the haystack — matching on it is what the kit falls back to ' +
      'when a caller with a node label supplies no searchText, and it is why typing ' +
      'a name used to match nothing',
  )
})
