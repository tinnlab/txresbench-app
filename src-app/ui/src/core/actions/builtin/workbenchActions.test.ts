import { describe, it, expect } from 'vitest'
import { Permissions } from '@/api-client/permissions'
import { getActionMeta, getActionRegistry, runAction } from '../defineAction'
// Side-effect import registers the workbench/analysis/dataset actions.
import '../builtin/workbenchActions'

// TEST-110 (PLAN.md ITEM-6) — importing the builtin registers `analysis.launch`
// (`context:'workbench'`, instance, required `view_id`), `dataset.process`
// (`context:'dataset'`, instance), and `pane.*` (`context:'workbench'`,
// instance), each declaring an EXISTING permission + a thin, guarded
// store-delegating `run` (NO new permission string).

const KNOWN_PERMISSIONS = new Set<string>(Object.values(Permissions))

describe('workbenchActions (ITEM-6)', () => {
  it('registers analysis.launch as a workbench-context instance action with a required view_id', () => {
    const meta = getActionMeta('analysis.launch')
    expect(meta).toBeDefined()
    expect(meta?.kind).toBe('instance')
    expect(meta?.context).toBe('workbench')
    // A READ, not a write — it opens the analysis' form and enqueues nothing (its own doc says
    // so; Run inside the form is the mutation). It used to be declared `mutating: true` +
    // `JobsUse`, and that contradiction was load-bearing: the launcher refused a viewer's row on
    // the strength of it, standing in front of the panel's own "viewers cannot RUN analyses"
    // branch. Gated by the pane's OWN read perm, which is the rule this file already states for
    // `workbench.open*` — and `ProjectsUse` is the very perm `workbench.openAnalyses` uses to
    // open the CATALOG these forms belong to.
    expect(meta?.mutating).toBe(false)
    expect(meta?.permission).toBe(getActionMeta('workbench.openAnalyses')?.permission)
    // NEGATIVE CONTROL: the sibling that really does enqueue is still a write, so this is not a
    // blanket relaxation of the workbench action vocabulary.
    expect(getActionMeta('dataset.process')?.mutating).toBe(true)
    // view_id must be a required param (the instance target).
    expect(getActionRegistry().get('analysis.launch')?.params.safeParse({ analysis_id: 'a' }).success).toBe(false)
    expect(
      getActionRegistry().get('analysis.launch')?.params.safeParse({ view_id: 'v', analysis_id: 'a' }).success,
    ).toBe(true)
  })

  it('registers dataset.process as a dataset-context instance action', () => {
    const meta = getActionMeta('dataset.process')
    expect(meta?.kind).toBe('instance')
    expect(meta?.context).toBe('dataset')
    expect(meta?.mutating).toBe(true)
    expect(getActionRegistry().get('dataset.process')?.params.safeParse({ spec: {} }).success).toBe(false)
  })

  it('registers pane.split / pane.popOut / pane.close / pane.return as workbench-context instance actions', () => {
    for (const id of ['pane.split', 'pane.popOut', 'pane.close', 'pane.return']) {
      const meta = getActionMeta(id)
      expect(meta, id).toBeDefined()
      expect(meta?.kind, id).toBe('instance')
      expect(meta?.context, id).toBe('workbench')
    }
  })

  it('registers workbench.openJobs / workbench.openReproducibility as read-only workbench-context instance actions (DRIFT-4.5)', () => {
    const jobs = getActionMeta('workbench.openJobs')
    const repro = getActionMeta('workbench.openReproducibility')
    expect(jobs?.kind).toBe('instance')
    expect(jobs?.context).toBe('workbench')
    expect(jobs?.mutating).toBe(false)
    expect(jobs?.permission).toBe(Permissions.JobsUse)
    expect(repro?.mutating).toBe(false)
    expect(repro?.permission).toBe(Permissions.ProvenanceRead)
    // view_id is the required instance target.
    expect(getActionRegistry().get('workbench.openJobs')?.params.safeParse({}).success).toBe(false)
    expect(getActionRegistry().get('workbench.openJobs')?.params.safeParse({ view_id: 'v' }).success).toBe(true)
  })

  it('every workbench action names an EXISTING permission (no new permission string)', () => {
    for (const id of [
      'analysis.launch',
      'dataset.process',
      'pane.split',
      'pane.popOut',
      'pane.close',
      'pane.return',
      'workbench.openJobs',
      'workbench.openReproducibility',
    ]) {
      const perm = getActionMeta(id)?.permission
      expect(perm, id).toBeDefined()
      expect(KNOWN_PERMISSIONS.has(perm as string), `${id} → ${perm}`).toBe(true)
    }
  })

  it('a thin store-delegating run returns a clean "not available" result (never throws) when its instance is not mounted', async () => {
    // No live `'workbench'` instance is registered in this unit test, so an
    // invoke resolves to the guarded degrade path — it RETURNS a structured
    // unavailable result rather than throwing (INFRA cross-round seam).
    const result = (await runAction('analysis.launch', {
      view_id: 'nonexistent',
      analysis_id: 'demo',
    })) as { ok?: boolean; unavailable?: boolean }
    expect(result.ok).toBe(false)
    expect(result.unavailable).toBe(true)

    const paneResult = (await runAction('pane.split', {
      view_id: 'nonexistent',
      pane_id: 'p1',
    })) as { unavailable?: boolean }
    expect(paneResult.unavailable).toBe(true)
  })
})
