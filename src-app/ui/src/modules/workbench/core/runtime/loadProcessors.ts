// The ONE generic processor-package loader (PLAN.md ITEM-3 / ITEM-23, DEC-22, Design
// mechanism 5). Discovers `packages/<name>/` DATA packages — `manifest.yaml` (the analysis
// contribution as DATA) + `ui/*.yaml` (the declarative `view_spec`) — and registers each:
//   1. every `contributes.analyses[]` entry → a live `AnalysisContribution` into
//      `workbenchRegistry.analyses` (ITEM-23), the SAME registration the old
//      `builtins/<name>/extension.ts` did imperatively — now sourced from DATA.
//   2. every analysis' `ui:` list → `registerDeclarativeViews` (LOUD-parse → actions into
//      `defineAction`, widgets, and the ONE pane the analysis becomes) (ITEM-3 / INV-3).
//   3. every `contributes.sections[]` entry → `registerDeclarativeSection`, into
//      `workbenchRegistry.sections` — the Visualize-pane blocks (visualize-pane ITEM-2).
//      A DIFFERENT registry from (2) on purpose: a section names a `pane`, never an area,
//      and never reaches the placement/docking path.
//
// This is the generic replacement for `discover.ts`'s `builtins/*/extension.ts` glob-of-CODE
// (the analysis↔app coupling INV-6 forbids). In Slice 1 (FOUNDATION) it runs ADDITIVELY
// ALONGSIDE the old glob — no analysis package ships FE-manifest DATA yet, so production
// discovery is a safe no-op on the existing (backend-shaped) `packages/*` manifests; later
// slices re-home each package to DATA and THEN remove the glob.
//
// Pure core (`processorAnalysisToContribution` / `registerProcessorPackage` / `loadProcessors`)
// is DOM-free + registry-injectable so it is directly unit-testable; `loadDiscoveredProcessors`
// is the thin production wiring over vite's `import.meta.glob`.

import { parse as parseYaml } from 'yaml'
import {
  workbenchRegistry as defaultRegistry,
  WORKBENCH_API_VERSION,
  topoSortByDependencies,
  type Contributions,
  type AnalysisContribution,
  type ProcessorPackage,
  type ProcessorManifestData,
  type ProcessorAnalysisData,
} from '@/modules/workbench/core'
import { ApiClient } from '@/api-client'
import { registerDeclarativeSection, registerDeclarativeViews, type RawDeclarativeView } from './register'
import { interpolate } from './expr'

export interface LoadError {
  package: string
  path: string
  message: string
}

export interface LoadProcessorsResult {
  /** ids of the `AnalysisContribution`s registered into `workbenchRegistry.analyses`. */
  analysisIds: string[]
  /** the pane `ViewContribution` ids registered — ONE per analysis that declared `ui:`
   *  (INV-3), NOT one per view file. */
  viewContributionIds: string[]
  /** the `SectionContribution` ids registered into `workbenchRegistry.sections` (ITEM-2) —
   *  ONE per `contributes.sections[]` entry that declared `ui:`. Kept as its own list, not
   *  folded into `viewContributionIds`, because the two go into DIFFERENT registries and a
   *  caller counting "views" must not silently start counting sections. */
  sectionIds: string[]
  /** per-item failures. Fail-isolated per ANALYSIS: a bad analysis, or one bad file in an
   *  analysis' `ui:` list, drops that analysis' pane and never aborts the rest. */
  errors: LoadError[]
}

/**
 * Build a live `AnalysisContribution` from a package's DATA analysis entry (ITEM-23). PURE.
 * The DATA carries the SAME field names the FE contribution uses; the loader fills
 * `extensionId` (from the manifest id) + `apiVersion` (from `WORKBENCH_API_VERSION`), and wraps
 * an optional `methodsText` TEMPLATE STRING into the `(p) => string` fn (INV-1: the package ships
 * a string, never a closure — the closure is synthesized here in the app).
 */
