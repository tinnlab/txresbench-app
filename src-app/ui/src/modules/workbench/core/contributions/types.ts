// The contribution descriptor types (ITEM-4/5/6) — the typed entries the THREE
// registries hold. Everything an extension declares is one of these; the shell
// renders/dispatches whatever is registered (§1). The LLM-facing metadata on the
// base type (§0.4.2) makes ONE declaration serve three surfaces — the human UI,
// the MCP tool, and the programmatic API.
//
// The set SHRANK to three (ITEM-33/34/35). Deleted, each with ZERO production
// contributors and a consumer that lived somewhere else entirely:
//   · `selectionActions` (ITEM-9)   — went with the workbench selection feature.
//   · `plotTypes`        (ITEM-34)  — canvas decides what plot types it supports, not an
//     extension; the REAL registry is `@ziee/viz`'s `registerChartType`/`installBuiltins()`,
//     which lives WITH the canvas. Its descriptor could not even type its own `render`
//     payload (`unknown // deck.gl layer factory — P7-owned shape, opaque here`) — the
//     tell that the owner was elsewhere. DEC-L took `core/conformance/` with it (that
//     subtree declared itself "the `plotTypes` contribution point's backing store" and
//     `registerViewKind` had zero production callers of its own).
//   · `fieldProviders`   (ITEM-33)  — its only contributor was the deleted
//     `processor-packages/single-cell`; its only consumer was `docks/LeftVisualizeDock`.
//     Declarative colouring is unaffected (the shipping specs encode it as
//     `valueKey`/`groupKey`/`colorBy` in their own `view_spec`).
//   · `resultRenderers`  (ITEM-35)  — 0 contributors; `ArtifactPanel` now dispatches purely
//     through `defaultForKind` (StatCard / ProvenanceView / the universal GenericResult).
//   · `commands`         (ITEM-35)  — 0 contributors, 0 direct readers. The workbench
//     command palette runs on `defineAction`, not this registry.
//   · `collections`      (ITEM-35)  — 0 contributors; the BE surface its own header
//     deferred to never landed, and its single reader was test-only.

import type { ComponentType, ReactNode } from 'react'
import type { DraftableSpec } from '@/api-client/types'
import type { TypeSelector } from '../datatypes/types.ts'
import type { WhenClause } from '../datatypes/when.ts'
import type { ViewSpec as DeclarativeViewSpec } from '../manifest/viewSpec.ts'

/** The tool-approval / mutation posture that maps to the app's MCP annotations
 *  + approval flow (§0.4.2): read/run auto-approved, mutating/destructive gated. */
export type Safety = 'read-run' | 'mutating' | 'destructive'

/** The default safety posture for a contribution KIND when the author omits one
 *  (single source of truth, consumed by the MCP projection): an analysis is read-run.
 *  ITEM-35 removed the second kind (`command`) with the commands registry. */
export function defaultSafety(_kind: 'analysis'): Safety {
  return 'read-run'
}

/** Cross-cutting base carried by EVERY contribution (§1). The `description` /
 *  `whenHint` / `examples` are LLM-facing AND human-facing — one set (§0.4.2);
 *  P9's generator projects them into MCP tools, P5 only declares them. */
export interface Contribution {
  /** namespaced, e.g. `<extension>.<name>` */
  id: string
  extensionId: string
  /** the workbench-api semver range this contribution was authored against. */
  apiVersion: string
  title: string
  icon?: ReactNode
  category?: string
  order?: number
  /** visibility/activation gate over the artifact catalog. */
  when?: WhenClause
  // --- LLM-facing declaration (§0.4.2) — same strings power the human form help ---
  /** one-line "what it does" → the MCP tool description. */
  description?: string
  /** NL routing hint → the LLM's "when should I use this" signal. */
  whenHint?: string
  /** few-shot example utterances. */
  examples?: string[]
  /** approval posture; when omitted the projection back-fills `defaultSafety(kind)`
   *  (read-run for analyses/commands). */
  safety?: Safety
  /** opt a contribution OUT of the LLM surface. Only the AI-facing kind (`analyses`)
   *  is projected to tools at all — views/status-bar items are never projected
   *  regardless of this flag — so `ai` only matters there, where it defaults to
   *  `true` (exposed). */
  ai?: boolean
}

