import { describe, it, expect, beforeEach } from 'vitest'
import {
  rememberJobNames,
  jobDisplayName,
  subscribeJobNames,
  __resetJobNames,
  JOB_NAME_CACHE_MAX,
} from './jobNames'

// The ambient job-name lookup a workbench TAB reads (`paneModel`'s `jobs`/`rerun` subject
// resolvers). Everything here is about the two properties a tab depends on: an id the cache has
// never been told about is UNNAMED (never "the id"), and the cache cannot grow without bound.
describe('jobNames', () => {
  beforeEach(() => __resetJobNames())

  it('names a job the cache has been told about, and answers null for one it has not', () => {
    rememberJobNames([{ id: 'j1', name: 'Nightly run', job_type: 'demo.filter' }])
    expect(jobDisplayName('j1')).toBe('Nightly run')
    // The whole point of the fallback contract: an unknown id yields NULL, so the caller prints
    // its own honest words instead of a uuid.
    expect(jobDisplayName('never-seen')).toBeNull()
    expect(jobDisplayName(undefined)).toBeNull()
  })

  it('falls back to the job TYPE when the name is blank — the same two-step the toast uses', () => {
    rememberJobNames([
      { id: 'blank', name: '   ', job_type: 'stub' },
      { id: 'missing', job_type: 'stub' },
      { id: 'nameless', name: null, job_type: null },
    ])
    expect(jobDisplayName('blank')).toBe('stub')
    expect(jobDisplayName('missing')).toBe('stub')
    // Neither ⇒ unnameable, and it says so rather than caching an empty string.
    expect(jobDisplayName('nameless')).toBeNull()
  })

  it('notifies subscribers when a name is LEARNED and stays quiet when a poll repeats itself', () => {
    let hits = 0
    const off = subscribeJobNames(() => {
      hits += 1
    })
    rememberJobNames([{ id: 'j1', name: 'one' }])
    expect(hits).toBe(1)
    // A 3 s poll returning the same page must not re-render every tab strip in the app.
    rememberJobNames([{ id: 'j1', name: 'one' }])
    expect(hits).toBe(1)
    rememberJobNames([{ id: 'j1', name: 'renamed' }])
    expect(hits).toBe(2)
    off()
    rememberJobNames([{ id: 'j2', name: 'two' }])
    expect(hits, 'unsubscribe actually detaches').toBe(2)
  })

  it('is BOUNDED, and evicts the OLDEST ids rather than the ones the polls keep re-seeing', () => {
    const hot = { id: 'hot', name: 'hot job' }
    rememberJobNames([hot])
    for (let i = 0; i < JOB_NAME_CACHE_MAX; i += 1) {
      // Re-assert `hot` on every "poll", the way a live list does — it must survive.
      rememberJobNames([{ id: `j${i}`, name: `job ${i}` }, hot])
    }
    expect(jobDisplayName('hot'), 'a re-seen id is refreshed to the young end').toBe('hot job')
    expect(jobDisplayName('j0'), 'the oldest cold id is evicted').toBeNull()
    expect(jobDisplayName(`j${JOB_NAME_CACHE_MAX - 1}`)).toBe(`job ${JOB_NAME_CACHE_MAX - 1}`)
  })

  it('ignores rows that carry no usable id', () => {
    rememberJobNames([
      { id: '', name: 'blank id' },
      undefined as unknown as { id: string },
      { id: 'ok', name: 'fine' },
    ])
    expect(jobDisplayName('')).toBeNull()
    expect(jobDisplayName('ok')).toBe('fine')
  })
})
