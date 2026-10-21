// The summary → line composer, and the property that matters most: the line is made
// of CONTRIBUTED phrases. The app sorts and joins; it does not lead with its own
// storage vocabulary, it does not print a byte size, and an uncontributed datatype
// still says something true.
//
// Every fixture id and key here is neutral (`probe/*`, `extents`). That is the point of
// the seam under test: the composer must work purely off what it is handed, so a
// fixture naming a real datatype or a real producer key would be asserting something
// this code is not allowed to know.

import { describe, expect, it } from 'vitest'
import type { DatasetArtifactGroup, DatasetArtifactSummary } from '@/api-client/types'
import { formatBytes } from '@/modules/datasets/lib/format'
import { DatasetPreviewRegistry } from './registry'
import {
  describePart,
  describeSummary,
  EMPTY_SUMMARY_TEXT,
  fallbackPartText,
  holdingsFor,
  remainderText,
  type SummaryDeps,
} from './summary'

const TITLES: Record<string, string> = {
  'probe/matrix': 'Probe matrix',
  'probe/column': 'Probe column',
  'probe/other': 'Probe other',
}

const deps = (registry = new DatasetPreviewRegistry()): SummaryDeps => ({
  lattice: { ancestors: () => [] },
  title: id => TITLES[id] ?? id,
  registry,
})

const group = (
  datatype: string,
  count: number,
  decl: { meta?: Record<string, unknown>; structure?: Record<string, unknown> } = {},
): DatasetArtifactGroup => ({
  datatype,
  count,
  logical_bytes: 1024,
  representative_output_id: 'primary',
  representative_meta: decl.meta ?? {},
  representative_structure: decl.structure ?? {},
})

const TOTAL_BYTES = 41_233_920
const summary = (groups: DatasetArtifactGroup[], count?: number): DatasetArtifactSummary => ({
  dataset_id: 'd1',
  artifact_count: count ?? groups.reduce((n, g) => n + g.count, 0),
  total_logical_bytes: TOTAL_BYTES,
  groups,
})

/** A contribution that states BOTH extents of the representative's declared
 *  dimension list — the shape of thing a real package contributes, in neutral words. */
const dimensions = (order = 10) => ({
  datatype: 'probe/matrix',
  order,
  phrase: (g: DatasetArtifactGroup) => {
    const extents = (g.representative_structure as { extents?: number[] } | undefined)?.extents
    return extents?.length === 2
      ? `${extents[0].toLocaleString()} rows x ${extents[1].toLocaleString()} spans`
      : null
  },
})

/** A contribution whose whole phrase is the group's count. */
const counted = (datatype: string, order: number, word: string) => ({
  datatype,
  order,
  phrase: (g: DatasetArtifactGroup) => `${g.count} ${word}${g.count === 1 ? '' : 's'}`,
})

describe('describePart — what the composer hands a contribution', () => {
  it("supplies the group's own datatype title, resolved through the injected resolver", () => {
    // The word a contribution can put in its sentence and the word the fallback is
    // built from are the SAME word, from the SAME resolver — that is what stops a
    // contributed line and a fallback line disagreeing about what a thing is called.
    const seen: string[] = []
    const registry = new DatasetPreviewRegistry()
    registry.register({
      datatype: 'probe/matrix',
      order: 1,
      phrase: (g: DatasetArtifactGroup, title: string) => {
        seen.push(title)
        return `${title} / ${g.count}`
      },
    })
    const part = describePart(group('probe/matrix', 3), deps(registry))
    expect(seen).toEqual([TITLES['probe/matrix']])
    expect(part.text).toBe(`${TITLES['probe/matrix']} / 3`)
    // …and an unregistered id falls back to the raw id through the same resolver.
    const unknown = describePart(group('probe/unheard-of', 2), deps(registry))
    expect(unknown.text).toBe('2 probe/unheard-of')
  })
})

describe("fallbackPartText — the app's entire vocabulary", () => {
  it("is a count and the datatype's CONTRIBUTED title, verbatim", () => {
    expect(fallbackPartText(group('probe/matrix', 1), 'Probe matrix')).toBe('1 Probe matrix')
    // A title is another package's word: the app may not pluralize it.
    expect(fallbackPartText(group('probe/column', 63), 'Probe column')).toBe('63 Probe column')
  })

  it('carries NO storage noun of its own', () => {
    expect(fallbackPartText(group('probe/matrix', 4), 'Probe matrix')).not.toContain('artifact')
  })
})

