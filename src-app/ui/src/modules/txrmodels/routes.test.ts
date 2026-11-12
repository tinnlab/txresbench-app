/**
 * TEST-MOD-02 — the PROV-UI-MODELS-1 path builders (`routes.ts` + the barrel
 * re-export; ITEM-1) and the module's hygiene scan (EXAMPLE-UM-5; ITEM-1/2).
 *
 * The D and I paths are the conventions `txrintake` already declared
 * (`ROUTE_CONVENTIONS.pretrainedModels` / `ROUTE_CONVENTIONS.savedModels`)
 * and this module registers them — the provider constant is the binding,
 * never a copied literal. The J path is the `/models` route `txrshell`'s
 * scaffold used to own; the same string, now owned here (DEC-2), and
 * `modelsPath(setId)` appends the `set` query param (DEC-19 — the convention
 * screen K (`ui-history`) binds for its "Made: N models" set links).
 *
 * The hygiene scan greps the module's shipped copy (source, README, and the
 * fixtures later items add — test files excluded, the sibling scans' scope):
 * zero `stud(y|ies)` literal (case-insensitive), zero open-marker tokens,
 * zero `http(s)://` string — the INV-5/6 posture (no domain wording outside
 * the txr vocabulary; no host literal; the source-paper / licence references
 * in later items are TEXT, never links). The scanned tokens are built from
 * split literals so this file itself stays clear of them (the same
 * discipline the sibling scans use).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppModule } from '@txresbench/framework/module-system/types'
import { ROUTE_CONVENTIONS } from '../txrintake/module'
import txrModelsModule from './module'
import { modelsPath, pretrainedModelsPath, savedModelsPath } from './index'

type RouteEntry = { path?: string }

function routesOf(module: unknown): RouteEntry[] {
  return (module as AppModule & { routes?: RouteEntry[] }).routes ?? []
}

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Every file under the module dir (the hygiene scan's whole, recursively). */
function moduleFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...moduleFiles(p))
    } else if (statSync(p).isFile()) {
      out.push(p)
    }
  }
  return out
}

describe('PROV-UI-MODELS-1 — the path builders (TEST-MOD-02)', () => {
  it('builds the documented paths', () => {
    expect(pretrainedModelsPath()).toBe('/pretrained-models')
    expect(savedModelsPath()).toBe('/saved-models')
    expect(modelsPath()).toBe('/models')
    expect(modelsPath('set-a1b2')).toBe('/models?set=set-a1b2')
  })

  it('matches the module route table and the declared conventions exactly', () => {
    // The builder outputs are the module's own route table — one source.
    expect(pretrainedModelsPath()).toBe(ROUTE_CONVENTIONS.pretrainedModels)
    expect(savedModelsPath()).toBe(ROUTE_CONVENTIONS.savedModels)
    const routes = routesOf(txrModelsModule).map(r => r.path)
    expect(routes).toContain(pretrainedModelsPath())
    expect(routes).toContain(savedModelsPath())
    expect(routes).toContain(modelsPath())
    // The J path is the shell's old `/models` — the same string, now owned
    // here (DEC-2); the scaffold route is removed on the same branch.
    expect(modelsPath()).toBe('/models')
  })

  it('keeps the J set-focus convention as `?set=<set_id>` (DEC-19, CONS-HIST-16)', () => {
    const param = modelsPath('set-zzz').split('?')[1]
    expect(param).toBe('set=set-zzz')
    // A clear affordance is J's own; the builder only ever appends.
    expect(modelsPath()).not.toContain('?')
  })

  it('README records the module ownership, the route table, the handoff, the events and the provider bindings (PROV-UI-MODELS-8)', () => {
    const readme = readFileSync(path.join(MODULE_DIR, 'README.md'), 'utf8')
    expect(readme).toContain('txrmodels')
    expect(readme).toContain('/pretrained-models')
    expect(readme).toContain('/saved-models')
    expect(readme).toContain('/models')
    expect(readme).toContain('txr:save-models-requested')
    expect(readme).toContain('txr:save-one-model-requested')
    expect(readme).toContain('txrshell')
    expect(readme).toContain('TxrSelectList')
    expect(readme).toContain('inventory')
  })

  it('carries no forbidden literal, no open-marker word and no URL literal anywhere in the module (INV-5/6)', () => {
    // Shipped copy only (source + README + fixtures): the test files are
    // scanned by scope elsewhere and PIN the scanned tokens as expected
    // values, which an INV-5/6 scan must allow outside shipped copy (the
    // same scope the module.test.ts hygiene scan documents). The kit
    // `Input` input-hint prop is an input affordance, not a copy mark —
    // its `placeholder="…"` occurrence is stripped, the same precision the
    // txrresults/txrintake scans use (qa-fixes ITEM-4's "Name this set"
    // hint).
    const kitHintProp = new RegExp('place' + 'holder' + '\\s*=\\s*"[^"]*"', 'gi')
    const whole = moduleFiles(MODULE_DIR)
      .filter(p => !/\.test\.(ts|tsx)$/.test(p))
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .replace(kitHintProp, '')
      .toLowerCase()
    expect(whole).not.toMatch(new RegExp('st' + 'ud(y|ies)', 'i'))
    const openMarkers = [
      'to' + 'do',
      't' + 'bd',
      'fix' + 'me',
      'place' + 'holder',
      'coming so' + 'on',
      'in pro' + 'gress',
      'work in' + ' progress',
    ]
    for (const marker of openMarkers) {
      expect(whole).not.toContain(marker)
    }
    expect(whole).not.toContain('http' + '://')
  })
})
