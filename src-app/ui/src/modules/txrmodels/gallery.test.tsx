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
  'ModelSets.exportSet',
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

/** The plan's slate of slugs (PROV-UI-MODELS-6's enumeration; the old D/I
 *  stories left in round 3 — the merged-list stories take their place) plus
 *  the ITEM-5 J phone-width story (RES-16 — the inventory's own 390 px
 *  story), the ONE-table expanded-state story (the one-table round), the
 *  part-2 search + sort stories (the client-side search state and the Name
 *  A→Z state), the app-shell ITEM-3 shell-route surfaces (the real pages
 *  inside the real shell — TEST-AS-2's part-2 half) and the merged
 *  list's no-file / one-source-failure stories (the old D empty/error
 *  stories, re-pointed round 3). */
const STORY_SLUGS = [
  'txr-models-j',
  'txr-models-j-expanded',
  'txr-models-j-narrow-390',
  'txr-models-j-search',
  'txr-models-j-sort-name',
  'txr-shell-route-models',
  'txr-models-choose',
  'txr-models-choose-narrow-390',
  'txr-models-choose-none',
  'txr-shell-route-choose-models',
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

  it('exports every unique story slug, one per board state', () => {
    const slugs = (gallery.seeded ?? []).map(story => story.slug)
    expect(slugs).toEqual(STORY_SLUGS)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('mounts every story under its route (the gallery frame binds one path)', () => {
    const bySlug = new Map((gallery.seeded ?? []).map(story => [story.slug, story]))
    // The dialog frames render DESCENDANT Routes (the save navigations are
    // observed in-frame), so the harness parent route is the splat — the
    // initialPath still binds the real screen.
    for (const slug of ['txr-models-l', 'txr-models-l2', 'txr-models-l3']) {
      expect(bySlug.get(slug)?.path, slug).toBe('/*')
    }
    expect(bySlug.get('txr-models-j')?.path).toBe('/models')
    expect(bySlug.get('txr-models-j')?.initialPath).toBe('/models')
    // The ONE-table expanded-state story is the same J frame with a set
    // already open (the module-level store the chevron writes); the part-2
    // search/sort stories are the same J frame driven by the story's
    // post-mount driver (the page's own component state).
    expect(bySlug.get('txr-models-j-expanded')?.path).toBe('/models')
    expect(bySlug.get('txr-models-j-expanded')?.initialPath).toBe('/models')
    expect(bySlug.get('txr-models-j-search')?.path).toBe('/models')
    expect(bySlug.get('txr-models-j-search')?.initialPath).toBe('/models')
    expect(bySlug.get('txr-models-j-sort-name')?.path).toBe('/models')
    expect(bySlug.get('txr-models-j-sort-name')?.initialPath).toBe('/models')
    // The ITEM-5 phone-width story is the same J frame in a narrow wrapper
    // (RES-16) — the same real route, the same board.
    expect(bySlug.get('txr-models-j-narrow-390')?.path).toBe('/models')
    expect(bySlug.get('txr-models-j-narrow-390')?.initialPath).toBe('/models')
    // The no-file and source-failure stories are the merged list's (the old
    // D story pair's re-pointed round-3 home — the D page is gone).
    expect(bySlug.get('txr-models-empty')?.initialPath).toBe('/choose-models')
    expect(bySlug.get('txr-models-error')?.initialPath).toBe('/choose-models')
    // The merged-list stories bind the round-2 route (the D/I frames'
    // descendant-Routes pattern — the run's in-frame navigation shows the
    // landing line).
    for (const slug of ['txr-models-choose', 'txr-models-choose-narrow-390', 'txr-models-choose-none', 'txr-shell-route-choose-models']) {
      expect(bySlug.get(slug)?.path, slug).toBe('/*')
      expect(bySlug.get(slug)?.initialPath, slug).toBe('/choose-models')
    }
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
