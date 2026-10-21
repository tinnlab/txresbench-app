// Declarative-view REGISTRATION (PLAN.md ITEM-9 / ITEM-15). Turns an ANALYSIS' declared view
// files into live workbench state: validate each, register each one's declared actions into the
// `defineAction` registry (so human + AI drive the same verbs), install the widget renderers,
// and register the ONE `ViewContribution` the analysis becomes (`seam.ts`) through the public
// `workbenchRegistry` — riding the SAME placement machinery any `ViewContribution` does.
//
// The unit here is the ANALYSIS, not the file (INV-3: one analysis renders into ONE pane, its
// files stacked top to bottom in declaration order). That is also why the fail-closed boundary
// moved out one level: see `registerDeclarativeViews`.
//
// The `view_spec` SOURCE is the processor bundle's YAML (`packages/<id>/ui/<view>.yaml`,
// DEC-11), named by the analysis' `ui:` list. This helper is the FE consumer: an extension-load
// path parses that YAML → this registers it.

import { type Contributions, type WhenClause } from '@/modules/workbench/core'
import type { ViewSpec as DeclViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import { registerViewSpecActions } from './interpreter'
import { installBuiltinWidgets } from '@/modules/workbench/extensions'
import { sectionToContribution, viewSpecsToContribution, type DeclarativeView } from './seam'
import type { ProcessorSectionData } from '@/modules/workbench/core/manifest/processorPackage'

export interface RegisterDeclarativeViewsOptions {
  extensionId: string
  /** the pane's tab title — the ANALYSIS' title. */
  title: string
  /** the availability `when` gate the contribution carries. */
  when?: WhenClause
}

/** ONE raw (YAML/JSON-decoded) view file + the package-relative path it came from. The path is
 *  carried so a parse error can name the FILE the author has to open. */
export interface RawDeclarativeView {
  path: string
  raw: unknown
}

export interface RegisterResult {
  ok: boolean
  errors?: { path: string; message: string }[]
  /** the registered contribution ids — at most ONE per analysis since INV-3 (a list, because
   *  the loader concatenates across the package's analyses). Empty on a parse failure. */
  contributionIds: string[]
}

/** The per-instance `view_id` a file's store/actions/data bind to: its own declared spec id,
 *  which is unique per file and is what `registerViewSpecActions` already namespaces on. */
const viewIdOf = (spec: DeclViewSpec): string => spec.id

/**
 * Parse ONE declared stack of raw view files — the half `registerDeclarativeViews` (an
 * analysis' pane) and `registerDeclarativeSection` (a Visualize section) share verbatim.
 *
 * Shared rather than copied because the fail-CLOSED rule is the part worth having exactly
 * once: errors accumulate across the WHOLE stack and are returned together, so an author
 * fixing a section sees every bad file at once instead of one per reload. The caller
 * decides what a non-empty `errors` means for ITS unit; this function never registers.
 */
function parseStack(files: RawDeclarativeView[]): {
  errors: { path: string; message: string }[]
  views: DeclarativeView[]
  specs: DeclViewSpec[]
} {
  // DEC-A: the widget-kind set is OPEN, so `parseViewSpec` accepts a core kind OR a
  // REGISTERED extension kind. The builtin renderers must therefore be installed BEFORE
  // validation, or a spec placing a canvas-owned plot kind would fail-closed on the first
  // registration. `installBuiltinWidgets` is idempotent, so the only change is that an
  // INVALID spec now also installs them (inert — every mount path installs them anyway).
  installBuiltinWidgets()

  const errors: { path: string; message: string }[] = []
  const views: DeclarativeView[] = []
  const specs: DeclViewSpec[] = []
  for (const file of files) {
    const parsed = parseViewSpec(file.raw)
    if (!parsed.ok || !parsed.value) {
      for (const e of parsed.errors ?? []) errors.push({ path: `${file.path} ${e.path}`, message: e.message })
      continue
    }
    specs.push(parsed.value)
    views.push({ view_spec: parsed.value, view_id: viewIdOf(parsed.value) })
  }
  return { errors, views, specs }
}

/**
 * Validate + register ONE ANALYSIS' declarative view files: every file's actions (into
 * `defineAction`) + widget renderers + the ONE `ViewContribution` the analysis becomes (into
 * `registry.views`).
 *
 * FAIL-CLOSED AT THE ANALYSIS, not the file. If ANY declared file fails to parse, NOTHING is
 * registered for this analysis and every error is returned. Registering the files that DID
 * parse would mount a pane missing a declared half of its own form — a Run button whose input
 * control silently isn't there is precisely the invisible-input failure INV-4 exists to remove,
 * and it would look like a rendered, working surface. The blast radius stays one analysis: the
 * caller keeps registering the package's other analyses.
 */
export function registerDeclarativeViews(
  analysisId: string,
  files: RawDeclarativeView[],
  registry: Contributions,
  opts: RegisterDeclarativeViewsOptions,
): RegisterResult {
  const { errors, views, specs } = parseStack(files)
  if (errors.length > 0) return { ok: false, errors, contributionIds: [] }
  if (views.length === 0) return { ok: true, contributionIds: [] }

  // Actions are registered only once the WHOLE stack parsed — a half-registered action set
  // would leave verbs live for a pane that never mounts.
  for (const spec of specs) registerViewSpecActions(spec)
  const contribution = viewSpecsToContribution(analysisId, views, {
    extensionId: opts.extensionId,
    title: opts.title,
    when: opts.when,
  })
  registry.views.register(contribution)
  return { ok: true, contributionIds: [contribution.id] }
}

/**
 * Validate + register ONE VISUALIZE SECTION (ITEM-2): its declared view files' actions
 * (into `defineAction`) + widget renderers + the ONE `SectionContribution` it becomes,
 * into **`registry.sections`** — never `registry.views`.
 *
 * That last clause is the item, not a detail. A section registered here is unreachable
 * from `placeViews` / `reconcileViews` / `viewAutomountGate` / `isViewAvailable` /
 * `assertContributableArea` / `ROLE_REGION` / the region stores / the dock, because none
 * of them reads this slot and a `SectionContribution` has no `area` to be placed by
 * (INV-12: "the centre reservation is unreachable from this path by construction").
 *
 * FAIL-CLOSED AT THE SECTION, exactly as the analysis path is fail-closed at the analysis:
 * if ANY declared file fails to parse, NOTHING is registered for this section and every
 * error is returned. The blast radius is one section — its siblings in the same package
 * still register, and the pane still renders without it. A section whose form is missing
 * half its controls would render as a working block that silently cannot answer.
 */
export function registerDeclarativeSection(
  data: ProcessorSectionData,
  files: RawDeclarativeView[],
  registry: Contributions,
  opts: { extensionId: string },
): RegisterResult {
  const { errors, views, specs } = parseStack(files)
  if (errors.length > 0) return { ok: false, errors, contributionIds: [] }
  if (views.length === 0) return { ok: true, contributionIds: [] }

  // Same ordering rule as the analysis path: verbs go live only once the WHOLE stack
  // parsed, so a section that never mounts leaves no callable actions behind.
  for (const spec of specs) registerViewSpecActions(spec)
  const contribution = sectionToContribution(data, views, { extensionId: opts.extensionId })
  registry.sections.register(contribution)
  return { ok: true, contributionIds: [contribution.id] }
}