export type AnalysisCategory = string

export interface ScheduleSpec {
  class: 'interactive' | 'normal' | 'batch'
  resources?: { cpu?: number; mem?: string; gpu?: number }
}

/** How an analysis's compute runs (§4.1). Path-agnostic + content-addressable by
 *  construction (a run is a provenance node). `sandbox` = a script in bwrap;
 *  `builtin` = an in-host pure fn (instant ops that aren't jobs, §4.1.1 Tier-0).
 *  `runtime` selects the entry filename + interpreter (the backend `Language`,
 *  `sandbox/spec.rs`): `python`/`rscript` for compute/QC, `bash` for CLI-glue
 *  orchestration processors (Cell Ranger, bcl-convert) — a bash entry still writes
 *  the typed `/outputs/manifest.json` (ITEM-5b / DEC-10). */
export type RunSpec =
  | {
      kind: 'sandbox'
      runtime: 'python' | 'rscript' | 'bash'
      entry: string
      timeout?: number
      // `run.inputs` IS ABSENT ON PURPOSE. It declared a per-slot mount FILENAME so a
      // compute could sniff its input's format off the suffix. Two changes killed it:
      // the runner now DERIVES every artifact mount name from the artifact itself, and
      // the computes resolve by SLOT with no filename fallback. It is also a removed key
      // (DEC-3), so a manifest declaring it fails to load — meaning this field could only
      // ever have been `undefined` in production, and its one reader in `jobsCapability`
      // was unreachable code. INV-1 inverted: not a key nothing reads, but code nothing
      // can reach.
    }
  | { kind: 'builtin'; fn: string }

/** ITEM-5 — the headline contribution point.
 *
 *  This declares what the workbench needs to LOAD, ENABLE and EXECUTE an analysis —
 *  and nothing else (INV-1). It carries no labels, help text, field order or form
 *  schema (the view owns those, INV-2), no domain data, and no forecast of the
 *  columns a run will produce (those are read from the artifacts, INV-5). */
