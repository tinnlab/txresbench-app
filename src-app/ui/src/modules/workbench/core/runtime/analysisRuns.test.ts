import { describe, it, expect } from 'vitest'
import type { Job } from '@/api-client/types'
import type { AnalysisContribution } from '@/modules/workbench/core'
import { runsOfAnalysis, isRunning, ANALYSIS_RUNS_LIMIT } from './analysisRuns'

// The per-analysis run list answers two questions with one list: "did my click work?" (the
// in-flight run) and "what happened last time?" (the most recent finished one). Its ordering and
// its bound are therefore behaviour, not presentation.

const analyses = [
  { id: 'a.one', title: 'First analysis' },
  { id: 'a.two', title: 'Second analysis' },
] as unknown as AnalysisContribution[]

const job = (over: Partial<Job> & { id: string }): Job =>
  ({
    name: 'First analysis',
    status: 'completed',
    created_at: '2026-01-01T00:00:00Z',
    params: { analysis_id: 'a.one' },
    ...over,
  }) as unknown as Job

describe('a run list is scoped to ONE analysis', () => {
  it('keeps only that analysis’ runs', () => {
    const mine = job({ id: 'j1' })
    const theirs = job({ id: 'j2', name: 'Second analysis', params: { analysis_id: 'a.two' } })
    expect(runsOfAnalysis([mine, theirs], 'a.one', analyses).map(j => j.id)).toEqual(['j1'])
  })

  it('attributes by the STAMPED id, not only by a matching name', () => {
    // Every case in this file used to carry a job whose NAME was also its analysis' title, so the
    // whole suite passed on the title fallback alone and the stamped-id branch — which read a key
    // (`analysisId`) nothing writes — was never exercised. Here the names are useless: `mine` is
    // named after the OTHER analysis and `theirs` after nothing at all, so only the wire key
    // `params.analysis_id` can produce this answer.
    const mine = job({ id: 'j1', name: 'Second analysis', params: { analysis_id: 'a.one' } })
    const theirs = job({ id: 'j2', name: 'not a title', params: { analysis_id: 'a.two' } })
    expect(runsOfAnalysis([mine, theirs], 'a.one', analyses).map(j => j.id)).toEqual(['j1'])
  })

  it('falls back to the job NAME when the launch stamped no id', () => {
    // The shared best-effort resolution — a `Job` carries no analysis column. Reused rather than
    // re-derived so this list and a run's own guidance cannot disagree about the same row.
    const unstamped = job({ id: 'j3', params: null as never })
    expect(runsOfAnalysis([unstamped], 'a.one', analyses).map(j => j.id)).toEqual(['j3'])
  })

  it('claims nothing it cannot attribute', () => {
    // A run that matches neither id nor title belongs to no analysis here. Guessing would put a
    // stranger's run under someone's form.
    const foreign = job({ id: 'j4', name: 'Something else', params: null as never })
    expect(runsOfAnalysis([foreign], 'a.one', analyses)).toEqual([])
  })
})

describe('ordering answers the question the user is asking', () => {
  it('puts IN-FLIGHT runs first, whatever their timestamps', () => {
    const finishedRecent = job({ id: 'done', status: 'completed', created_at: '2026-01-03T00:00:00Z' })
    const queuedOld = job({ id: 'queued', status: 'queued', created_at: '2026-01-01T00:00:00Z' })
    expect(runsOfAnalysis([finishedRecent, queuedOld], 'a.one', analyses).map(j => j.id)).toEqual([
      'queued',
      'done',
    ])
  })

  it('orders the rest newest-first', () => {
    const older = job({ id: 'older', created_at: '2026-01-01T00:00:00Z' })
    const newer = job({ id: 'newer', created_at: '2026-01-05T00:00:00Z' })
    expect(runsOfAnalysis([older, newer], 'a.one', analyses).map(j => j.id)).toEqual(['newer', 'older'])
  })

  it('shows TERMINAL runs too — not only in-flight ones', () => {
    // Only-in-flight would leave the panel empty most of the time, answering "did my click work?"
    // exactly during the window the user is least likely to be looking (DEC-5).
    expect(runsOfAnalysis([job({ id: 'done' })], 'a.one', analyses).map(j => j.id)).toEqual(['done'])
  })

  it('is BOUNDED — an unbounded list buries the row the user came for', () => {
    const many = Array.from({ length: ANALYSIS_RUNS_LIMIT + 4 }, (_, i) =>
      job({ id: `j${i}`, created_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }),
    )
    expect(runsOfAnalysis(many, 'a.one', analyses)).toHaveLength(ANALYSIS_RUNS_LIMIT)
  })
})

describe('isRunning names the states that have no outcome yet', () => {
  it('queued and running are in flight; terminal states are not', () => {
    expect(isRunning('queued')).toBe(true)
    expect(isRunning('running')).toBe(true)
    for (const s of ['completed', 'failed', 'cancelled', undefined]) expect(isRunning(s)).toBe(false)
  })
})
