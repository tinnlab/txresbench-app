import { describe, expect, it } from 'vitest'
import type { AnalysisContribution } from '@/modules/workbench/core'
import type { Job } from '@/api-client/types'
import { resolveJobAnalysisId } from './JobFlowGuidance'

// ITEM-37 — the job→analysis resolution (best-effort, since `Job` has no analysis column): prefer
// `job.params.analysis_id` (the launch stamped it), else fall back to the job NAME == analysis title.
//
// THE KEY IS SPELLED THE WAY THE WIRE SPELLS IT. This file used to build its stamped fixture as
// `params: { analysisId: … }` — a key nothing has ever written — so it asserted the resolver
// against the resolver's own misspelling and stayed green for the whole time the stamped branch
// was dead in production. The fixture below is the bag the launcher actually serializes
// (`jobsCapability.ts` → `analysis_id`, parsed by the server as `AnalysisSpec::analysis_id`), and
// the camelCase spelling now has its own NEGATIVE control so the mistake cannot come back green.

function analysis(id: string, title: string): AnalysisContribution {
  return {
    id,
    title,
    extensionId: 'test',
    apiVersion: '^1.0',
    category: 'qc',
    appliesTo: [],
    produces: [],
    run: { kind: 'builtin', fn: 'noop' },
  } as AnalysisContribution
}

function job(over: Partial<Job>): Job {
  return {
    id: 'j1',
    name: '',
    job_type: 'analysis',
    owner_id: 'u1',
    created_at: '2026-01-01',
    status: 'completed',
    priority_class: 'interactive',
    resource_class: 'cpu-sandbox',
    ...over,
  } as Job
}

const analyses = [analysis('qc.10x', 'Compute QC metrics'), analysis('rows.filter', 'Row filter')]

describe('resolveJobAnalysisId (ITEM-37)', () => {
  it('prefers the stamped params.analysis_id when it matches a registered analysis', () => {
    // `name` is deliberately NOT a registered title: the title fallback cannot supply this answer,
    // so the assertion can only pass through the stamped-id branch.
    expect(resolveJobAnalysisId(job({ params: { analysis_id: 'rows.filter' }, name: 'anything' }), analyses)).toBe('rows.filter')
  })

  it('reads the WIRE spelling — a camelCase `analysisId` is not the stamped id', () => {
    // The negative control for the defect this file used to certify. `analysisId` is a key no
    // launcher writes; honouring it would let the resolver agree with a fixture instead of with
    // the server.
    expect(
      resolveJobAnalysisId(job({ params: { analysisId: 'rows.filter' }, name: 'anything' }), analyses),
    ).toBeUndefined()
  })

  it('falls back to the job NAME == analysis title', () => {
    expect(resolveJobAnalysisId(job({ name: 'Compute QC metrics' }), analyses)).toBe('qc.10x')
  })

  it('returns undefined when nothing resolves (no fabricated guidance)', () => {
    expect(resolveJobAnalysisId(job({ name: 'Unknown job', params: { analysis_id: 'nope' } }), analyses)).toBeUndefined()
  })
})
