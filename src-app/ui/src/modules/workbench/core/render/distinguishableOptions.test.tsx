// @vitest-environment jsdom
//
// THE CLASS TEST — a list whose rows a person cannot tell apart.
//
// ── Why this is a class and not three bugs ────────────────────────────────────────────────
//
// The Visualize pane shipped, passed every gate it had, and was rejected on sight. Three of the
// owner's findings were one defect wearing three hats:
//
//   · the (since-deleted) row-space picker offered two options that both LED with the same
//     dataset filename, so one dataset with two axes read as two datasets;
//   · the coordinates picker offered N options all reading one datatype word,
//     disambiguated by eight characters of content hash — appended because the DECLARED name that
//     distinguishes them (`meta.source_key`) was never used;
//   · every option in that picker carried the SAME dataset on its second line, spending the
//     one slot meant to distinguish the options on a constant.
//
// Every existing gate reads source or asserts structure, and not one of them can see that a
// column of ten identical words is useless. So the assertion here is on RENDERED TEXT, and it is
// stated as a property of any list rather than as three fixed strings:
//
//   A. no two options in one picker may render the same visible text when a distinguishing
//      DECLARED name exists on the underlying data;
//   B. no list may render the same text on every row in a position meant to distinguish them —
//      a subtitle identical across all options is, by construction, carrying no information.
//
// A test per SYMPTOM would let the next one through, which is exactly what happened here.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { ArtifactRow } from '@/modules/workbench/extensions/data/contract'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { CATALOG_SCOPE_KEY } from '@/modules/workbench/core/artifacts/catalog'
import { __clearWidgetsForTests, registerWidget } from './registry'
import { ArtifactRefRenderer } from './ArtifactRefWidget'
import { WidgetList } from './WidgetHost'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  Element.prototype.scrollIntoView ??= function scrollIntoView(): void {}
})

// ── the two clauses, as reusable assertions ──────────────────────────────────────────────

/**
 * CLAUSE A — every row reads differently.
 *
 * Compares the rows' whole visible text, whitespace-normalized, because that is what a person
 * compares. A duplicate is reported WITH the offending string: "two rows are equal" sends the
 * next reader back to the DOM, and the string is the finding.
 */