describe("the line is the CONTRIBUTION's sentence", () => {
  const registry = () => {
    const r = new DatasetPreviewRegistry()
    r.register(dimensions())
    r.register(counted('probe/column', 20, 'probe column'))
    return r
  }

  it('carries no app storage noun and no byte size — only what packages said', () => {
    // THE DEFECT THIS GUARDS. The line used to open "65 artifacts · 41.5 MB · …":
    // the app's own table noun and a size nobody chooses a dataset by, in front of
    // everything a package had to say.
    const d = describeSummary(
      summary([
        group('probe/column', 63),
        group('probe/matrix', 1, { structure: { extents: [3460, 32738] } }),
      ]),
      deps(registry()),
    )
    expect(d?.line).toBe('3,460 rows x 32,738 spans · 63 probe columns')
    expect(d?.line).not.toContain('artifact')
    expect(d?.line).not.toContain(formatBytes(TOTAL_BYTES))
    expect(d?.line).not.toContain('MB')
    // …and the artifact TOTAL is not smuggled back in under another spelling.
    expect(d?.line).not.toContain('64')
  })

  it('sorts by the order the CONTRIBUTIONS declared, not by how numerous a group is', () => {
    // The server orders groups most-numerous first, which buries the headline fact:
    // 63 columns arrive before the single matrix. A line that simply followed the
    // server would read the other way round, so this is the assertion that the
    // package's `order` is what decides.
    const groups = [
      group('probe/column', 63),
      group('probe/matrix', 1, { structure: { extents: [3460, 32738] } }),
    ]
    expect(describeSummary(summary(groups), deps(registry()))?.parts.map(p => p.datatype)).toEqual([
      'probe/matrix',
      'probe/column',
    ])
    // The inverse declaration produces the inverse line — so the ordering is really
    // read from the contribution and not from a rule that happens to agree with it.
    const flipped = new DatasetPreviewRegistry()
    flipped.register(dimensions(99))
    flipped.register(counted('probe/column', 1, 'probe column'))
    expect(describeSummary(summary(groups), deps(flipped))?.parts.map(p => p.datatype)).toEqual([
      'probe/column',
      'probe/matrix',
    ])
  })

  it('puts the size in the HOVER, where a reader who wants it can still find it', () => {
    const d = describeSummary(
      summary([group('probe/matrix', 1, { structure: { extents: [3460, 32738] } })]),
      deps(registry()),
    )
    expect(d?.detail).toContain(formatBytes(TOTAL_BYTES))
    expect(d?.detail.startsWith(d?.line ?? '')).toBe(true)
  })

  it('is null for a summary that has not loaded — the caller renders no line', () => {
    expect(describeSummary(null, deps())).toBeNull()
    expect(describeSummary(undefined, deps())).toBeNull()
  })
})

describe('a contribution that cannot speak', () => {
  const registry = () => {
    const r = new DatasetPreviewRegistry()
    r.register(dimensions())
    return r
  }

  it('DEGRADES to the count-and-title fallback, never to a hole', () => {
    // The declaration the phrase reads is simply not there — the case a dataset
    // imported by a different path really produces.
    const d = describeSummary(summary([group('probe/matrix', 3)]), deps(registry()))
    expect(d?.line).toBe('3 Probe matrix')
    expect(d?.line).not.toContain('undefined')
    expect(d?.line).not.toContain('NaN')
    expect(d?.parts[0].contributed).toBe(false)
  })

  it('KEEPS its declared position, so one missing declaration does not re-order the line', () => {
    const r = registry()
    r.register(counted('probe/column', 20, 'probe column'))
    const d = describeSummary(
      summary([group('probe/column', 63), group('probe/matrix', 1)]),
      deps(r),
    )
    expect(d?.parts.map(p => p.datatype)).toEqual(['probe/matrix', 'probe/column'])
    expect(d?.line).toBe('1 Probe matrix · 63 probe columns')
  })
})

describe('NEGATIVE CONTROL — an UNCONTRIBUTED datatype', () => {
  it('renders the fallback and none of a contributed phrase, on identical declarations', () => {
    const r = new DatasetPreviewRegistry()
    r.register(dimensions())
    // Same producer declaration, DIFFERENT datatype, no contribution for it. A
    // "contribution" that were really a hardcoded read of `extents` would light up here.
    const decl = { structure: { extents: [3460, 32738] } }
    const d = describeSummary(summary([group('probe/other', 2, decl)]), deps(r))
    expect(d?.line).toBe('2 Probe other')
    expect(d?.line).not.toContain('3,460')
    expect(d?.line).not.toContain('rows')
    expect(d?.parts[0].contributed).toBe(false)

    // The positive control, side by side, so the assertion above is not passing
    // because the whole mechanism is inert.
    const contributed = describeSummary(summary([group('probe/matrix', 2, decl)]), deps(r))
    expect(contributed?.line).toBe('3,460 rows x 32,738 spans')
    expect(contributed?.parts[0].contributed).toBe(true)
  })

  it('trails every contributed phrase, whatever the server order was', () => {
    const r = new DatasetPreviewRegistry()
    r.register(counted('probe/column', 20, 'probe column'))
    // `probe/other` arrives FIRST from the server (most numerous) and has no
    // contribution, so it must still fall behind the declared phrase.
    const d = describeSummary(summary([group('probe/other', 99), group('probe/column', 3)]), deps(r))
    expect(d?.parts.map(p => p.datatype)).toEqual(['probe/column', 'probe/other'])
  })
})