/** Keys a manifest may no longer carry (INV-1). A manifest still declaring one FAILS
 *  to load, naming the package and the key (DEC-3) — never accepted-and-ignored.
 *
 *  Silence was the alternative and it is the failure mode this round removes: a key
 *  that parses but is dropped leaves an author believing a declaration is in force,
 *  and leaves the remaining migrations to be forgotten. It is only viable to hard-fail
 *  because every shipped package migrated in the same change (DEC-1). */
const REMOVED_ANALYSIS_KEYS: ReadonlyArray<[string, string]> = [
  ['accepts', 'renamed to `appliesTo` (all entries required; an optional entry belongs in `consumes`)'],
  ['when', 'a weaker restatement of `appliesTo` that could never independently fail'],
  ['params', 'a FORM SCHEMA — the view owns labels/help/order and declares its own option sources'],
  ['defaults', "the compute owns the fallback at the one boundary a value can be absent (`params.json`)"],
  ['produces_annotations', 'an unverified forecast — column types are read from the artifacts that landed'],
  ['inStandardRecipe', 'no consumer in either language'],
  ['recipeOrder', 'no consumer in either language'],
]

/** `run.inputs` / `schedule.resources` — removed NESTED keys, same rule. */
const REMOVED_NESTED_KEYS: ReadonlyArray<[string, string, string]> = [
  ['run', 'inputs', 'the runner names each mount from the ARTIFACT it is mounting, not from a manifest filename'],
  ['schedule', 'resources', 'read by nothing; real limits are the singleton sandbox settings row'],
]

/** Throw if `data` carries a key the schema removed. */
function assertNoRemovedKeys(data: ProcessorAnalysisData): void {
  const rec = data as unknown as Record<string, unknown>
  for (const [key, why] of REMOVED_ANALYSIS_KEYS) {
    if (rec[key] !== undefined) {
      throw new Error(`analysis "${data?.id}" declares removed key \`${key}\` — ${why}`)
    }
  }
  for (const [parent, key, why] of REMOVED_NESTED_KEYS) {
    const p = rec[parent] as Record<string, unknown> | undefined
    if (p && typeof p === 'object' && p[key] !== undefined) {
      throw new Error(`analysis "${data?.id}" declares removed key \`${parent}.${key}\` — ${why}`)
    }
  }
}

export function processorAnalysisToContribution(
  data: ProcessorAnalysisData,
  extensionId: string,
): AnalysisContribution {
  assertNoRemovedKeys(data)
  const methodsTemplate = data.methodsText
  return {
    id: data.id,
    extensionId,
    apiVersion: WORKBENCH_API_VERSION,
    title: data.title,
    category: data.category,
    description: data.description,
    whenHint: data.whenHint,
    examples: data.examples,
    safety: data.safety,
    ai: data.ai,
    order: data.order,
    appliesTo: data.appliesTo as AnalysisContribution['appliesTo'],
    consumes: data.consumes as AnalysisContribution['consumes'],
    produces: data.produces,
    ui: data.ui as AnalysisContribution['ui'],
    run: data.run as AnalysisContribution['run'],
    schedule: data.schedule as AnalysisContribution['schedule'],
    arch: data.arch,
    launchable: data.launchable,
    trigger: data.trigger,
    ...(data.draftable !== undefined ? { draftable: data.draftable } : {}),
    ...(methodsTemplate != null
      ? { methodsText: (p: Record<string, unknown>) => interpolate(methodsTemplate, { params: p, ...p }) }
      : {}),
  }
}

/**
 * Register ONE processor package as DATA: its `contributes.analyses[]` into
 * `workbenchRegistry.analyses` (ITEM-23) + each `ui/*.yaml` view_spec via
 * `registerDeclarativeView` (ITEM-3). Every item is fail-ISOLATED (a bad analysis / an invalid
 * view spec is collected into `errors` and skipped, never aborting the rest).
 */