function expectRowsDistinguishable(rows: readonly string[], what: string): void {
  const seen = new Map<string, number>()
  for (const r of rows) {
    const k = r.replace(/\s+/g, ' ').trim()
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${n}× "${k}"`)
  expect(dupes, `${what}: rows a user cannot tell apart`).toEqual([])
}

/**
 * CLAUSE B — no distinguishing SLOT holds a constant.
 *
 * `lines` is one array per row, positionally: `[[name, subtitle], [name, subtitle], …]`. A
 * position whose value is identical on every row (and there is more than one row) is carrying
 * no information where information was promised. Position 0 is included: a picker whose every
 * NAME is the same word is the coordinates defect exactly.
 */
function expectNoConstantSlot(lines: readonly (readonly string[])[], what: string): void {
  if (lines.length < 2) return
  const width = Math.max(...lines.map(l => l.length))
  const offenders: string[] = []
  for (let i = 0; i < width; i++) {
    const col = lines.map(l => (l[i] ?? '').replace(/\s+/g, ' ').trim())
    if (col.every(v => v !== '' && v === col[0])) offenders.push(`slot ${i} is always "${col[0]}"`)
  }
  expect(offenders, `${what}: a distinguishing slot repeats one constant`).toEqual([])
}

// ── fixtures — the REAL shape the shipped importer emits ─────────────────────────────────
//
// `meta.name` is one identical datatype word on every artifact of the set (the producer's old
// default), and `meta.source_key` is the key each was harvested under. Both are copied from the
// producer verbatim; the second is what tells them apart and what nothing was reading. The
// SHAPE is reproduced, in neutral terms — nothing in this defect is about any particular
// science, and app-core may carry no domain vocabulary at all (the `no-domain-in-builtin`
// ratchet), which is the same rule that makes the datatype word a bad display name.

function positions(id: string, sourceKey: string | null, nDims: number, nRows = 3460): ArtifactRow {
  const meta: Record<string, unknown> = { name: 'positions', kind: 'positions', axis: 'rows-a' }
  if (sourceKey != null) meta.source_key = sourceKey
  return {
    id,
    project_id: 'p1',
    datatype: 'demo/positions',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'rows-a',
      n: nRows,
      arrays: [{ path: 'values', kind: 'numeric', shape: [nRows, nDims] }],
    },
    meta,
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds-a',
    source_dataset_name: '1ddf5a78-4a2c-11ef-9c3d-0242ac120002.dat',
    source_dataset_ids: ['ds-a'],
    source_dataset_names: ['1ddf5a78-4a2c-11ef-9c3d-0242ac120002.dat'],
  } as ArtifactRow
}

const SPEC: WidgetSpec = {
  id: 'coords',
  kind: 'artifact_ref',
  control: 'radio',
  source: { datatype: 'demo/positions' },
  value: '$state.coordinate',
  onChange: 'noop',
} as WidgetSpec

function scopeWith(artifacts: ArtifactRow[]): Scope {
  return {
    params: {},
    state: {},
    derived: {},
    const: {},
    data: {},
    [CATALOG_SCOPE_KEY]: { artifacts },
  } as unknown as Scope
}

function mount(artifacts: ArtifactRow[]) {
  registerWidget('artifact_ref', ArtifactRefRenderer)
  return render(<WidgetList specs={[SPEC]} scope={scopeWith(artifacts)} viewId="v1" specId="s1" />)
}

/** One entry per rendered option: its lines, top to bottom, as a person reads them. */
async function renderedOptionLines(): Promise<string[][]> {
  const group = await screen.findByTestId('widget-coords-radio')
  return await waitFor(() => {
    const labels = [...group.querySelectorAll('[data-artifact-id]')]
    expect(labels.length).toBeGreaterThan(0)
    return labels.map(el =>
      [...el.children].map(c => (c.textContent ?? '').trim()).filter(t => t !== ''),
    )
  })
}

beforeEach(() => {
  __clearWidgetsForTests()
  cleanup()
})
afterEach(() => {
  __clearWidgetsForTests()
  cleanup()
})

describe('a picker may not offer options a person cannot tell apart', () => {
  it('CLAUSE A — same declared name, different declared source key ⇒ the SOURCE KEY distinguishes, not a hash', async () => {
    mount([positions('a1b2c3d4-0000-0000-0000-000000000001', 'K_alpha', 2),
           positions('e5f6a7b8-0000-0000-0000-000000000002', 'K_beta', 50),
           positions('c9d0e1f2-0000-0000-0000-000000000003', 'K_gamma', 2)])
    const lines = await renderedOptionLines()
    expect(lines).toHaveLength(3)
    const names = lines.map(l => l[0] ?? '')

    expectRowsDistinguishable(names, 'coordinates picker')

    // …and distinguished by the DECLARED word, never by identity. A hash suffix here is the
    // shipped defect: it is what a picker falls back to when the name that distinguishes was
    // not read, so its presence is the assertion that matters, not the resulting uniqueness.
    for (const n of names) {
      expect(n, 'an option qualified by content hash instead of a declared name').not.toMatch(
        /\b[0-9a-f]{8}\b/,
      )
    }
    expect(names.join(' ')).toContain('K_alpha')
    expect(names.join(' ')).toContain('K_beta')
  })

  it('CLAUSE A — with NO declared distinguisher the identity fallback is allowed, and still distinguishes', async () => {
    // The stated fallback (see `declaredQualifier`). Old data that declares nothing must still
    // yield a selectable, distinguishable list — it is opaque, not broken.
    mount([positions('a1b2c3d4-0000-0000-0000-000000000001', null, 2),
           positions('e5f6a7b8-0000-0000-0000-000000000002', null, 2)])
    const names = (await renderedOptionLines()).map(l => l[0] ?? '')
    expectRowsDistinguishable(names, 'coordinates picker with nothing declared')
  })

  it('CLAUSE B — no slot repeats a constant: one dataset ⇒ the dataset is not printed under every option', async () => {
    mount([positions('a1b2c3d4-0000-0000-0000-000000000001', 'K_alpha', 2),
           positions('e5f6a7b8-0000-0000-0000-000000000002', 'K_beta', 50)])
    const lines = await renderedOptionLines()
    expectNoConstantSlot(lines, 'coordinates picker')
    // Specifically: the constant that was there. With one source dataset it is on screen ZERO
    // times — no per-row line and (since the grouping verdict is the same one) no heading either.
    const flat = lines.flat().join(' | ')
    expect(flat).not.toContain('1ddf5a78')
  })

  it('CLAUSE B — a coverage true of EVERY option is stated once, above the list, not on each row', async () => {
    // Two 2-D layouts over one set of rows: same rows, same components, so the coverage string is
    // identical. Repeating it per row would be the dataset defect again under a new name.
    mount([positions('a1b2c3d4-0000-0000-0000-000000000001', 'K_alpha', 2),
           positions('e5f6a7b8-0000-0000-0000-000000000002', 'K_gamma', 2)])
    const lines = await renderedOptionLines()
    expectNoConstantSlot(lines, 'coordinates picker, identical coverage')
    const shared = screen.getByTestId('widget-coords-shared-coverage')
    expect(shared.textContent).toContain('3,460 rows')
  })

  it('CLAUSE B — a coverage that DIFFERS stays on the rows, where it distinguishes', async () => {
    mount([positions('a1b2c3d4-0000-0000-0000-000000000001', 'K_alpha', 2),
           positions('e5f6a7b8-0000-0000-0000-000000000002', 'K_beta', 50)])
    const lines = await renderedOptionLines()
    const subtitles = lines.map(l => l[1] ?? '')
    expect(subtitles.join(' ')).toContain('2D')
    expect(subtitles.join(' ')).toContain('50D')
    expect(screen.queryByTestId('widget-coords-shared-coverage')).toBeNull()
  })

  it('the assertions THEMSELVES fail on the shipped shape (negative control)', async () => {
    // A guard that cannot fail is a guard that certifies whatever it is pointed at. These are
    // the exact strings the rejected pane rendered.
    expect(() =>
      expectRowsDistinguishable(['positions', 'positions', 'positions'], 'shipped'),
    ).toThrow()
    expect(() =>
      expectNoConstantSlot(
        [
          ['Alpha', '1ddf5a78-….dat'],
          ['t-SNE', '1ddf5a78-….dat'],
        ],
        'shipped',
      ),
    ).toThrow()
    // …and PASS on a list that genuinely distinguishes, so they are not merely always-throwing.
    expectRowsDistinguishable(['Alpha', 'Beta'], 'ok')
    expectNoConstantSlot([['Alpha', '2D'], ['Beta', '50D']], 'ok')
  })
})

// ── the same class, on the OTHER list it applies to ──────────────────────────────────────
//
// This block used to drive the ROW-SPACE PICKER's labellers (`rowSpaceOptions` →
// `sharedRowSpaceSource` / `rowSpaceOptionLabel` / `rowSpaceLabel`): one dataset publishing two
// axes rendered two rows both LEADING with the same filename, so it read as two datasets.
//
// That control is deleted and those four labellers with it (owner, 2026-08-13: there is no such
// thing as a row space, and an axis is never a thing a user picks). The RULE it was here to
// protect — print what distinguishes, suppress what is constant — did not go anywhere; it was
// inherited by § Coordinates' own radio arm, which now draws one group per SOURCE DATASET with a
// heading, and stops printing the dataset per row exactly where the heading appears.
//
// So the cases are re-pointed at that surface rather than deleted, and they get STRONGER in the
// move: the old pair compared strings out of a pure function, and these read RENDERED TEXT out of
// the shipped control, which is the whole premise of this file.

describe('the grouped radio arm states the dataset once, not once per option', () => {
  /** The same positions fixture, in a NAMED dataset — the heading has to be a name, and the
   *  per-row repetition it replaces was a name too. */
  function inDataset(id: string, sourceKey: string, datasetId: string, datasetName: string): ArtifactRow {
    const base = positions(id, sourceKey, 2) as ArtifactRow & Record<string, unknown>
    return {
      ...base,
      source_dataset_id: datasetId,
      source_dataset_name: datasetName,
      source_dataset_ids: [datasetId],
      source_dataset_names: [datasetName],
    } as ArtifactRow
  }

  /** One entry per rendered option in ONE group, its lines top to bottom. */
  function groupOptionLines(group: HTMLElement): string[][] {
    return [...group.querySelectorAll('[data-artifact-id]')].map(el =>
      [...el.children].map(c => (c.textContent ?? '').trim()).filter(t => t !== ''),
    )
  }

  it('TWO datasets: the dataset is the HEADING, and no option row repeats it', async () => {
    mount([
      inDataset('a1b2c3d4-0000-0000-0000-000000000001', 'K_alpha', 'ds-a', 'Batch A'),
      inDataset('e5f6a7b8-0000-0000-0000-000000000002', 'K_beta', 'ds-a', 'Batch A'),
      inDataset('c9d0e1f2-0000-0000-0000-000000000003', 'K_gamma', 'ds-b', 'Batch B'),
    ])
    const headings = await waitFor(() => {
      const hs = [
        screen.getByTestId('widget-coords-group-0'),
        screen.getByTestId('widget-coords-group-1'),
      ]
      return hs.map(h => (h.textContent ?? '').trim())
    })
    // The distinguisher is stated ONCE per group, where it distinguishes.
    expect(headings).toEqual(['Batch A', 'Batch B'])
    expectRowsDistinguishable(headings, 'coordinates radio group headings')

    // …and ZERO times inside the rows, which is the constant-in-a-distinguishing-slot defect.
    const groupA = groupOptionLines(screen.getByTestId('widget-coords-radio-group-0'))
    const groupB = groupOptionLines(screen.getByTestId('widget-coords-radio-group-1'))
    expect(groupA).toHaveLength(2)
    expect(groupB).toHaveLength(1)
    const flat = [...groupA, ...groupB].flat().join(' | ')
    expect(flat).not.toContain('Batch A')
    expect(flat).not.toContain('Batch B')

    // Clause A + B still hold WITHIN the group that has something to distinguish.
    expectRowsDistinguishable(groupA.map(l => l[0] ?? ''), 'coordinates radio, one group')
    expectNoConstantSlot(groupA, 'coordinates radio, one group')
  })

  it('ONE dataset: the heading is DRAWN, and it is still not repeated per option', async () => {
    // REWRITTEN (ledger #8 / #16). This asserted the heading was absent at one dataset — the
    // rejected suppression. What the file's actual rule protects is unchanged and is what is
    // asserted now: the dataset is stated ONCE, above the list, and never in the per-option
    // slot whose job is to tell two options apart. Drawing the heading and repeating it per row
    // are two different things, and only the second was ever the defect.
    mount([
      inDataset('a1b2c3d4-0000-0000-0000-000000000001', 'K_alpha', 'ds-a', 'Batch A'),
      inDataset('e5f6a7b8-0000-0000-0000-000000000002', 'K_beta', 'ds-a', 'Batch A'),
    ])
    const lines = await renderedOptionLines()
    expect(screen.getByTestId('widget-coords-group-0').textContent).toBe('Batch A')
    expectNoConstantSlot(lines, 'coordinates radio, single dataset')
    expect(lines.flat().join(' | ')).not.toContain('Batch A')
  })
})