describe('remainderText — what the groups past the server cap add up to', () => {
  it('says nothing when every counted artifact is in a shown group', () => {
    expect(remainderText(0)).toBeNull()
    expect(remainderText(-1)).toBeNull()
  })

  it('states the remainder when the group list was capped', () => {
    // Without this the capped case under-reports SILENTLY: the app used to carry a
    // total at the head of the line, which covered it by accident.
    const d = describeSummary(summary([group('probe/column', 3)], 10), deps())
    expect(d?.line).toBe('3 Probe column · +7 more')
  })
})

describe('describePart', () => {
  it('reports which side supplied the text', () => {
    const r = new DatasetPreviewRegistry()
    r.register(dimensions())
    const withPhrase = describePart(
      group('probe/matrix', 1, { structure: { extents: [4, 5] } }),
      deps(r),
    )
    expect(withPhrase).toEqual({
      datatype: 'probe/matrix',
      // Carried out of the resolution, not re-derived by the caller: a surface that
      // renders the title BESIDE the phrase (the artifacts pane heads each type section
      // with it) would otherwise read `deps.title` a second time.
      title: 'Probe matrix',
      text: '4 rows x 5 spans',
      contributed: true,
      order: 10,
    })
    expect(describePart(group('probe/other', 2), deps(r)).order).toBe(Number.POSITIVE_INFINITY)
  })

  it('carries the SAME title the phrase was rendered against', () => {
    const r = new DatasetPreviewRegistry()
    r.register(dimensions())
    const part = describePart(group('probe/matrix', 1, { structure: { extents: [4, 5] } }), deps(r))
    // One resolution, two consumers. A second `deps.title` read is exactly how a heading
    // and the sentence under it drift apart.
    expect(part.title).toBe(deps(r).title('probe/matrix'))
  })

  it('shows the raw id when the registry has never heard of the datatype', () => {
    expect(describePart(group('probe/unknown', 4), deps()).text).toBe('4 probe/unknown')
  })
})

describe('holdingsFor — the three states of "what does this dataset hold"', () => {
  const S: DatasetArtifactSummary = {
    dataset_id: 'has-some',
    artifact_count: 2,
    total_logical_bytes: 1024,
    groups: [group('probe/matrix', 2)],
  }
  const EMPTY: DatasetArtifactSummary = {
    dataset_id: 'has-none',
    artifact_count: 0,
    total_logical_bytes: 0,
    groups: [],
  }
  const map = new Map([
    [S.dataset_id, S],
    [EMPTY.dataset_id, EMPTY],
  ])

  it('says nothing while the read has not landed', () => {
    expect(holdingsFor(null, 'has-some', deps())).toBeNull()
  })

  it('says nothing for a dataset the read never covered', () => {
    // THE BUG THIS GUARDS. The read is capped, so a candidate can be outside it. If
    // absence resolved to the empty sentence, every uncovered dataset would be
    // labelled empty — a confident claim about something nobody counted.
    expect(holdingsFor(map, 'never-counted', deps())).toBeNull()
  })

  it('says the empty sentence ONLY for a dataset the read counted as zero', () => {
    expect(holdingsFor(map, 'has-none', deps())?.text).toBe(EMPTY_SUMMARY_TEXT)
  })

  it("states emptiness without the app's storage noun", () => {
    // "No artifacts yet" named a row in this app's own table. It told a reader
    // nothing about whether there was anything here to work with.
    expect(EMPTY_SUMMARY_TEXT).not.toContain('artifact')
    expect(EMPTY_SUMMARY_TEXT.trim().length).toBeGreaterThan(0)
  })

  it('says the full line for a dataset that holds something', () => {
    const h = holdingsFor(map, 'has-some', deps())
    expect(h?.text).toBe('2 Probe matrix')
    expect(h?.text).not.toBe(EMPTY_SUMMARY_TEXT)
  })
})
