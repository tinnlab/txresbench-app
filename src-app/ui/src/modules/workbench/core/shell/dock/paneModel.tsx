// paneModel (ITEM-7) — the workbench's OWN pane-content model over the content-agnostic
// `@ziee/dock` layer. `@ziee/dock` treats panes as opaque ids; the workbench owns a
// `WorkbenchPane { id, kind, ref? }` map + a `paneRenderers` lookup (kind → component)
// with a VISIBLE fallback for an unknown kind (never a crash). Mirrors viz's `GridCell`
// ownership (viz `gridModel.ts`), but the content is dock PANES (canvas / analysis / …),
// not chart cells.
//
// The renderer REGISTRY is registration-based (like the shell's `registerViewComponent`):
// `paneModel.tsx` seeds every kind with the fallback (so the lookup is TOTAL from the
// first import — unit-safe, no heavy content graph) and `panes.tsx` overrides each kind
// with its real content at app boot (an import side-effect). So this module stays light
// (no dock/plot imports) and the lookup is always defined for every kind.

import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { ScrollArea, type ScrollAreaProps } from '@ziee/kit'
import { workbenchRegistry } from '@/modules/workbench/core'
import { getPaneState, type PaneEntity } from './paneState'
// The reserved WHOLE-GRID export subject id. Imported (not re-spelled) so the identity and its
// label can never drift apart; `paneSurfaceHost` is import-free, so this pulls in no graph.
import { GRID_EXPORT_SURFACE_ID } from '@/modules/workbench/core/shell/regions/paneSurfaceHost'

/** The pane kinds the workbench renders. `canvas`/`visualize` are the always-available shell
 *  surfaces; `launcher`/`run`/`artifact`/`history` are the analysis
 *  experience (W3) surfaces — `artifact` (singular) reviews ONE run's produced artifacts and is
 *  distinct from the plural `artifacts` project-detail panel below; `view` hosts a contributed
 *  `ViewContribution` (its `ref` is
 *  the view id); `jobs` is the project's operational job monitor (ITEM-67) and `lineage`
 *  the interactive artifact-lineage DAG (ITEM-61) — both project-scoped, ref-less;
 *  `rerun` re-runs a completed run pre-seeded + shows a before/after diff (its `ref` is
 *  the SOURCE run id) and `compare` compares N runs side-by-side (its `ref` is a
 *  comma-joined run-id list) — the W8 iteration loop (ITEM-63/65).
 *
 *  There was a third shell surface, `selection` (titled "Inspector"). ITEM-9 emptied it and kept
 *  the kind id alive "so persisted layouts keep resolving" — which left a live renderer,
 *  `<PlacedArea area="right"/>`, that was a SECOND window onto the right dock AREA and therefore
 *  showed every right-docked analysis twice. It is now RETIRED from the vocabulary; a persisted
 *  layout naming it is dropped by `defaultLayout.ts`'s `dropRetiredPanes`, which is the correct
 *  place for that concern. The right AREA is untouched. */
export type PaneKind =
  | 'visualize'
  | 'canvas'
  | 'launcher'
  | 'run'
  | 'artifact'
  | 'view'
  | 'jobs'
  | 'rerun'
  | 'compare'
  // HOSTED-SURFACE kinds (see `hostedSurface` below). One pane per OPEN surface in the centre
  // canvas grid: `edit-plot` hosts that plot's edit form, `data-table` its plotting-data
  // table, `export` the export dialog. Their `ref` is the surface's SUBJECT — the grid pane
  // the surface belongs to — so N plots' surfaces are N panes, never one shared pane that
  // retargets. `export` is the one whose subject may be the WHOLE GRID rather than a plot, in
  // which case its `ref` is viz's reserved `GRID_EXPORT_SURFACE_ID` sentinel.
  | 'edit-plot'
  | 'data-table'
  | 'export'
  // Project-detail surfaces promoted from standalone sections into panes (the project detail page is
  // now the full-bleed workbench): the project's datasets, produced artifacts, and reproducibility
  // (provenance). Each renders the SAME `detail_panels` component the section used, looked up from the
  // project-extension registry (so it stays permission-filtered) — see `panes.tsx`.
  | 'datasets'
  | 'artifacts'
  | 'reproducibility'

