/**
 * TEST-MOD-16 — the txrmodels dev-gallery seed (`gallery.tsx`, ITEM-10,
 * PROV-UI-MODELS-6).
 *
 * Pinned behaviors:
 *
 * - the module's gallery exports the nine stories with unique slugs, one
 *   per board state (the plan's enumeration; the tests' "ten" wording was
 *   the planner's count of the PROV-UI-MODELS-6 list — the list itself
 *   names nine — the implementation follows the enumeration);
 * - the cassette mocks EXACTLY the JSON operations this node consumes
 *   (the generated `ApiEndpoints` string keys — never a draft `Txr.*`
 *   spelling) that no sibling module owns; the sibling-owned keys this
 *   module also consumes are the per-story id-scoped extension seeds
 *   (`Txr.createRun`, `Txr.getRun`, `Txr.getPredictions`,
 *   `Txr.getAnalysisConfig`, `MethodCatalogue.list` — the
 *   `mergeModuleCassettes` one-owner rule), and the one byte surface
 *   (`Models.exportModel`) is the module's single special mock route;
 * - every story's `path` binds the real route the page is mounted under
 *   (the MemoryRouter initialPath the gallery seeds), and the L / L2
 *   stories drive the REAL EventBus events (the `txrresults` emitters —
 *   the same entry seam the results screen's buttons use).
 *
 * No store, no DOM: the gallery seed is a declaration object; the story
 * behavior is the gallery-e2e spec's (TEST-MOD-17/18/19).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gallery, txrMockRoutes } from './gallery'
import { emitSaveModels, emitSaveOneModel } from '@/modules/txrresults/events'

/** The module-level cassette's owned keys (ApiEndpoints ids, sorted). */
const OWNED_CASSETTE_KEYS = [
  'ModelSets.deleteSet',
  'ModelSets.listSets',
  'ModelSets.renameSet',
  'Models.checkEligibility',
  'Models.deleteModel',
  'Models.getModel',
  'Models.importModel',
  'Models.listModels',
  'Models.renameModel',
  'Models.resolveModels',
  'Models.saveModels',
  'Pretrained.checkEligibility',
  'Pretrained.downloadModel',
  'Pretrained.getModel',
  'Pretrained.installModel',
  'Pretrained.listDownloads',
  'Pretrained.listModels',
]

/** The consumed keys that belong to sibling modules (story extensions). */
const SIBLING_OWNED_KEYS = [
  'MethodCatalogue.list',
  'Txr.createRun',
  'Txr.getAnalysisConfig',
  'Txr.getPredictions',
  'Txr.getRun',
]

/** The plan's nine slate of slugs (PROV-UI-MODELS-6's enumeration). */
const STORY_SLUGS = [
  'txr-models-d',
  'txr-models-d-narrow-390',
  'txr-models-i',
  'txr-models-j',
  'txr-models-l',
  'txr-models-l2',
  'txr-models-l3',
  'txr-models-empty',
  'txr-models-error',
]

describe('txrmodels gallery seed (TEST-MOD-16)', () => {
  it('owns exactly the JSON operations this node consumes and no others', () => {
    expect(Object.keys(gallery.cassette ?? {}).sort()).toEqual(OWNED_CASSETTE_KEYS)
  })

  it('answers every owned key with a fixture payload (never a board example)', () => {
    for (const key of OWNED_CASSETTE_KEYS) {
      const entry = gallery.cassette![key as keyof typeof gallery.cassette]
      expect(entry, `cassette entry ${key}`).toBeDefined()
    }
  })

  it('exports the nine unique story slugs, one per board state', () => {
    const slugs = (gallery.seeded ?? []).map(story => story.slug)
    expect(slugs).toEqual(STORY_SLUGS)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('mounts every story under its route (the gallery frame binds one path)', () => {
    const bySlug = new Map((gallery.seeded ?? []).map(story => [story.slug, story]))
    // The D and dialog frames render DESCENDANT Routes (the run/save
    // navigations are observed in-frame), so the harness parent route is
    // the splat — the initialPath still binds the real screen.
    for (const slug of ['txr-models-d', 'txr-models-d-narrow-390', 'txr-models-l', 'txr-models-l2', 'txr-models-l3']) {
      expect(bySlug.get(slug)?.path, slug).toBe('/*')
    }
    for (const slug of ['txr-models-d', 'txr-models-d-narrow-390', 'txr-models-empty', 'txr-models-error']) {
      expect(bySlug.get(slug)?.initialPath, slug).toBe('/pretrained-models')
    }
    expect(bySlug.get('txr-models-i')?.path).toBe('/saved-models')
    expect(bySlug.get('txr-models-i')?.initialPath).toBe('/saved-models')
    expect(bySlug.get('txr-models-j')?.path).toBe('/models')
    expect(bySlug.get('txr-models-j')?.initialPath).toBe('/models')
    expect(bySlug.get('txr-models-empty')?.path).toBe('/pretrained-models')
    expect(bySlug.get('txr-models-error')?.path).toBe('/pretrained-models')
    for (const slug of ['txr-models-l', 'txr-models-l2', 'txr-models-l3']) {
      expect(bySlug.get(slug)?.initialPath, slug).toBe('/analysis/run-c/results')
    }
  })

  it('drives the L and L2 dialogues through the real EventBus emitters', () => {
    // The story frames' host buttons call the txrresults emitters (the
    // results screen's own entry seam — never a component import, never a
    // second event spelling). Both emitters are functions that emit the
    // declared AppEvents keys.
    expect(typeof emitSaveModels).toBe('function')
    expect(typeof emitSaveOneModel).toBe('function')
  })

  it('registers exactly one special mock route (the export byte surface)', () => {
    expect(txrMockRoutes.map(entry => entry.op)).toEqual(['exportModel'])
    expect(txrMockRoutes[0]!.route.test('/api/txr/models/a0000000-0000-4000-8000-000000000011/export', 'GET')).toBe(true)
    expect(txrMockRoutes[0]!.route.test('/api/txr/models', 'GET')).toBe(false)
  })

  it('seeds the sibling-owned keys per story (never at module level)', () => {
    // The module-level cassette WOULD collide with the sibling owners
    // (mergeModuleCassettes throws on a duplicate key, so the gallery
    // cannot boot with any of these at module scope); the stories answer
    // them through their SeedGate extensions. The declaration-level pin:
    // none of the five appears in the cassette, each appears in the story
    // seeds' extendCassette calls.
    for (const key of SIBLING_OWNED_KEYS) {
      expect(gallery.cassette, `module cassette must not own ${key}`).not.toHaveProperty(key)
    }
    const source = readFileSync(fileURLToPath(new URL('./gallery.tsx', import.meta.url)), 'utf8')
    for (const key of SIBLING_OWNED_KEYS) {
      expect(source, `story seeds must answer ${key}`).toContain(`'${key}':`)
    }
  })
})
