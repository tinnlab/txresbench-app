// TEST-5 (ITEM-4) — the Contribution base carries LLM-facing metadata that
// round-trips through the registry.
//
// ITEM-35 deleted this test's original subject (`CommandContribution`, whose registry had
// zero contributors). The base-metadata contract is the same for every kind, so the case
// is re-pointed at a surviving kind (`ViewContribution`) rather than deleted with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Registry } from './registry.ts'
import type { ViewContribution } from './types.ts'

test('TEST-5: LLM-facing metadata fields round-trip through the registry', () => {
  const r = new Registry<ViewContribution>('views')
  const view: ViewContribution = {
    id: 'annotate.panel',
    extensionId: 'annotation',
    apiVersion: '^1.0',
    title: 'Annotations',
    description: 'Assign a label to the current selection',
    whenHint: 'the user wants to label selected cells',
    examples: ['label these cells T-cells'],
    safety: 'mutating',
    ai: true,
    area: 'right',
    render: { component: 'ui/AnnotatePanel' },
  }
  r.register(view)
  const got = r.get('annotate.panel')
  assert.equal(got?.description, 'Assign a label to the current selection')
  assert.equal(got?.whenHint, 'the user wants to label selected cells')
  assert.deepEqual(got?.examples, ['label these cells T-cells'])
  assert.equal(got?.safety, 'mutating')
  assert.equal(got?.ai, true)
})
