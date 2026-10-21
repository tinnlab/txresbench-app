// TEST-7 (ITEM-6) — each NON-analysis descriptor type registers into its own registry
// with its discriminating fields.
//
// The set has shrunk twice. ITEM-9 deleted `selectionActions` with the selection feature;
// ITEM-33/34/35 deleted the five ZERO-CONTRIBUTOR descriptor types
// (`plotTypes` / `fieldProviders` / `resultRenderers` / `commands` / `collections`) whose
// only registrations in the whole repo were the ones this test used to make. Two remain.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workbenchRegistry, resetWorkbenchRegistry } from './workbenchRegistry.ts'

test('TEST-7: the two non-analysis descriptor types register with their discriminating fields', () => {
  resetWorkbenchRegistry()
  const base = { extensionId: 'ext', apiVersion: '^1.0' }

  workbenchRegistry.views.register({ ...base, id: 'qc', title: 'QC', area: 'bottom', render: { component: 'QcPanel' } })
  workbenchRegistry.statusBarItems.register({
    ...base,
    id: 'jobs',
    title: 'Jobs',
    side: 'end',
    render: () => null,
  })

  assert.equal(workbenchRegistry.views.get('qc')?.area, 'bottom')
  // the status-bar descriptor's discriminating fields are its cluster + its zero-prop component.
  assert.equal(workbenchRegistry.statusBarItems.get('jobs')?.side, 'end')
  assert.equal(typeof workbenchRegistry.statusBarItems.get('jobs')?.render, 'function')
  resetWorkbenchRegistry()
})
