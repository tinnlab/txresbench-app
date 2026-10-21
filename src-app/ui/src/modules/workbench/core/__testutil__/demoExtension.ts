// The dogfood built-in registration (ITEM-22), authored against the PUBLIC API
// ONLY — it imports nothing but the workbench-api surface (no shell internal).
// This is the acceptance-proof pattern the real UI built-in (`modules/workbench/
// extensions/demo-analysis/extension.ts`) mirrors: a built-in that can be built on
// the public API means an outsider can build anything we can (§0). If this ever
// needs a shell internal, that is an API gap to close before sign-off.

import { workbenchRegistry } from '../contributions/workbenchRegistry.ts'
import { WORKBENCH_API_VERSION } from '../version.ts'
import type { AnalysisContribution, ViewContribution } from '../contributions/types.ts'

export const DEMO_EXTENSION_ID = 'cyto.demo'

/** Register the demo analysis + a result view through the public registry. */
export function registerDemoExtension(): void {
  const analysis: AnalysisContribution<{ resolution: number }> = {
    id: 'demo.leiden',
    extensionId: DEMO_EXTENSION_ID,
    apiVersion: WORKBENCH_API_VERSION,
    title: 'Demo Leiden clustering',
    category: 'clustering',
    description: 'Group cells into clusters on the embedding neighborhood graph',
    whenHint: 'the user wants to identify cell populations / clusters',
    examples: ['cluster the cells', 'find populations at high resolution'],
    safety: 'read-run',
    appliesTo: [{ subtypes_of: 'embedding', required: true }],
    produces: ['clustering'],
    run: { kind: 'sandbox', runtime: 'python', entry: 'compute/leiden.py' },
    schedule: { class: 'interactive', resources: { cpu: 2, mem: '4Gi' } },
    methodsText: p => `Leiden clustering at resolution ${p.resolution}.`,
  }

  const view: ViewContribution = {
    id: 'demo.clustering-result',
    extensionId: DEMO_EXTENSION_ID,
    apiVersion: WORKBENCH_API_VERSION,
    title: 'Clusters',
    area: 'bottom',
    when: { has: 'clustering' },
    render: { component: 'ui/ClusterResultPanel' },
  }

  workbenchRegistry.analyses.register(analysis as unknown as AnalysisContribution)
  workbenchRegistry.views.register(view)
}