export const PANE_KINDS: readonly PaneKind[] = [
  'visualize',
  'canvas',
  'launcher',
  'run',
  'artifact',
  'view',
  'jobs',
  'rerun',
  'compare',
  'datasets',
  'artifacts',
  'reproducibility',
  'edit-plot',
  'data-table',
  'export',
] as const

/** A workbench pane: an opaque-to-`@ziee/dock` id, its content `kind`, and an optional
 *  `ref` binding (the analysis id for a `run` pane, the view id for a `view` pane, the
 *  artifact id for an `artifact` pane, …). */
export interface WorkbenchPane {
  readonly id: string
  readonly kind: PaneKind
  readonly ref?: string
}

/** Runtime guard for the `kind` union (a JS-authored / hydrated blob could smuggle an
 *  out-of-vocabulary kind — resolve it to the fallback rather than crash the render). */
export function isPaneKind(kind: string): kind is PaneKind {
  return (PANE_KINDS as readonly string[]).includes(kind)
}

/** Human title for a pane (the PaneFrame header + the drag ghost label). A `view`/`run`/
 *  `artifact` pane appends its `ref` (view/analysis/artifact id) for disambiguation. */
const KIND_TITLES: Record<PaneKind, string> = {
  visualize: 'Visualize',
  canvas: 'Canvas',
  launcher: 'Analyses',
  run: 'Run',
  artifact: 'Artifact',
  view: 'View',
  jobs: 'Jobs',
  rerun: 'Re-run',
  compare: 'Compare',
  datasets: 'Datasets',
  artifacts: 'Artifacts',
  reproducibility: 'Provenance',
  'edit-plot': 'Edit plot',
  'data-table': 'Plot data',
  export: 'Export',
}

/** What a WHOLE-GRID export pane's `ref` reads as on its tab. The ref itself must stay viz's
 *  reserved sentinel (it is the container key AND the pane identity — see
 *  `regions/paneSurfaceHost.ts`), so this is the one place it is turned back into words
 *  rather than printed raw. The wording is viz's own for that target. */
const GRID_EXPORT_SUBJECT_LABEL = 'Whole grid'
/** Human label for a pane KIND (no ref) — for the "add pane" menu. */
export function paneKindLabel(kind: PaneKind): string {
  return KIND_TITLES[kind] ?? kind
}

// ── A PANE'S SUBJECT IS DECLARED, NEVER INFERRED FROM ITS `ref` ──────────────────────────────
//
// `paneTitle` used to end `pane.ref ? `${base} · ${pane.ref}` : base` — i.e. it ASSUMED every
// kind's `ref` is something a person can read. Two kinds had already been carved out of that
// assumption by hand (`view` → its contributed title, whole-grid `export` → "Whole grid"), and
// every kind that had not was printing a machine id at the user: a `jobs` pane deep-linked by
// `revealPane('jobs', job.id)` read `Jobs · 3f2a1c8e-…`, and `rerun` / `artifact` / `compare`
// print run/artifact uuids the same way.
//
// Hand-carving the next one is not a fix, because the DEFAULT is what is wrong: a kind added
// tomorrow with an opaque ref regresses silently and nothing fails. So the default is inverted.
// A kind that wants its subject on the tab REGISTERS a resolver saying how to read one
// (`registerPaneRenderer(kind, …, { subject })`), exactly as it registers `entity`/`fullBleed`;
// a kind that registers none gets its base title alone, which is honest for every ref there is.
//
// The resolver is per KIND and lives at the registration for the same reason `entity` does: the
// shell must be able to name EVERY pane in the store, including the ones that are not their
// region's active tab and are therefore not rendered at all.

/** How a kind reads a human SUBJECT off a pane — `null` when this pane has none (yet). */
export type PaneSubjectResolver = (pane: WorkbenchPane) => string | null

const paneSubjectResolvers = new Map<PaneKind, PaneSubjectResolver>()

// A subject may be resolved from data that ARRIVES (a job's name lands on the next poll), so a
// title is not a pure function of the pane map and a tab strip cannot re-render on that map alone.
// This is the notification seam for that: the owner of a subject source calls
// `notifyPaneSubjectsChanged` when it learns something, and a component that draws titles
// subscribes ONCE with `usePaneSubjectEpoch` (one hook for the whole strip — never one per tab,
// which would make the hook COUNT depend on how many panes are open).
const subjectListeners = new Set<() => void>()
let subjectEpoch = 0

