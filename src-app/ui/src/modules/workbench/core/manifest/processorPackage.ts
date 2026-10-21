// The `packages/<name>/` DATA-PACKAGE contract (ITEM-3/ITEM-23, DEC-22). A processor
// ships as a self-contained DATA package — `manifest.yaml` (the analysis contribution as
// DATA) + `ui/*.yaml` (the declarative `view_spec`) + `compute/` — and the ONE generic
// `loadProcessors.ts` registers it. This REPLACES the old per-analysis
// `builtins/<name>/extension.ts` compiled-code discovery (INV-6: NO processor-specific
// code in the workbench).
//
// STRICT-JSON, function-free (mirrors `./types.ts` + `./viewSpec.ts`): a processor package
// cannot ship a JS closure / a React component. The only DELTA from the runtime
// `AnalysisContribution` (`../contributions/types.ts`) is the fields that MUST NOT be a
// function — `icon` (a `ReactNode`) is omitted entirely, and `methodsText` becomes an
// optional TEMPLATE STRING (`$`-interpolated over params by the loader), never a `(p)=>string`
// closure. Everything else is the SAME field names the FE `AnalysisContribution` uses
// (`accepts`/`produces`/`params`/`defaults`/`run`/…), so the loader's builder is a faithful,
// near-verbatim projection (Patterns: "registered exactly as `extension.ts` did, sourced from
// DATA").

import type { DraftableSpec } from '@/api-client/types'

/** The JSON-DATA form of an `AnalysisContribution` (`../contributions/types.ts`) — the same
 *  field names, minus the two non-serializable ones (`icon`; `methodsText` → template string).
 *  The loader fills `extensionId` (from the manifest id) + `apiVersion` (from
 *  `WORKBENCH_API_VERSION`) at registration. Structurally open where the runtime type carries
 *  richer nominal types (`accepts`/`params`/`when`) — those are validated by the SAME downstream
 *  code the imperative path used (the loader does not re-type them here). */
export interface ProcessorAnalysisData {
  id: string
  category: string
  title: string
  description?: string
  whenHint?: string
  examples?: string[]
  safety?: 'read-run' | 'mutating' | 'destructive'
  ai?: boolean
  order?: number
  /** What the analysis APPLIES TO (`TypeSelector[]` DATA) — every entry required, so no
   *  per-entry `required` flag. Availability is derived from it; it does NOT define what
   *  the UI offers (INV-2). */
  appliesTo: unknown[]
  /** Datatypes read but not required — the chaining graph edge, never an availability input. */
  consumes?: string[]
  /** produced datatype ids. */
  produces: string[]
  /** The view files this analysis renders, in order; multiple stack into ONE pane (INV-3) —
   *  the whole list becomes a SINGLE `ViewContribution` keyed on this analysis' id
   *  (`runtime/register.ts` → `runtime/seam.ts::viewSpecsToContribution`).
   *  Omitted ⇒ no view ⇒ the generic fallback form. Paths are package-relative
   *  (`ui/qc.yaml`) and must exist — a missing one is a LOUD load error that drops this
   *  analysis' pane entirely rather than rendering a shorter form. */
  ui?: string[]
  run: {
    kind: 'sandbox' | 'builtin'
    runtime?: 'python' | 'rscript' | 'bash'
    entry?: string
    timeout?: number
    fn?: string
  }
  schedule?: { class: 'interactive' | 'normal' | 'batch' }
  arch?: string[]
  /** omitted ⇒ launchable; `false` keeps it registered-but-not-in-launcher. */
  launchable?: boolean
  /** a non-launch trigger (`on-ingest` for a converter) — launcher-excluded, resolvable by id. */
  trigger?: 'on-ingest' | 'on-integrate' | string
  /** a methods-paragraph TEMPLATE STRING (`$`-interpolated over the run params), NOT a closure
   *  (INV-1). The loader wraps it into the `AnalysisContribution.methodsText(p)` fn. */
  methodsText?: string
  /** The `draftable` block (draftable-entity ITEM-9) — present when this analysis is a
   *  DRAFTABLE editor: `$state` binds to a project-scoped `drafts` row's opaque `data`, and
   *  the mount seeds `$state` from `draft.data` + debounce-persists edits (ITEM-8). Opaque,
   *  package-owned strings the core carries but never interprets (`kind`/`freeze`/`edit`/
   *  `freeze_on`). Absent for every ordinary analysis. */
  draftable?: DraftableSpec
}