export function registerProcessorPackage(
  pkg: ProcessorPackage,
  registry: Contributions,
): LoadProcessorsResult {
  const out: LoadProcessorsResult = { analysisIds: [], viewContributionIds: [], sectionIds: [], errors: [] }
  const manifestId = pkg.manifest?.id ?? '(unknown)'

  // 1. analyses from manifest DATA (ITEM-23).
  for (const a of pkg.manifest?.contributes?.analyses ?? []) {
    try {
      const contribution = processorAnalysisToContribution(a, manifestId)
      registry.analyses.register(contribution)
      out.analysisIds.push(contribution.id)
    } catch (err) {
      out.errors.push({
        package: manifestId,
        path: `contributes.analyses.${a?.id ?? '?'}`,
        message: String((err as Error)?.message ?? err),
      })
    }
  }

  // 2. ONE pane per ANALYSIS, holding the view files its `ui:` list names, IN THAT ORDER
  //    (ITEM-3 / INV-3).
  //
  // Iterated PER ANALYSIS, not over a flattened `flatMap(a => a.ui)`. Flattening threw away
  // the very attribution the `ui:` key exists to carry: it could not tell which analysis a
  // file belonged to, so a package with two analyses produced one undifferentiated list and
  // "these files stack, in this order, into THAT analysis' pane" had nowhere to be expressed.
  //
  // Not a directory scan either. The glob still discovers the files (it is a build-time macro —
  // a module has to be globbed to exist at all), but the manifest SELECTS and ORDERS from
  // what it found.
  //
  // A `ui:` entry naming a file that is absent (or failed to parse) is an ERROR, not a
  // silently-shorter list, and it takes its ANALYSIS' whole pane down with it (see
  // `registerDeclarativeViews`) — half a form is not a form. Sibling analyses are unaffected.
  for (const a of pkg.manifest?.contributes?.analyses ?? []) {
    const relPaths = a?.ui ?? []
    if (relPaths.length === 0) continue
    const analysisId = a?.id
    if (typeof analysisId !== 'string' || analysisId.length === 0) {
      out.errors.push({
        package: manifestId,
        path: 'contributes.analyses.?',
        message: 'an analysis declares `ui:` but has no id — its pane has nothing to be keyed on',
      })
      continue
    }
    const files: RawDeclarativeView[] = []
    let missing = false
    for (const relPath of relPaths) {
      const raw = pkg.views[relPath]
      if (raw === undefined) {
        out.errors.push({
          package: manifestId,
          path: relPath,
          message: `declared in \`ui:\` of analysis "${analysisId}" but no such view file in the package (or it failed to parse)`,
        })
        missing = true
        continue
      }
      files.push({ path: relPath, raw })
    }
    if (missing) continue // fail-CLOSED for this analysis; the rest of the package still loads.
    let res
    try {
      res = registerDeclarativeViews(analysisId, files, registry, {
        extensionId: manifestId,
        title: a?.title ?? analysisId,
      })
    } catch (err) {
      out.errors.push({ package: manifestId, path: relPaths.join(', '), message: String((err as Error)?.message ?? err) })
      continue
    }
    if (!res.ok) {
      for (const e of res.errors ?? []) out.errors.push({ package: manifestId, path: e.path, message: e.message })
    } else {
      out.viewContributionIds.push(...res.contributionIds)
    }
  }

  // 3. VISUALIZE-PANE SECTIONS (ITEM-2) — each `contributes.sections[]` entry becomes ONE
  //    `SectionContribution` in `workbenchRegistry.sections`, holding the view files its
  //    OWN `ui:` list names, in that order (one `DeclarativeRegion` each).
  //
  //    A separate loop from the analyses above, and a separate REGISTRY, because a section
  //    is not a view: it names a `pane`, it never docks, and it must not reach the
  //    placement path (DEC-1/INV-12). The two loops share only the file-resolution rule,
  //    which is deliberately identical — a `ui:` entry naming a file that is absent or
  //    unparseable is an ERROR, never a silently-shorter stack, and it takes down exactly
  //    its own unit.
  //
  //    A package may contribute sections with NO analysis at all (ITEM-65) — hence a loop
  //    that does not read `contributes.analyses` and does not care whether it is empty.
  for (const s of pkg.manifest?.contributes?.sections ?? []) {
    const sectionId = s?.id
    if (typeof sectionId !== 'string' || sectionId.length === 0) {
      out.errors.push({
        package: manifestId,
        path: 'contributes.sections.?',
        message: 'a section has no id — the user\'s saved section order has nothing to be keyed on',
      })
      continue
    }
    const relPaths = s?.ui ?? []
    if (relPaths.length === 0) {
      // Not an error the loader invents a default for: a section with no view files is a
      // header that can never say anything. Named LOUDLY, because the alternative is a
      // registered section that renders as an empty block the user can drag and collapse.
      out.errors.push({
        package: manifestId,
        path: `contributes.sections.${sectionId}`,
        message: 'declares no `ui:` files — a section with nothing in it is a header, not a section',
      })
      continue
    }
    const files: RawDeclarativeView[] = []
    let missing = false
    for (const relPath of relPaths) {
      const raw = pkg.views[relPath]
      if (raw === undefined) {
        out.errors.push({
          package: manifestId,
          path: relPath,
          message: `declared in \`ui:\` of section "${sectionId}" but no such view file in the package (or it failed to parse)`,
        })
        missing = true
        continue
      }
      files.push({ path: relPath, raw })
    }
    if (missing) continue // fail-CLOSED for this section; its siblings still register.
    let res
    try {
      res = registerDeclarativeSection(s, files, registry, { extensionId: manifestId })
    } catch (err) {
      out.errors.push({
        package: manifestId,
        path: `contributes.sections.${sectionId}`,
        message: String((err as Error)?.message ?? err),
      })
      continue
    }
    if (!res.ok) {
      for (const e of res.errors ?? []) out.errors.push({ package: manifestId, path: e.path, message: e.message })
    } else {
      out.sectionIds.push(...res.contributionIds)
    }
  }

  return out
}

