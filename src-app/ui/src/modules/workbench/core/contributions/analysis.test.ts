// TEST-6 (ITEM-5) — AnalysisContribution construction + registration.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Registry } from './registry.ts'
import type { AnalysisContribution } from './types.ts'

interface LeidenParams {
  resolution: number
}

test('TEST-6: an AnalysisContribution constructs, registers, and renders methodsText', () => {
  const r = new Registry<AnalysisContribution>('analyses')
  const leiden: AnalysisContribution<LeidenParams> = {
    id: 'clustering.leiden',
    extensionId: 'clustering',
    apiVersion: '^1.0',
    title: 'Leiden clustering',
    category: 'clustering',
    appliesTo: [{ subtypes_of: 'embedding', required: true }],
    produces: ['clustering'],
    run: { kind: 'sandbox', runtime: 'python', entry: 'leiden.py' },
    schedule: { class: 'interactive', resources: { cpu: 2, mem: '4Gi' } },
    methodsText: p => `Leiden clustering at resolution ${p.resolution}.`,
  }
  r.register(leiden as unknown as AnalysisContribution)
  const got = r.get('clustering.leiden') as unknown as AnalysisContribution<LeidenParams>
  assert.deepEqual(got.produces, ['clustering'])
  assert.equal(got.run.kind, 'sandbox')
  assert.equal(got.methodsText?.({ resolution: 1.2 }), 'Leiden clustering at resolution 1.2.')
})
