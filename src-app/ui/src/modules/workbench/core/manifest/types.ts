// The `extension.yaml` manifest TYPE (ITEM-14). The host indexes an extension
// from this WITHOUT executing its code (§3); contributions appear gated-by-
// `when`/`requires` from the manifest alone, and lazy code refs (`run` / a
// `component` / a `ParamsForm`) activate on `activation` events. The manifest
// schema is itself a versioned, published contract (mirrored to `schema.json`).
// Forward-compatible: the `contributes` keys the BE provisioners consume in
// slice-2 (`settings`/`jobs`/`artifactKinds`/`sidecar`) are declared now so the
// contract does not change when they land.
//
// ITEM-33/34/35 removed the five manifest keys whose registry slots were deleted
// (`plotTypes`/`fieldProviders`/`resultRenderers`/`commands`/`collections`). They are
// now UNKNOWN keys: `validateManifest` rejects a manifest that declares one, which is
// the intended contract — an extension may not declare a contribution the host has no
// registry for. `collections` went too, despite being a slice-2 BE key, because its
// registry slot was one of the five (the BE surface never landed).

export interface ManifestAnalysis {
  id: string
  category?: string
  accepts?: unknown[]
  produces?: string[]
  //
  // No `produces_annotations`. Naming each output column and its type before any run
  // existed was an unverified forecast (INV-5); what a run actually produced is read from
  // the artifacts it emitted. `produces` (WHICH datatype) is the whole output contract.
  params?: string // a path to the params JSON-schema
  run?: { kind: 'sandbox' | 'builtin'; runtime?: string; entry?: string; timeout?: number; fn?: string }
  description?: string
  when?: string
  examples?: string[]
  safety?: 'read-run' | 'mutating' | 'destructive'
  ai?: boolean
}

export interface ManifestView {
  id: string
  area: 'left' | 'right' | 'bottom' | 'center'
  title: string
  when?: string
  component?: string
  iframe?: string
}

/** ONE `contributes.sections[]` entry — a declarative block in a pane's stack
 *  (ITEM-1). Mirrors Rust `SectionContribution`. A section is NOT a view: it names a
 *  `pane`, never an `area`/`region`/`role`, and it never docks. */
export interface ManifestSection {
  id: string
  title: string
  /** WHICH pane's stack this section joins (e.g. `visualize`). */
  pane: string
  /** the package's DEFAULT position in the stack, ascending. */
  order?: number
  collapsed?: boolean
  /** what KIND of data the section applies to — never a producer (INV-18). */
  applies_to?: SectionSelector[]
  /** the declarative view-spec files it renders, relative to the package folder. */
  ui?: string[]
}

/** A section's `applies_to[]` entry (INV-18) — the LISTING subset of `TypeSelector`.
 *  `slot` is deliberately absent: it is an input-slot key, and naming an input is one
 *  way of naming a producer. Both Rust parsers refuse it. */
export interface SectionSelector {
  type_id?: string | null
  subtypes_of?: string | null
  capabilities?: string[]
  excludes?: string[] | null
}

export interface ManifestContributes {
  analyses?: ManifestAnalysis[]
  sections?: ManifestSection[]
  views?: ManifestView[]
  // --- declarative-backend keys consumed by the BE provisioners (slice-2) ---
  settings?: Array<{ id: string; schema: string; scope?: string; gate?: string }>
  jobs?: Array<{ id: string; cron?: string; trigger?: string; run: unknown }>
  artifactKinds?: Array<{ id: string; layout: string }>
  sidecar?: { image?: string; entry?: string }
}

export interface ExtensionManifest {
  id: string
  name: string
  publisher?: string
  version: string
  /** semver RANGE compatible with the host `WORKBENCH_API_VERSION`. */
  apiVersion: string
  /** lazy activation events (`onAnalysis:x`, `onView:y`). */
  activation?: string[]
  /** built-in load-order dependencies (topo-sorted by the discovery loader). */
  dependencies?: string[]
  contributes: ManifestContributes
}
