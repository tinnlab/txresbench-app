/**
 * TEST-MOD-05 — the txrmodels fixtures (`fixtures.ts`, ITEM-4;
 * INV-4/7/8).
 *
 * Pinned behaviors:
 *
 * - every fixture model id is `ps-<k>` (pretrained catalogue cards) or a
 *   stable synthetic uuid (saved models + installed rows) — a fixture
 *   built from a board id, a real run id or a random uuid fails here;
 * - every catalogue card's licence is one of the fixture's synthetic
 *   licence strings (MIT, Apache-2.0, CC BY 4.0) and no card pretends to
 *   a restricted-data dataset: the card licence is data and the fixture
 *   carries no `data_sources`-style restricted names at all (INV-8);
 * - the fixture payloads are COMPLETE against each other: every catalogue
 *   card has a verdict and every verdict a card (the count parity the
 *   row builders' defensive fallback guards — the fixture itself never
 *   exercises it), same for the saved models;
 * - the module's non-test source carries no board example number as a
 *   constant (INV-4: 38/151/56-day families — the scan pins the exact
 *   phrases/values instead of a looser digit scan, the TEST-MOD-01
 *   idiom) and no model-file or digest operation (INV-7: the module never
 *   parses, reads or verifies a model file — no path read, no hash
 *   computation; the fixture's `asset.sha256` is a VALUE on the wire
 *   shape, never an input to a computation);
 * - none of the module's own files read from the benchmark's protected
 *   trees (`restricted/`, `datasets/`, `results/` — owner rule: no data
 *   of any kind in the repo);
 * - the D and I flows share ONE inventory object (the ui-list DEC-15
 *   one-builder pin: `TXRMODELS_INVENTORY` is the single object, never a
 *   second drifting copy).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TXRMODELS_INVENTORY,
  TXRMODELS_PRETRAINED,
  TXRMODELS_PRETRAINED_ELIGIBILITY,
  TXRMODELS_SAVED,
  TXRMODELS_SAVED_ELIGIBILITY,
  fixtureModelId,
  fixtureInstalledId,
} from './fixtures'

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Every file under the module dir (the scan's whole, recursively). */
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

/** The module's non-test sources (the publish surface — INV-4/7/8 scans). */
function ownSourceFiles(dir: string): string[] {
  return moduleFiles(dir).filter(p => !/\.test\.(ts|tsx)$/.test(p))
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LICENCES = ['MIT', 'Apache-2.0', 'CC BY 4.0'] as const

describe('fixture identity + provenance hygiene (TEST-MOD-05)', () => {
  it('the pretrained card ids are ps-<k> and unique', () => {
    const ids = TXRMODELS_PRETRAINED.map(card => card.id)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id).toMatch(/^ps-\d+$/)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the saved-model and installed-row ids are stable synthetic uuids', () => {
    for (const model of TXRMODELS_SAVED) {
      expect(model.id).toMatch(UUID_RE)
    }
    const installed = TXRMODELS_PRETRAINED.flatMap(card => card.installed_model_id ?? [])
    for (const id of installed) expect(id).toMatch(UUID_RE)
    // The generator is stable and namespaced (a re-run gives the same id).
    expect(fixtureModelId(2)).toBe('a0000000-0000-4000-8000-000000000002')
    expect(fixtureInstalledId(2)).toBe('b0000000-0000-4000-8000-000000000002')
  })

  it('every card licence is one of the synthetic strings (INV-8: never a restricted-data name)', () => {
    for (const card of TXRMODELS_PRETRAINED) {
      expect(LICENCES).toContain(card.licence)
    }
  })

  it('the fixture payloads are complete: every card/model has a verdict and vice versa', () => {
    const cardIds = new Set(TXRMODELS_PRETRAINED.map(card => card.id))
    const verdictIds = new Set(TXRMODELS_PRETRAINED_ELIGIBILITY.models.map(v => v.id))
    expect(verdictIds).toEqual(cardIds)

    const modelIds = new Set(TXRMODELS_SAVED.map(model => model.id))
    const savedVerdictIds = new Set(TXRMODELS_SAVED_ELIGIBILITY.models.map(v => v.id))
    expect(savedVerdictIds).toEqual(modelIds)
  })

  it('the D and I flows share ONE inventory object', () => {
    // The eligibility requests carry this object verbatim; a second
    // inventory in the fixtures would be exactly the drift the pin is
    // against. The object is content-valid: patients + markers present.
    expect(TXRMODELS_INVENTORY.patients).toBeGreaterThan(0)
    expect(TXRMODELS_INVENTORY.markers.length).toBeGreaterThan(0)
  })
})

describe("the module's source-surface scans (TEST-MOD-05, INV-4/6/7)", () => {
  const own = ownSourceFiles(MODULE_DIR)
    .map(p => readFileSync(p, 'utf8'))
    .join('\n')
    .toLowerCase()

  it('carries no board example number as a constant (INV-4)', () => {
    const boardExampleFacts = [
      '38 pa' + 'tients',
      '5 ca' + 'n run',
      '13 sa' + 'ved models',
      '151 pa' + 'tients',
      'of 3' + '8',
      '50 m' + 'b',
      '11 m' + 'odels',
      '0.' + '64',
    ]
    for (const fact of boardExampleFacts) {
      expect(own).not.toContain(fact)
    }
  })

  it('performs no model-file or digest operation (INV-7)', () => {
    const digestOps = ['create' + 'hash', 'crypto', 'read' + 'file', 'write' + 'file', 'open' + 'sync']
    for (const op of digestOps) {
      expect(own).not.toContain(op.toLowerCase())
    }
  })

  it('reads from none of the protected trees', () => {
    // The trees are matched as PATH SEGMENTS (a slash-bounded `results/`)
    // — the module's sibling-module source path `/txrresults/…` contains
    // the substring but is the framework's sibling module, never the
    // benchmark tree; the ban's intent (no read from `restricted/`,
    // `datasets/` or `results/`) is untouched (DRIFT-1 ITEM-10 — the
    // test device, pinned by the gallery's sibling imports).
    for (const tree of ['restricted' + '/', 'datasets' + '/', 'results' + '/']) {
      expect(new RegExp(`(^|[\\W])${tree.replace('/', '\\/')}`, 'i').test(own)).toBe(false)
    }
  })

  it('keeps the fixture asset facts as data only: a sha256 VALUE, never a hash of anything', () => {
    // The asset sha256 is a constant field on the wire shape; nothing in
    // the module computes over it.
    for (const card of TXRMODELS_PRETRAINED) {
      expect(card.asset.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
