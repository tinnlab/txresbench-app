// The ambient artifact-description lookup a workbench `artifact` TAB reads (`panes.tsx`'s
// `artifactPaneSubject`). The twin of `modules/jobs/jobNames.test.ts`, and it asserts the same
// three properties a tab depends on, plus the one that is specific to artifacts.
//
//   · an id the cache has never been told about is UNNAMED — never "the id";
//   · the cache cannot grow without bound, and eviction takes the COLD ids;
//   · a repeat of the same page does not re-render every tab strip in the app;
//   · the label is derived at READ time, not frozen at remember time — one of its segments is a
//     RELATIVE date, so a label captured on arrival would say "just now" for the whole session.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  rememberArtifacts,
  artifactDisplayName,
  subscribeArtifactNames,
  __resetArtifactNames,
  ARTIFACT_NAME_CACHE_MAX,
} from './artifactNames'

const TABLE_STRUCTURE = {
  encoding: 'zarr_v3',
  kind: 'table',
  axis: 'entries',
  n: 5000,
  arrays: [{ path: 'coords', kind: 'numeric', shape: [5000, 2] }],
}

describe('artifactNames', () => {
  beforeEach(() => __resetArtifactNames())

  it('describes an artifact the cache has been told about, and answers null for one it has not', () => {
    rememberArtifacts([{ id: 'a1', datatype: 'table', structure: TABLE_STRUCTURE }])
    expect(artifactDisplayName('a1')).toBe('table · 5000×2')
    // The fallback contract: an unknown id yields NULL, so the caller prints its own honest
    // words instead of a uuid.
    expect(artifactDisplayName('never-seen')).toBeNull()
    expect(artifactDisplayName(undefined)).toBeNull()
    expect(artifactDisplayName('')).toBeNull()
  })

  it('derives the label at READ time, so the relative date is not frozen on arrival', () => {
    const created = '2026-07-16T12:00:00Z'
    rememberArtifacts([{ id: 'a1', datatype: 'table', created_at: created }])
    expect(artifactDisplayName('a1', Date.parse('2026-07-16T12:00:30Z'))).toBe('table · just now')
    // Same row, later clock — the label MOVED. A label captured at remember time could not.
    expect(artifactDisplayName('a1', Date.parse('2026-07-19T12:00:00Z'))).toBe('table · 3d ago')
  })

  it('notifies when a description is LEARNED and stays quiet when a fetch repeats itself', () => {
    let hits = 0
    const off = subscribeArtifactNames(() => {
      hits += 1
    })
    rememberArtifacts([{ id: 'a1', datatype: 'table', created_at: 'x' }])
    expect(hits).toBe(1)
    // A re-list returning the same page must not re-render every tab strip in the app.
    rememberArtifacts([{ id: 'a1', datatype: 'table', created_at: 'x' }])
    expect(hits).toBe(1)
    rememberArtifacts([{ id: 'a1', datatype: 'other', created_at: 'x' }])
    expect(hits).toBe(2)
    off()
    rememberArtifacts([{ id: 'a2', datatype: 'table' }])
    expect(hits, 'unsubscribe actually detaches').toBe(2)
  })

  it('is BOUNDED, and evicts the OLDEST ids rather than the ones the fetches keep re-seeing', () => {
    const hot = { id: 'hot', datatype: 'hot-type' }
    rememberArtifacts([hot])
    for (let i = 0; i < ARTIFACT_NAME_CACHE_MAX; i += 1) {
      // Re-assert `hot` on every "fetch", the way a live catalog does — it must survive.
      rememberArtifacts([{ id: `a${i}`, datatype: `t${i}` }, hot])
    }
    expect(artifactDisplayName('hot'), 'a re-seen id is refreshed to the young end').toContain('hot-type')
    expect(artifactDisplayName('a0'), 'the oldest cold id is evicted').toBeNull()
    expect(artifactDisplayName(`a${ARTIFACT_NAME_CACHE_MAX - 1}`)).toContain(
      `t${ARTIFACT_NAME_CACHE_MAX - 1}`,
    )
  })

  it('ignores rows that carry no usable id, and a batch that is not there at all', () => {
    rememberArtifacts(null)
    rememberArtifacts(undefined)
    rememberArtifacts([
      { id: '', datatype: 'blank' },
      undefined as unknown as { id: string },
      { id: 'ok', datatype: 'fine' },
    ])
    expect(artifactDisplayName('')).toBeNull()
    expect(artifactDisplayName('ok')).toContain('fine')
  })
})