/** Announce that a registered subject resolver may now answer differently. */
export function notifyPaneSubjectsChanged(): void {
  subjectEpoch += 1
  for (const l of [...subjectListeners]) l()
}

function subscribePaneSubjects(cb: () => void): () => void {
  subjectListeners.add(cb)
  return () => {
    subjectListeners.delete(cb)
  }
}

/** Re-render this component when any pane's subject may have changed. */
export function usePaneSubjectEpoch(): number {
  return useSyncExternalStore(
    subscribePaneSubjects,
    () => subjectEpoch,
    () => subjectEpoch,
  )
}

/** This pane's subject per its kind's registered resolver. Total + non-throwing, like
 *  `resolvePaneEntity`: a resolver that trips over a malformed ref must not take the tab strip
 *  (and with it the shell) down. A blank answer is `null`, never `''`. */
export function resolvePaneSubject(pane: WorkbenchPane): string | null {
  const resolver = isPaneKind(pane.kind) ? paneSubjectResolvers.get(pane.kind) : undefined
  if (!resolver) return null
  try {
    const subject = resolver(pane)
    return typeof subject === 'string' && subject.trim() ? subject : null
  } catch {
    return null
  }
}

/**
 * A GENERATED identity, as opposed to text a person wrote: a uuid, anywhere in the string.
 *
 * `pane.ref` is a single field carrying whatever its kind puts there, so "this kind's ref is
 * readable" is a claim about the kind — and `authoredRefSubject` is where a kind makes it. This
 * predicate is the claim's backstop: if a ref that was supposed to be an authored slug turns up
 * carrying a uuid, the claim is wrong FOR THIS PANE and the subject is dropped rather than shown.
 * It is deliberately the ONE shape it can be sure about; a general "does this look opaque?"
 * heuristic would start blanking legitimate names.
 */
