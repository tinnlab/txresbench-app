/**
 * TEST-RUN-02 — the PROV-UI-RUN-1 path builders (`routes.ts` + the barrel
 * re-export; ITEM-1).
 *
 * The F path keeps the `/analysis/:runId/` prefix `txrresults` uses (so the
 * running screen and the results screens of one run read as one family),
 * with `running` as its own terminal segment; `compare` and `methods` are
 * txrresults' RESERVED path words (route segments there, never method ids)
 * and never appear as fixed segments of this route tree. The E path is the
 * convention `ui-intake` already declared (`ROUTE_CONVENTIONS.methods`) and
 * this module registers it — the provider constant is the binding, never a
 * copied literal.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AppModule } from '@ziee/framework/module-system/types'
import { ROUTE_CONVENTIONS } from '../txrintake/module'
import txrRunModule from './module'
import { chooseMethodsPath, runningPath } from './index'

type RouteEntry = { path?: string }

function routesOf(module: unknown): RouteEntry[] {
  return (module as AppModule & { routes?: RouteEntry[] }).routes ?? []
}

describe('PROV-UI-RUN-1 — the path builders (TEST-RUN-02)', () => {
  it('builds the two documented paths', () => {
    expect(chooseMethodsPath()).toBe('/choose-methods')
    expect(runningPath('run-1')).toBe('/analysis/run-1/running')
    expect(runningPath('a1b2c3d4-5678-9abc-def0-123456789abc')).toBe(
      '/analysis/a1b2c3d4-5678-9abc-def0-123456789abc/running',
    )
  })

  it('matches the module route table and the declared conventions exactly', () => {
    // The builder outputs are the module's own route table — one source.
    const routes = routesOf(txrRunModule).map(r => r.path)
    expect(routes).toContain('/choose-methods')
    expect(routes).toContain('/analysis/:runId/running')
    expect(routes.find(p => p?.includes(':runId'))?.replace(':runId', 'run-1')).toBe(
      runningPath('run-1'),
    )
    // The E path is the convention ui-intake declared (PROV-UI-INTAKE-1).
    expect(chooseMethodsPath()).toBe(ROUTE_CONVENTIONS.methods)
  })

  it('keeps the F route inside the /analysis/:runId/ family without colliding with the txrresults reserved words', () => {
    // The F route's fixed segments are `analysis` / `<runId>` / `running`;
    // a run id is spliced into the runId slot, never as a fixed segment.
    const segments = routesOf(txrRunModule)
      .map(r => r.path ?? '')
      .find(p => p.includes(':runId'))
      ?.split('/')
    expect(segments).toEqual(['', 'analysis', ':runId', 'running'])
    expect(segments).not.toContain('compare')
    expect(segments).not.toContain('methods')
    // A run id that IS one of the reserved words still lands in the runId
    // slot, never as a fixed segment (the words remain txrresults').
    expect(runningPath('compare')).toBe('/analysis/compare/running')
    expect(runningPath('methods')).toBe('/analysis/methods/running')
  })

  it('re-exports the two builders from the module barrel', () => {
    const barrel = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
    expect(barrel).toContain("export * from './routes'")
    expect(readFileSync(fileURLToPath(new URL('./routes.ts', import.meta.url)), 'utf8')).toContain(
      '`/analysis/${runId}/running`',
    )
  })

  it('README documents the routes, the provider seams, the proposed edges and the copy source', () => {
    const readme = readFileSync(fileURLToPath(new URL('./README.md', import.meta.url)), 'utf8')
    expect(readme).toContain('/choose-methods')
    expect(readme).toContain('/analysis/:runId/running')
    expect(readme).toContain('ApiClient.Txr.createRun')
    expect(readme).toContain('ApiClient.MethodCatalogue.list')
    expect(readme).toContain('ApiClient.History.getPreferences')
    expect(readme).toContain('provider-owned')
    expect(readme).toContain('proposed edge')
    expect(readme).toContain('verbatim')
    expect(readme).toContain('design examples')
  })
})