export interface AnalysisContribution<P = Record<string, unknown>> extends Contribution {
  category: AnalysisCategory
  /** What this analysis APPLIES TO — a fact about the analysis ("this one applies to
   *  raw-count matrices"), from which availability is DERIVED. Replaces
   *  `accepts` + `when` + `params.fields`.
   *
   *  Every entry is required by definition, so there is no per-entry `required`
   *  flag: an OPTIONAL input was never an applicability condition. It belongs in
   *  `consumes` (a graph edge) or in the view (an offered control) — DEC-5.
   *
   *  It does NOT define what the UI offers. A view declares its own picker source
   *  and may offer a narrower set, or a selection this key cannot express at all
   *  (a column WITHIN an artifact depends on another control's value). */
  appliesTo: TypeSelector[]
  /** Datatypes this analysis READS but does not require to be offered — the
   *  producer→consumer edge `chaining.ts` uses to say "run the upstream analysis
   *  first". Previously smuggled as an `accepts` entry with `required: false`,
   *  which made one key mean two things (DEC-5). Never an availability input. */
  consumes?: string[]
  /** produced datatype ids (P2 subtyping; no closed `Kind` enum — DEC-4). The WHOLE
   *  output contract: an analysis may emit whatever columns it likes, and what it
   *  owes the workbench is that their DATATYPE is listed here. The type of each
   *  actual column is read from the artifact that landed — a fact the conformance
   *  gate verifies — never from a forecast written before the data existed. */
  produces: string[]
  /** The view files this analysis renders, in order. The manifest names the FILES;
   *  it says nothing about their contents (the same relationship it has with
   *  `run.entry`, which names a script without describing it).
   *
   *  MULTIPLE files render into ONE pane, stacked top to bottom (INV-3). That is
   *  ENFORCED, not merely intended: `registerDeclarativeViews` turns this whole list
   *  into a SINGLE `ViewContribution` keyed on the ANALYSIS id
   *  (`runtime/seam.ts::viewSpecsToContribution`), so a second entry appends widgets to
   *  the existing pane and cannot mint a second one. It read as a claim for a while and
   *  was not one: the seam keyed panes on the FILE, so two entries meant two tabs, and
   *  every shipped analysis declared exactly one file.
   *
   *  A listed file that is missing or unparseable takes this analysis' WHOLE pane down
   *  (fail-closed — half a form is not a form); sibling analyses are unaffected.
   *
   *  Omitted ⇒ no view ⇒ the generic fallback form built from `appliesTo` — an explicit
   *  declared state, not the accident of an empty directory. */
  ui?: string[]
  run: RunSpec
  schedule?: ScheduleSpec
  /** CPU-arch compatibility (ITEM-26 / DEC-29) — the arches this processor can
   *  run on, e.g. `['x86_64','aarch64']` or `['x86_64']`. **Omitted / empty ⇒ all
   *  arches** (existing processors are unaffected). The `computeAvailabilityWithArch`
   *  lens marks a processor whose `arch` excludes the backend arch as
   *  not-runnable (with a reason) but STILL LISTED (disabled, not hidden). No
   *  emulation — an x86-only tool is never run on aarch64. */
  arch?: string[]
  /** ITEM-16 / DEC-4 — whether this analysis appears in the user-facing analysis
   *  LAUNCHER. **Omitted ⇒ `true`** (a real, user-launchable analysis). Set `false`
   *  for demos / dogfood contributions that stay REGISTERED (still resolvable by id,
   *  still AI/test-reachable) but must not clutter the production launcher — the pure
   *  launcher filter (`isLauncherVisible`) drops them without unregistering. */
  launchable?: boolean
  /** ITEM-16 / DEC-4 — a NON-launch invocation trigger, mirroring the backend
   *  manifests' `trigger`. `on-ingest` marks a CONVERTER (a package-declared
   *  format converter) that runs as part of dataset ingest — not something a user
   *  launches — so the launcher filter excludes any analysis carrying it. Left open
   *  (`on-integrate` / a future string) so new trigger classes don't break the type. */
  trigger?: 'on-ingest' | 'on-integrate' | string
  /** provenance / methods-paragraph text. */
  methodsText?: (p: P) => string
  /** The `draftable` block (draftable-entity ITEM-9) — present when this analysis is a
   *  DRAFTABLE editor whose `$state` binds to a project-scoped `drafts` row (ITEM-8). The
   *  mount (`DeclarativeRegion`) reads it to seed `$state` from `draft.data` +
   *  debounce-persist edits. Opaque, package-owned strings the core carries but never
   *  interprets (`kind`/`freeze`/`edit`/`freeze_on`); absent for every ordinary analysis. */
  draftable?: DraftableSpec
  //
  // REMOVED (INV-1). Each was measured against the shipped tree before deletion:
  //   `params`        — a FORM SCHEMA (title/doc/type) wrapping a copy of `accepts`;
  //                     its only non-redundant content was the slot name.
  //   `defaults`      — a second implementation of a fallback the compute already
  //                     owns at the one boundary where a value can be absent
  //                     (`params.json`); it could only ever disagree.
  //   `when`          — a weaker restatement of `accepts` that could never
  //                     independently fail (`computeAvailability` already fails an
  //                     unmatched required selector).
  //   `produces_annotations` — an unverified forecast of columns, undeclarable in the
  //                     general case (the generic integrate converter emits one per column
  //                     of a user-supplied table) and wrong in both directions on real data.
  //   `run.inputs`    — a mount FILENAME, so a compute could sniff its format off a
  //                     suffix. Format is a property of the artifact; the runner names
  //                     the mount from what it is mounting (ITEM-23).
  //   `schedule.resources` — read by nothing (`jobsCapability` rebuilds the spec as
  //                     `{ class }`); real limits are the singleton sandbox settings.
  //   `inStandardRecipe` / `recipeOrder` — zero consumers in either language.
  //
  // A manifest still carrying any of them FAILS TO LOAD, naming the package and the
  // key (DEC-3) — viable because every shipped package migrated in the same change.
}