/**
 * Load a set of already-discovered processor packages (DATA), topo-sorted by each manifest's
 * `dependencies` (the SAME ordering the old glob loader used), registering each package's
 * analyses + view specs. PURE + registry-injectable (defaults to the app's `workbenchRegistry`).
 * A topo-sort failure (dependency cycle) is collected and aborts ordering only — it never throws.
 */
export function loadProcessors(
  packages: ProcessorPackage[],
  registry: Contributions = defaultRegistry,
): LoadProcessorsResult {
  const out: LoadProcessorsResult = { analysisIds: [], viewContributionIds: [], sectionIds: [], errors: [] }
  const withManifest = packages.filter(p => p && p.manifest && typeof p.manifest.id === 'string')
  const byId = new Map(withManifest.map(p => [p.manifest.id, p]))

  let ordered: ProcessorManifestData[]
  try {
    ordered = topoSortByDependencies(withManifest.map(p => p.manifest)) as ProcessorManifestData[]
  } catch (err) {
    out.errors.push({ package: '*', path: 'topo-sort', message: String((err as Error)?.message ?? err) })
    return out
  }

  for (const m of ordered) {
    const pkg = byId.get(m.id)
    if (!pkg) continue
    const r = registerProcessorPackage(pkg, registry)
    out.analysisIds.push(...r.analysisIds)
    out.viewContributionIds.push(...r.viewContributionIds)
    out.sectionIds.push(...r.sectionIds)
    out.errors.push(...r.errors)
  }
  return out
}

