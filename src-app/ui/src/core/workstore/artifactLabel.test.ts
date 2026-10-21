// The ONE artifact label — asserted as the CONVERGENCE it is, not just as a formatter.
//
// Two rival implementations answered "what is this artifact called": the lineage DAG's
// `datatype · id8` and the picker's `datatype · dims · when`. The tests that matter here are the
// ones a single formatter makes possible:
//
//   1. the DAG's text is UNCHANGED by the convergence — the segment that survives when a caller
//      supplies neither a structure nor a timestamp IS the short id, which is exactly what that
//      caller supplied before;
//   2. the picker's richer label is unchanged wherever the row gave it something to say;
//   3. the two callers cannot drift, because there is nothing left to drift.

import { describe, it, expect } from 'vitest'
import { artifactLabel, artifactLabelSegments, shortArtifactId, UNTYPED_ARTIFACT_LABEL } from './artifactLabel'

const NOW = Date.parse('2026-07-19T12:00:00Z')
const ID = '00000000-0000-4000-8000-0000000000e2'
/** A single-member `(n × dims)` table — what a 2-D layout artifact declares. */
const TABLE_STRUCTURE = {
  encoding: 'zarr_v3',
  kind: 'table',
  axis: 'entries',
  n: 5000,
  arrays: [{ path: 'coords', kind: 'numeric', shape: [5000, 2] }],
}

describe('artifactLabel', () => {
  it('builds `datatype · dimensions · when` when the row carries all three', () => {
    expect(
      artifactLabel({ id: ID, datatype: 'table', structure: TABLE_STRUCTURE, created_at: '2026-07-16T12:00:00Z' }, NOW),
    ).toBe('table · 5000×2 · 3d ago')
  })

  it('drops each enriching segment independently', () => {
    const opaque = { encoding: 'opaque', media_type: 'application/json' }
    expect(artifactLabel({ id: ID, datatype: 'table', structure: opaque, created_at: '2026-07-16T12:00:00Z' }, NOW)).toBe(
      'table · 3d ago',
    )
    expect(artifactLabel({ id: ID, datatype: 'table', structure: TABLE_STRUCTURE, created_at: 'bogus' }, NOW)).toBe(
      'table · 5000×2',
    )
  })

  // THE CONVERGENCE ASSERTION. A provenance node carries an id and a datatype and nothing else,
  // so it lands on the last-resort segment — which is byte-for-byte the `datatype · id8` the DAG
  // spelled for itself. If this ever stops holding, the DAG's nodes silently lose the only thing
  // telling two artifacts of one datatype apart.
  it('falls back to the short id when NOTHING else distinguishes the row', () => {
    expect(artifactLabel({ id: ID, datatype: 'table' })).toBe(`table · ${shortArtifactId(ID)}`)
    expect(shortArtifactId(ID)).toBe('00000000')
    expect(shortArtifactId('abc'), 'an id shorter than the prefix is used whole').toBe('abc')
  })

  it('names an artifact with no datatype rather than rendering a blank', () => {
    expect(artifactLabel({ id: ID })).toBe(`${UNTYPED_ARTIFACT_LABEL} · 00000000`)
    expect(artifactLabel({ id: ID, datatype: '   ' })).toBe(`${UNTYPED_ARTIFACT_LABEL} · 00000000`)
  })

  it('does NOT append the id once anything else distinguishes the row', () => {
    // The negative control for the clause above: an "always append the id" rule would pass every
    // fallback assertion here while putting a machine id on every label in the app.
    const label = artifactLabel({ id: ID, datatype: 'table', structure: TABLE_STRUCTURE }, NOW)
    expect(label).toBe('table · 5000×2')
    expect(label).not.toContain('00000000')
  })

  it('exposes its SEGMENTS, so a caller composing them differently uses the same ones', () => {
    expect(
      artifactLabelSegments({ id: ID, datatype: 'table', structure: TABLE_STRUCTURE, created_at: '2026-07-16T12:00:00Z' }, NOW),
    ).toEqual(['table', '5000×2', '3d ago'])
  })
})