/** The JSON-DATA form of a `SectionContribution` (`../contributions/types.ts`) — ONE
 *  `contributes.sections[]` entry as the manifest spells it (ITEM-1/ITEM-2).
 *
 *  The field names are the MANIFEST's, not the runtime contribution's: `applies_to`
 *  (snake) here, `appliesTo` (camel) there, because this mirrors the Rust
 *  `SectionContribution` byte for byte — one wire shape, two readers, and the loader
 *  (`runtime/seam.ts::sectionToContribution`) is the single place that translates. The
 *  divergence from the sibling `ProcessorAnalysisData` (which is camelCase throughout) is
 *  the analysis DATA's, not this one's: the analysis half was authored FE-first, the
 *  section half manifest-first, and the manifest is the contract a package author writes.
 *
 *  `ui:` names FILES; parsing them is the loader's job, and a listed file that is missing
 *  or unparseable takes the WHOLE section down (fail-closed). */
export interface ProcessorSectionData {
  id: string
  title: string
  /** WHICH pane's stack this section joins (e.g. `visualize`) — never an area/region/role. */
  pane: string
  /** the package's DEFAULT position in the stack, ascending. */
  order?: number
  collapsed?: boolean
  /** the LISTING subset of a `TypeSelector` — never a producer (INV-18). Structurally
   *  open here for the same reason `ProcessorAnalysisData.appliesTo` is: the two Rust
   *  parsers are the gate that REFUSES a producer-naming key, and re-typing it here would
   *  be a second, weaker copy of that gate. */
  applies_to?: unknown[]
  /** the declarative view-spec files it renders, in order, package-relative. */
  ui?: string[]
}

/** The DATA `manifest.yaml` a processor package ships. Mirrors `ExtensionManifest`'s identity
 *  fields (`../manifest/types.ts`) but carries the FE analysis contribution(s) as DATA under
 *  `contributes.analyses` — the loader registers each into `workbenchRegistry.analyses`
 *  (ITEM-23). `dependencies` drives the topo-sorted load order (same as the old glob loader). */
export interface ProcessorManifestData {
  id: string
  name: string
  publisher?: string
  version: string
  /** semver RANGE compatible with the host `WORKBENCH_API_VERSION`. */
  apiVersion: string
  activation?: string[]
  dependencies?: string[]
  contributes?: {
    analyses?: ProcessorAnalysisData[]
    /** Visualize-pane SECTIONS (ITEM-1/ITEM-2). Registered into `workbenchRegistry.sections`
     *  — never `views` — so a section can never reach the docking/placement path. */
    sections?: ProcessorSectionData[]
  }
}

/** A discovered processor package as DATA: the parsed `manifest.yaml` + every parsed `ui/*.yaml`
 *  view_spec (already YAML/JSON-decoded — the loader validates each LOUD via `parseViewSpec`). */
export interface ProcessorPackage {
  manifest: ProcessorManifestData
  /** each `ui/*.yaml` view_spec, decoded but NOT yet validated, KEYED by its
   *  package-relative path (`ui/qc.yaml`).
   *
   *  A path-keyed map, not an array: an analysis declares `ui: [ui/a.yaml,
   *  ui/b.yaml]` and the loader must resolve exactly those files IN THAT ORDER
   *  (INV-3 — they stack top to bottom in one pane). An array carries no identity,
   *  so ordering would fall back to whatever the glob happened to enumerate and a
   *  file could not be attributed to the analysis that declared it. */
  views: Record<string, unknown>
}