// ── production discovery (vite `import.meta.glob`) ──────────────────────────────────────────────
//
// Discover `packages/<name>/{manifest.yaml, ui/*.yaml}` as RAW text (DATA), parse the YAML, and
// group by package dir. The glob is a build-time macro (transformed on import), so it validates at
// bundle time; the RESULT is empty until a package ships FE-manifest DATA (Slice 2+), keeping this
// additive alongside `discover.ts` in Slice 1.

/** `.../packages/<name>/manifest.yaml` → `<name>`. */
function packageNameFromManifestPath(p: string): string {
  const m = /\/packages\/([^/]+)\/manifest\.yaml$/.exec(p)
  return m ? m[1] : p
}

/** `.../packages/<name>/ui/<file>.yaml` → `[<name>, 'ui/<file>.yaml']`. The
 *  package-relative path is what an analysis' `ui:` entry names. */
function viewPathParts(p: string): [string, string] | null {
  const m = /\/packages\/([^/]+)\/(ui\/[^/]+\.yaml)$/.exec(p)
  return m ? [m[1], m[2]] : null
}

/** Decode ONE package's raw `manifest.yaml` text + raw `ui/*.yaml` texts into a
 * `ProcessorPackage` (parsing YAML). Shared by the build-time glob AND the runtime fetch.
 * A manifest that isn't valid YAML (or has no `id`) yields `null` (skip, never wedge). A
 * malformed view is dropped here; `registerDeclarativeView` fails closed anyway. */
function decodePackage(manifestRaw: string, viewRaws: Array<[string, string]>): ProcessorPackage | null {
  let manifest: ProcessorManifestData | undefined
  try {
    manifest = parseYaml(manifestRaw) as ProcessorManifestData
  } catch {
    return null
  }
  if (!manifest || typeof manifest.id !== 'string') return null
  const views: Record<string, unknown> = {}
  for (const [relPath, raw] of viewRaws) {
    try {
      views[relPath] = parseYaml(raw)
    } catch {
      // a malformed ui/*.yaml is skipped; the analysis' `ui:` lookup then reports it
      // BY PATH (fail-closed) instead of silently registering one fewer view.
    }
  }
  return { manifest, views }
}

/** Discover + decode every processor package from the `packages/` tree (the build-time
 * glob — the SYNCHRONOUS SEED baseline that registers the baked packages instantly, with
 * no first-paint delay). The runtime fetch (`loadRuntimeProcessors`) then adds any package
 * NOT baked into this glob (a runtime-dropped separate-repo package), so INV-3's FE-render
 * leg holds with ZERO rebuild. */