const GENERATED_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** A pane whose `ref` is itself authored, readable text — a slug the author wrote, not a
 *  generated id. `run` (an analysis id), `edit-plot`/`data-table` (a declaration's plot id).
 *  Declaring it per kind is the point: it is a CLAIM about that kind's ref, made where the kind
 *  is registered, and a kind that cannot make it gets its base title instead of a uuid. */
export const authoredRefSubject: PaneSubjectResolver = pane =>
  pane.ref && !GENERATED_ID.test(pane.ref) ? pane.ref : null

/** The subject resolver for a `view` pane: its contributed `ViewContribution`'s DECLARED human
 *  title (e.g. "Cell filter"). A view id IS authored text (`cell.filter::region::right`), so an
 *  unregistered contribution falls back to it rather than to nothing — unchanged behaviour, and
 *  the reason `view` is the one kind whose resolver can live here (the registry is core's). */
export const viewPaneSubject: PaneSubjectResolver = pane =>
  pane.ref ? (workbenchRegistry.views.get(pane.ref)?.title ?? authoredRefSubject(pane)) : null

/** The EXPORT pane's subject: the plot it exports, or viz's reserved whole-grid sentinel turned
 *  back into words (the sentinel is an identity, not a name). */
export const exportPaneSubject: PaneSubjectResolver = pane =>
  pane.ref === GRID_EXPORT_SURFACE_ID ? GRID_EXPORT_SUBJECT_LABEL : authoredRefSubject(pane)

export function paneTitle(pane: WorkbenchPane): string {
  const base = KIND_TITLES[pane.kind] ?? pane.kind
  // A `view` pane's title is its contribution's own, with no `View · ` prefix — a contributed
  // analysis is named by its author and the kind adds nothing to that.
  if (pane.kind === 'view') {
    const subject = resolvePaneSubject(pane)
    return subject ?? base
  }
  const subject = resolvePaneSubject(pane)
  return subject ? `${base} · ${subject}` : base
}

/** A pane content renderer — receives the pane it renders (the shell provides the
 *  `WorkbenchProvider` context around it). */
export type PaneRenderer = (props: { pane: WorkbenchPane }) => ReactNode

// ── THE PANE'S CONTENT INSET IS THE SHELL'S, ONCE — AND IT IS ON THE CONTENT ─────────────────
//
// It used to be nobody's: `RegionShell`'s `PaneBody` was layout-only, so every renderer picked
// its own. Measured across the pane renderers and the declarative render surfaces before this:
// `p-2`×14, `p-4`×6, `p-6`×4, `p-1`×1, plus assorted `px-*`/`py-*`. Nothing reconciled them, so
// each new pane picked a value and the drift re-created itself by construction.
//
// `p-2` (8px) is the value because it is what MOST panes already used (launcher, jobs, artifact,
// compare, provenance) and because a side region is 180–560px wide (`regionsPersistence.ts`,
// default 260/300): a 16px inset costs 18% of a minimum-width pane's usable width. It is on the
// 4px rhythm the design system states.
//
// ── WHERE IT LANDS (the correction) ─────────────────────────────────────────────────────────
//
// Moving the inset to the shell put it on the PANE BODY, which owned three things at once: the
// pane's outer box, the header bar, and the scroll viewport. All three were then inset, and all
// three were wrong for it:
//
//   · the SCROLL VIEWPORT — an overlayscrollbars bar is absolutely positioned against its host's
//     PADDING box, so an inset host draws the bar 8px short of the pane's edge, floating inside
//     the padding. Padding belongs to the scrollable CONTENT, never to the viewport.
//   · the HEADER BAR — a title bar's `border-b` then stopped 8px short at both ends and its
//     `bg-muted/40` never reached the pane's edges, so it read as floating chrome rather than as
//     the pane's header. (Its own `ps-3 pe-1.5` is the BAR's internal padding, not this inset.)
//   · the BODY had no way to state the gap BETWEEN the header and the content, because the one
//     inset it carried was outside the header, not under it.
//
// So the shell still owns exactly ONE value, and states WHERE it lands:
//
//     pane body      → NO inset at all; a full-bleed column of [header bar][content region]
//     header bar     → full-bleed, edge to edge (its own internal padding is its own)
//     content region → carries the inset, on all four sides. Its TOP side is the gap that clears
//                      the header's border; its bottom/left/right are the pane's content inset.
//     scroll track   → bleeds back OUT of the region's horizontal inset (`PaneScroll`) and
//                      re-applies it INSIDE the viewport, on the content. The bar is therefore
//                      at the pane's edge and the content is still inset.
//
// The region publishes the value as a CSS custom property (`--pane-inset`) precisely so the
// scroll track can bleed by exactly it without knowing the number — the value stays the shell's.
/** The ONE content inset, as a LENGTH. `0.5rem` = 8px = Tailwind `p-2` (the 4px rhythm). */
export const PANE_CONTENT_INSET = '0.5rem'
/** The custom property the pane's content region publishes `PANE_CONTENT_INSET` on, so a pane's
 *  own scroll track can bleed out of it (`PaneScroll`) without restating the number. */
export const PANE_INSET_VAR = '--pane-inset'
/** Kept for the gallery fixture frames that MODEL a pane (`DeclarativeFixtureStories`): the
 *  Tailwind spelling of `PANE_CONTENT_INSET`. Production reads the length, not this. */
export const PANE_CONTENT_PADDING = 'p-2'

/**
 * The kinds whose content is EDGE-TO-EDGE and must not be inset — declared HERE, at the
 * registration, rather than by each renderer re-adding padding around a full-bleed body (which
 * is the drift this replaces). `paneFullBleed` is seeded `false` for every kind, so a NEW pane
 * kind gets the shell's inset unless its registration opts out on purpose.
 */
const paneFullBleed: Record<PaneKind, boolean> = PANE_KINDS.reduce(
  (acc, kind) => {
    acc[kind] = false
    return acc
  },
  {} as Record<PaneKind, boolean>,
)

/**
 * The kinds whose BODY IS A FOREIGN SURFACE — a node another engine renders into, whose
 * OPEN/CLOSED state that engine owns. Declared here, at the registration, for the same reason
 * `fullBleed` is.
 *
 * ── THIS FLAG USED TO MAKE TWO CLAIMS. ONE OF THEM IS NOW FALSE. ────────────────────────────
 *
 * It meant, together: "the shell draws no header for this pane" AND "the shell must not close
 * this pane". Bundling them is how the pane came to have no title bar and no close at all.
 *
 *   · the HEADER claim is RETIRED. A hosted surface now renders the SHELL's pane header —
 *     same element, same title, same close, same full-bleed treatment as every other pane —
 *     and viz renders the surface HEADERLESS underneath it (`hosted` on `PaneEditForm` /
 *     `PlotDataTable`), so exactly one title is on screen and it is in the a11y tree once.
 *   · the LIFETIME claim STANDS, and it is all this flag means now: the pane is a PROJECTION
 *     of the surface being open, so a close that merely removed the pane would strand the
 *     surface open in a container attached to nothing — invisible, with its plot's toggle
 *     still lit. The shell's close is therefore DELEGATED to the surface's own close
 *     (`closeHostedSurface` → viz's registered `HostedSurfaceClose`), and the projection
 *     follows when the surface goes.
 *
 * The POP-OUT is still withheld, for the other reason entirely (`paneHasShellPopOut`): a
 * popped-out pane renders into another OS window's document, and this body is a node another
 * engine has already portaled a React tree into, in THIS document.
 */
const paneHostedSurface: Record<PaneKind, boolean> = PANE_KINDS.reduce(
  (acc, kind) => {
    acc[kind] = false
    return acc
  },
  {} as Record<PaneKind, boolean>,
)

/**
 * The ENTITY a pane of this kind is bound to, read off PANE-LIFETIME state (its `ref`, its
 * `paneState` entry) — or `null` when this particular pane names none (a `run::<runId>` review
 * is bound to no single artifact).
 *
 * Declared per KIND at the registration, like `fullBleed`/`hostedSurface`, because the binding
 * is a property of the PANE and the shell must be able to ask about every pane in the store —
 * including the ones that are not the active tab of their region and therefore are not rendered
 * at all. Registering it from inside the pane's own component instead is what made a background
 * tab unbindable; see `extensions/jobs/paneEntity.ts`.
 */
export type PaneEntityResolver = (pane: WorkbenchPane) => PaneEntity | null

export interface PaneRendererOptions {
  /** Render the pane's content edge-to-edge (no shell inset) — the canvas grid, and any
   *  surface whose content is a full-bleed viewport rather than a document. */
  fullBleed?: boolean
  /** This pane's body is a foreign surface that supplies its own frame and owns its own
   *  lifetime — see `paneHostedSurface` for what the shell therefore withholds. */
  hostedSurface?: boolean
  /** How a pane of this kind names the entity whose deletion must close it (ITEM-19).
   *  Omitted ⇒ this kind binds nothing and never self-closes. */
  entity?: PaneEntityResolver
  /** How a pane of this kind reads a human SUBJECT for its tab (see {@link PaneSubjectResolver}).
   *  Omitted ⇒ the tab shows the kind's title ALONE. That default is deliberate: a `ref` is an
   *  identity, and a kind that has not said how to turn its identity into words must not print
   *  the identity at the user. */
  subject?: PaneSubjectResolver
}

/** The per-kind entity resolvers (see {@link PaneEntityResolver}). Seeded EMPTY: a kind binds
 *  no entity unless its registration says how to read one off the pane's `ref`. */
const paneEntityResolvers = new Map<PaneKind, PaneEntityResolver>()

/** The entity `pane` is bound to, per its kind's registered resolver — `null` when the kind
 *  binds nothing, or when this ref names no single entity. Total + non-throwing: a resolver
 *  that throws on a malformed ref must not take the reconcile (or the shell) down with it. */
export function resolvePaneEntity(pane: WorkbenchPane): PaneEntity | null {
  const resolver = isPaneKind(pane.kind) ? paneEntityResolvers.get(pane.kind) : undefined
  if (!resolver) return null
  try {
    return resolver(pane)
  } catch {
    return null
  }
}

/** Does this kind's LIFETIME belong to a foreign surface (⇒ the shell's close must delegate)?
 *  Unknown kinds do NOT (the fallback note is the shell's own content, and an ordinary
 *  `removePane` is the right close for it). */
export function isPaneHostedSurface(kind: string): boolean {
  return isPaneKind(kind) ? paneHostedSurface[kind] : false
}

/** Is this kind declared full-bleed? Unknown kinds fall back to INSET (the fallback note is a
 *  document, not a viewport). */
export function isPaneFullBleed(kind: string): boolean {
  return isPaneKind(kind) ? paneFullBleed[kind] : false
}

/** The ONE content-inset class — empty for a declared full-bleed kind. Used by the gallery
 *  fixture frames that MODEL a pane; the shell itself uses `paneInsetStyle`. */
export function paneContentClass(kind: string): string {
  return isPaneFullBleed(kind) ? '' : PANE_CONTENT_PADDING
}

/**
 * The pane CONTENT REGION's inset, as the style the shell applies: the padding itself PLUS the
 * `--pane-inset` custom property a pane's own scroll track bleeds by (`PaneScroll`).
 *
 * Both come off the same length, so a change to the inset moves the padding and the bleed
 * together — they cannot be adjusted to different values, which is the whole reason the number
 * is published rather than restated.
 *
 * A full-bleed kind publishes `0px` rather than nothing: `PaneScroll` then computes a zero
 * bleed and a zero content pad, so it is byte-for-byte a plain `ScrollArea` there instead of
 * needing a second code path.
 */
export function paneInsetStyle(kind: string): CSSProperties {
  const inset = isPaneFullBleed(kind) ? '0px' : PANE_CONTENT_INSET
  return { [PANE_INSET_VAR]: inset, padding: inset } as CSSProperties
}

/** The VISIBLE fallback for an unknown / not-yet-registered kind (à la `ViewHost`'s
 *  unresolved-note): an honest empty state, NEVER a crash. */
export function FallbackPane({ pane }: { pane: WorkbenchPane }): ReactNode {
  return (
    <div
      data-testid={`workbench-pane-fallback-${pane.id}`}
      role="note"
      className="flex min-h-0 flex-1 items-center justify-center text-center text-sm text-muted-foreground"
    >
      No renderer registered for pane kind “{pane.kind}”.
    </div>
  )
}

// ── WHAT AN `artifact` PANE'S REF SAYS, AND WHICH ENTITY EACH KIND BINDS ────────────────────
//
// The pane KIND vocabulary is this module's (`PaneKind`), and this module already interprets a
// pane's `ref` per kind (`paneTitle` does it for `view` and `export`). The two resolvers below
// are the same kind of statement — "what does this kind's ref/state name?" — so they live here
// rather than in the panes that happen to render them.
//
// They must, in fact: `panes.tsx` registers them, and `core/` may never import `extensions/`
// (INV-8). Registering them from inside the pane COMPONENTS was the original arrangement and is
// exactly the defect — a region renders only its ACTIVE tab, so a binding created by a mount
// effect did not exist for any pane the user was not looking at.

export type ParsedArtifactRef =
  | { mode: 'artifact'; artifactKind: string; artifactId: string }
  | { mode: 'run'; runId: string }

/** Build an artifact pane `ref` for a whole run (ITEM-24/26 — the review of all outputs). */
export function runArtifactRef(runId: string): string {
  return `run::${runId}`
}

/** Parse an `artifact` pane's `ref` (`run::runId` OR `artifactKind::artifactId`). The
 *  single-artifact form is produced by the existing dock/self-close paths; the run
 *  form is produced by `runArtifactRef` (history reopen + run-complete review). */
export function parseArtifactRef(ref: string | undefined): ParsedArtifactRef | null {
  if (!ref) return null
  if (ref.startsWith('run::')) {
    const runId = ref.slice('run::'.length)
    return runId ? { mode: 'run', runId } : null
  }
  const idx = ref.indexOf('::')
  if (idx < 0) return null
  const artifactKind = ref.slice(0, idx)
  const artifactId = ref.slice(idx + 2)
  return artifactKind && artifactId ? { mode: 'artifact', artifactKind, artifactId } : null
}

// The `compare` pane's ref grammar lives here for the SAME reason `parseArtifactRef` does: it is
// a statement about what a KIND's ref names, `panes.tsx` registers the resolver that reads it,
// and `core/` may never import `extensions/` (INV-8). It also has to stay light — `panes.tsx`
// loads `MultiRunComparePane` through `lazy()`, so importing the grammar from that component
// would drag the compare pane (and its plot compare) back onto the boot path. Re-exported from
// `MultiRunComparePane` so this module stays the door its importers already knock on.

/** Build a compare pane `ref` — comma-joined run ids, order preserved, deduped. */
export function compareRef(runIds: string[]): string {
  return [...new Set(runIds.filter(Boolean))].join(',')
}
/** The run ids a compare pane's `ref` names (deduped, order preserved). */
export function parseCompareRef(ref: string | undefined): string[] {
  return ref ? [...new Set(ref.split(',').filter(Boolean))] : []
}

/**
 * An `artifact` pane's entity, read off its `ref`.
 *
 * A SINGLE-artifact pane (`<kind>::<artifactId>`) names one artifact. A `run::<runId>` review
 * names none: it reviews ALL of a run's outputs and outlives any one of them, so it must not
 * self-close when one goes — its own card list reloads instead.
 */
export const artifactPaneEntity: PaneEntityResolver = pane => {
  const parsed = parseArtifactRef(pane.ref)
  return parsed?.mode === 'artifact' ? { entity: 'artifact', id: parsed.artifactId } : null
}

/** The `paneState` key a `run` pane records the artifact its run PRODUCED under. */
export const RUN_PANE_ARTIFACT_KEY = 'artifactId'

/**
 * A `run` pane's entity — the artifact its run produced.
 *
 * Not derivable from the pane's `ref` (that is the ANALYSIS id), so the pane records it when the
 * review resolves. It goes into `paneState`, which is keyed by pane id, survives a tab switch /
 * pop-out / return, and is released by `clearPaneState` when the pane closes — i.e. it already
 * has exactly the lifetime a binding needs, where the render effect it replaces did not.
 */
export const runPaneEntity: PaneEntityResolver = pane => {
  const id = getPaneState(pane.id)?.[RUN_PANE_ARTIFACT_KEY]
  return typeof id === 'string' && id ? { entity: 'artifact', id } : null
}

/** The kind → renderer lookup, seeded TOTAL (every kind → fallback) so a lookup is always
 *  defined even before `panes.tsx` registers the real content. `registerPaneRenderer`
 *  (called at app boot) overrides each entry with its real renderer. */
export const paneRenderers: Record<PaneKind, PaneRenderer> = PANE_KINDS.reduce(
  (acc, kind) => {
    acc[kind] = FallbackPane
    return acc
  },
  {} as Record<PaneKind, PaneRenderer>,
)

/** Register (or replace) the renderer for a pane kind. Called by `panes.tsx` at boot.
 *  `opts.fullBleed` is the pane's content-inset OPT-OUT, declared per KIND here so it cannot
 *  drift back into the renderers. Omitting it re-asserts the default (inset), so a re-register
 *  can never silently inherit a previous registration's opt-out. */
export function registerPaneRenderer(
  kind: PaneKind,
  renderer: PaneRenderer,
  opts?: PaneRendererOptions,
): void {
  paneRenderers[kind] = renderer
  paneFullBleed[kind] = opts?.fullBleed === true
  paneHostedSurface[kind] = opts?.hostedSurface === true
  // Same re-assert-the-default rule as the two flags above: a re-registration that names no
  // resolver must not silently inherit the previous one's.
  if (opts?.entity) paneEntityResolvers.set(kind, opts.entity)
  else paneEntityResolvers.delete(kind)
  if (opts?.subject) paneSubjectResolvers.set(kind, opts.subject)
  else paneSubjectResolvers.delete(kind)
  // NO `notifyPaneSubjectsChanged()` here, and its absence is deliberate. The obvious guard —
  // "a re-registration may name panes differently, so tell the strips" — cannot fire: `panes.tsx`
  // calls `registerPanes()` as a top-level import side effect, and it is imported by
  // `WorkbenchDockHost`, so every registration completes before a strip has ever rendered. A
  // mutation deleting the call was killed by nothing (M7), which is what unreachable means.
  // A future registration that genuinely happens WHILE the shell is mounted is the caller's
  // announcement to make, through the exported `notifyPaneSubjectsChanged`.
}

/** Resolve a pane kind → its renderer, falling back VISIBLY (never a crash) for an
 *  unknown/unregistered kind. */
export function resolvePaneRenderer(kind: string): PaneRenderer {
  return isPaneKind(kind) ? paneRenderers[kind] : FallbackPane
}

// PaneScroll — a PANE'S OWN scroll track. The kit `ScrollArea`, placed correctly with respect to
// the pane's content inset.
//
// ── THE DEFECT IT REMOVES ───────────────────────────────────────────────────────────────────
//
// overlayscrollbars draws its bar as an absolutely-positioned child of the scroller's HOST
// (`.os-scrollbar-vertical { position:absolute; right:0 }`), and an absolutely-positioned box is
// laid out against its containing block's PADDING box. So any padding between the pane's edge and
// the scroll host puts the bar that many pixels inside the pane — floating, with a strip of pane
// to the right of it. When the shell became the single owner of the pane's inset it put that inset
// on the pane BODY, and the body contains the scroller: every pane's bar moved 8px inward.
//
// The rule is `paneModel`'s: **padding belongs to the scrollable CONTENT, not to the scroll
// viewport.** This component is that rule, expressed once:
//
//     host    → margin-inline: -(--pane-inset)   ⇒ the track spans the pane EDGE TO EDGE, so the
//                                                  bar is drawn at the pane's edge
//     content → padding-inline:  (--pane-inset)  ⇒ the text inside it sits exactly where the
//                                                  region's own inset would have put it
//
// so the visible content does not move by a pixel and only the bar does. The BLOCK axis is left to
// the content region (`paneInsetStyle`) deliberately: a vertical bar's placement is a horizontal
// fact, and bleeding vertically would collide with the pane's sibling bands — it would pull the
// track up under the header bar of a pane like `LauncherPane` (a pinned search box above a
// scrolling list) and down through the pinned run band of a declarative analysis pane.
//
// ── WHY IT CANNOT DOUBLE-APPLY ──────────────────────────────────────────────────────────────
//
// The content element RESETS `--pane-inset` to `0px` for its subtree. A `PaneScroll` nested inside
// another one (a log box, a bounded list) therefore computes a zero bleed and a zero content pad
// and is byte-for-byte a plain `ScrollArea`. The same fallback covers a `PaneScroll` rendered
// outside a pane entirely, and a `fullBleed` pane kind (whose region publishes `0px`). The inset
// is consumed exactly once, by the outermost track in a pane, without anyone tracking that.
//
// `--pane-track-inset` is the value SNAPSHOTTED on the host before the reset: the content element
// cannot read `--pane-inset` and reset it in the same declaration block (a custom property
// declared on an element applies to that element too, so the padding would resolve to the reset
// `0px`). One variable holds the value being applied, the other is the ambient one being consumed.

/** The snapshot of `--pane-inset` taken on the track's host — see the header. */
const TRACK_INSET_VAR = '--pane-track-inset'

const HOST_STYLE: CSSProperties = {
  [TRACK_INSET_VAR]: `var(${PANE_INSET_VAR}, 0px)`,
  marginInline: `calc(var(${TRACK_INSET_VAR}) * -1)`,
  // A NEGATIVE MARGIN ONLY BLEEDS IF THE BOX IS FREE TO GROW. `width: 100%` (Tailwind `w-full`,
  // which several pane tracks carried) resolves against the REGION's content box, so the track
  // was positioned at the pane's left edge and then capped 16px short of its right one — the bar
  // moved from 8px inside the pane to 16px inside it. Measured, not reasoned about: the
  // scroll-track test named `rerun` and `compare` before this line existed.
  // `auto` restores stretch (flex cross-size / block fill), which subtracts the negative margins
  // and lands the track exactly on the pane's edges. It is here rather than left to each call
  // site so a `w-full` re-added tomorrow cannot re-break the bleed.
  width: 'auto',
} as CSSProperties

const CONTENT_STYLE: CSSProperties = {
  paddingInline: `var(${TRACK_INSET_VAR}, 0px)`,
  // Any scroll track BELOW this one is an ordinary bounded box inside the pane's content, not the
  // pane's own track — it must not bleed a second time.
  [PANE_INSET_VAR]: '0px',
} as CSSProperties

export interface PaneScrollProps extends ScrollAreaProps {
  children?: ReactNode
}

/**
 * The pane's own scroll track. Use it wherever a pane body's content scrolls; use the plain kit
 * `ScrollArea` for a bounded box INSIDE that content (a log console, a `max-h-*` list) — although
 * a `PaneScroll` there is harmless, because the reset above makes it identical.
 */
export function PaneScroll({ children, style, ...rest }: PaneScrollProps) {
  return (
    <ScrollArea {...rest} data-pane-scroll="" style={style ? { ...HOST_STYLE, ...style } : HOST_STYLE}>
      {/* A plain BLOCK wrapper: the overlayscrollbars viewport establishes a block formatting
          context, so the children lay out exactly as they did as its direct children. */}
      <div data-pane-scroll-content="" style={CONTENT_STYLE}>
        {children}
      </div>
    </ScrollArea>
  )
}