export type ViewArea = 'left' | 'right' | 'bottom' | 'center'
export type ViewSpec = { component: string } | { iframe: string } | { spec: unknown }

/** ONE PARSED declarative view file plus the per-instance `view_id` its store, actions
 *  and resolved data slices bind to.
 *
 *  Defined HERE — beside the contribution descriptors that carry it — rather than in
 *  `runtime/seam.ts`, because it is now the payload of TWO contribution kinds (a
 *  `ViewContribution`'s declarative pane and a `SectionContribution`'s stack). `seam.ts`
 *  re-exports it, so its existing importers are unchanged. Two structurally-identical
 *  interfaces under two names is the drift this avoids. */
export interface DeclarativeView {
  view_spec: DeclarativeViewSpec
  view_id: string
}

/** ITEM-6 — a panel/tab in a dock (§1.1). */
export interface ViewContribution extends Contribution {
  area: ViewArea
  render: ViewSpec | { component: ComponentType<Record<string, never>> }
}

/** ITEM-1 — a VISUALIZE-PANE SECTION: a declarative block in one pane's single scroll
 *  track (§4.2). Its own contribution kind, deliberately NOT a `ViewContribution`:
 *  it registers into `registry.sections`, so it never reaches `placeViews`,
 *  `reconcileViews`, `viewAutomountGate` or `assertContributableArea`, and the centre
 *  reservation is unreachable from this path by construction. It names a `pane`, never
 *  an `area`/`region`/`role` — a section never docks and never opens a pane.
 *
 *  The base `order` is the PACKAGE's default position in the stack; the user's own
 *  saved section order wins where it names this section. */
export interface SectionContribution extends Contribution {
  /** WHICH pane's stack this section joins (e.g. `visualize`). */
  pane: string
  /** whether the section starts collapsed (default `false` — expanded). */
  collapsed?: boolean
  /** what KIND of data this section applies to — whether it is LISTED at all
   *  (`computeAvailability` reads exactly this field). **Never a producer** (INV-18):
   *  both Rust parsers refuse a selector naming an analysis / package / processor /
   *  `consumes` / `slot`, so the rule cannot be broken by declaration. */
  appliesTo?: TypeSelector[]
  /** the declarative view-spec files this section renders, in order, relative to the
   *  package folder — one `DeclarativeRegion` each. Carried verbatim from the manifest;
   *  parsing them into specs is the loader's job (ITEM-2). */
  ui?: string[]
  /** the PARSED specs those files became, in the SAME order — one `DeclarativeRegion`
   *  each (ITEM-2/ITEM-3). Required, and never empty: the loader parses the whole `ui:`
   *  list fail-CLOSED and registers nothing for a section any of whose files failed, so a
   *  REGISTERED section always has its complete stack. Half a section is not a section. */
  views: DeclarativeView[]
}

/** which cluster a status-bar item sits in: `start` (left) or `end` (right, after the
 *  flex spacer). */
export type StatusBarSide = 'start' | 'end'

/** A status-bar indicator (the workbench bottom status strip). An extension contributes a
 *  small live indicator; the shell (`WorkbenchStatusBar`) renders it in the `side` cluster,
 *  `order`-sorted (the base `order`). The rendered component takes NO props — it reads its
 *  own live signal (via `useWorkbench()` / a store), mirroring `ViewContribution`'s inline-
 *  component variant — so contributing an indicator never means editing the status bar. */
export interface StatusBarItemContribution extends Contribution {
  /** which cluster the item sits in (default `start`). */
  side?: StatusBarSide
  /** the zero-prop indicator component the shell mounts (rendered directly with a React
   *  `key`, so a permissive `ComponentType` rather than `<Record<string, never>>`). */
  render: ComponentType
}