export function discoverProcessorPackages(): ProcessorPackage[] {
  const manifestRaw = import.meta.glob('../../../../../../packages/*/manifest.yaml', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>
  const viewRaw = import.meta.glob('../../../../../../packages/*/ui/*.yaml', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>

  // group view files by package name.
  const viewsByPkg = new Map<string, Array<[string, string]>>()
  for (const [path, raw] of Object.entries(viewRaw)) {
    const parts = viewPathParts(path)
    if (!parts) continue
    const [name, rel] = parts
    if (!viewsByPkg.has(name)) viewsByPkg.set(name, [])
    viewsByPkg.get(name)!.push([rel, raw])
  }

  const packages: ProcessorPackage[] = []
  for (const [path, raw] of Object.entries(manifestRaw)) {
    const name = packageNameFromManifestPath(path)
    const pkg = decodePackage(raw, viewsByPkg.get(name) ?? [])
    if (pkg) packages.push(pkg)
  }
  return packages
}

/**
 * Fetch the processor packages' SOURCE assets FROM THE RUNTIME FOLDER (H2) via
 * `GET /api/processors/packages` (the server serves each registered package's
 * `manifest.yaml` + `ui/*.yaml` bytes from `<data_root>/processors/`), and decode each into
 * a `ProcessorPackage`. This is what makes a runtime-DROPPED pure-DATA processor's
 * declarative UI render with ZERO FE rebuild — the build-time glob only ever sees the
 * in-tree (baked) packages. A network/parse failure yields `[]` (the baked baseline still
 * rendered). A package shipping React `.tsx` component refs stays a documented build-time
 * limitation (arbitrary tsx can't be runtime-imported); its yaml view-spec — the DATA path
 * — is what this makes work.
 */
export async function fetchRuntimeProcessorPackages(): Promise<ProcessorPackage[]> {
  const res = await ApiClient.Processor.packages()
  const out: ProcessorPackage[] = []
  for (const p of res.packages) {
    const pkg = decodePackage(p.manifest, (p.views ?? []).map(v => [v.path, v.text] as [string, string]))
    if (pkg) out.push(pkg)
  }
  return out
}

// Idempotency guard — pinned to globalThis alongside the (globalThis-shared) contribution
// registry, so an HMR reload / duplicate module instance doesn't re-run discovery into an
// already-populated registry (mirrors `discover.ts`'s `discoverBuiltins` guard).
const G_KEY = '__txr_processors_loaded__'
function isLoaded(): boolean {
  return Boolean((globalThis as unknown as Record<string, boolean | undefined>)[G_KEY])
}
function markLoaded(): void {
  ;(globalThis as unknown as Record<string, boolean | undefined>)[G_KEY] = true
}

// The runtime (leg-2) latch + the baked-id set leg 1 produced. Both live on globalThis for
// the SAME reason `G_KEY` does: the contribution registry is globalThis-shared, so a
// duplicate module instance (HMR, a second bundle copy) must observe the same latch or it
// would re-register the delta into an already-populated registry.
const G_RUNTIME_KEY = '__txr_runtime_processors_loaded__'
const G_BAKED_KEY = '__txr_processors_baked_ids__'
function isRuntimeLoaded(): boolean {
  return Boolean((globalThis as unknown as Record<string, boolean | undefined>)[G_RUNTIME_KEY])
}
function markRuntimeLoaded(): void {
  ;(globalThis as unknown as Record<string, boolean | undefined>)[G_RUNTIME_KEY] = true
}
/** The ids leg 1 registered from the build-time glob — leg 2's `skipIds` (the delta rule). */
function rememberBakedIds(ids: ReadonlySet<string>): void {
  ;(globalThis as unknown as Record<string, ReadonlySet<string> | undefined>)[G_BAKED_KEY] = ids
}
function bakedIds(): ReadonlySet<string> {
  return (
    (globalThis as unknown as Record<string, ReadonlySet<string> | undefined>)[G_BAKED_KEY] ??
    new Set<string>()
  )
}

/**
 * Load the RUNTIME-discovered packages (H2), registering only those NOT already loaded from
 * the build-time glob (`skipIds`) — i.e. the runtime-dropped, separate-repo packages the
 * glob could never see. PURE + registry-injectable (the fetch is passed in so it is unit-
 * testable without a live backend). Returns the load result; a fetch failure is swallowed
 * (the baked baseline already rendered). This is what upholds INV-3's FE-render leg.
 */
export async function loadRuntimeProcessors(
  registry: Contributions = defaultRegistry,
  skipIds: ReadonlySet<string> = new Set(),
  fetchPackages: () => Promise<ProcessorPackage[]> = fetchRuntimeProcessorPackages,
): Promise<LoadProcessorsResult> {
  const out: LoadProcessorsResult = { analysisIds: [], viewContributionIds: [], sectionIds: [], errors: [] }
  let packages: ProcessorPackage[]
  try {
    packages = await fetchPackages()
  } catch {
    return out // baked baseline already rendered; a runtime fetch failure is non-fatal.
  }
  // Only register packages the build-time glob did NOT already load (the dropped delta).
  const delta = packages.filter(p => p?.manifest?.id && !skipIds.has(p.manifest.id))
  const result = loadProcessors(delta, registry)
  out.analysisIds.push(...result.analysisIds)
  out.viewContributionIds.push(...result.viewContributionIds)
  out.sectionIds.push(...result.sectionIds)
  out.errors.push(...result.errors)
  return out
}

/**
 * Production entry (LEG 1 ONLY — synchronous, no network): discover + load every BAKED
 * processor package into the app's `workbenchRegistry` from the build-time glob. Runs at
 * module-evaluation time (`workbench/module.tsx`, `workbench/gallery.tsx`), which is what
 * ~all the module-scope contribution consumers depend on, so it must stay synchronous and
 * un-gated. Idempotent (globalThis-guarded); a discovery/parse throw is logged + left
 * un-latched (a later retry/HMR can re-attempt).
 *
 * LEG 2 — the runtime-dropped delta over `GET /api/processors/packages` — deliberately does
 * NOT run here. That endpoint is gated by `projects::use`, so firing it at module eval meant
 * every LOGGED-OUT visitor (the login screen) issued a request that could only 401, and the
 * api-client logged a `console.error` for it. `loadRuntimeProcessorsOnce()` is the auth-gated
 * entry; `workbench/module.tsx` drives it from a `routerEffects` effect once the user is
 * authenticated (the exact shape `modules/datatypes` uses for its own `projects::use`-gated
 * boot fetch).
 */
export function loadDiscoveredProcessors(registry: Contributions = defaultRegistry): void {
  if (isLoaded()) return
  const baked = new Set<string>()
  try {
    const packages = discoverProcessorPackages()
    for (const p of packages) if (p?.manifest?.id) baked.add(p.manifest.id)
    const result = loadProcessors(packages, registry)
    for (const e of result.errors) {
      // eslint-disable-next-line no-console
      console.error(`[workbench] processor "${e.package}" ${e.path}: ${e.message}`)
    }
    markLoaded() // latch only after a clean (synchronous) baseline discovery pass.
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[workbench] processor discovery failed; will retry on next call', err)
  }
  // Hand leg 2 the baked ids (its `skipIds` delta rule) — it runs later, from the auth gate.
  rememberBakedIds(baked)
}

/**
 * LEG 2, auth-gated (H2/INV-3): register the runtime-dropped delta — the packages the
 * build-time glob could never see — from `GET /api/processors/packages`.
 *
 * Called from an AUTHENTICATED context only (`workbench/module.tsx`'s `routerEffects`
 * effect), because the endpoint is gated by `projects::use`.
 *
 * Runs EXACTLY ONCE per page session, latched BEFORE the await so React's
 * double-invoked effects / a re-render / an in-place account switch can't issue a second
 * fetch or double-register the delta. It is deliberately never un-latched: unlike
 * `datatypes` (whose lattice carries per-account viewers/capabilities), the served package
 * set is deployment-wide DATA — identical for every user — so there is nothing to re-scope
 * on logout, and the registry has no removal path anyway.
 *
 * Never throws: `loadRuntimeProcessors` already swallows its own fetch failure (the baked
 * baseline rendered at module eval); only per-item load errors are reported.
 */
export async function loadRuntimeProcessorsOnce(
  registry: Contributions = defaultRegistry,
): Promise<void> {
  if (isRuntimeLoaded()) return
  markRuntimeLoaded()
  const res = await loadRuntimeProcessors(registry, bakedIds())
  for (const e of res.errors) {
    // eslint-disable-next-line no-console
    console.error(`[workbench] runtime processor "${e.package}" ${e.path}: ${e.message}`)
  }
}

/** Test-only reset of the load guards (mirrors the discovery-guard reset pattern). */
export function __resetLoadedForTests(): void {
  const g = globalThis as unknown as Record<string, unknown>
  g[G_KEY] = undefined
  g[G_RUNTIME_KEY] = undefined
  g[G_BAKED_KEY] = undefined
}
