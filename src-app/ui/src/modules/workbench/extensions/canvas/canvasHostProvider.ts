// The canvas extension's implementation of core's `DeclarativeCanvasHost` seam
// (DOMAIN_AUDIT §4 "Structural" + C8). Registered at module-evaluation time from
// `extensions/index.ts`, exactly like a capability provider.
//
// Everything below USED TO LIVE IN `core/render/DeclarativeRegion.tsx`, which imported it
// as VALUES out of `extensions/` while the rest of core is type-only about extensions. It
// is not just a layering nicety: with the code in core, core knew
//   · that the keep-mask is spelled `$derived.keptMask` (now DECLARED — `canvas.mask`),
//   · that the positions map is keyed `obs` (now the canvas's own default dataset base),
//   · that the artifact catalog has a `layouts` channel (a canvas concept, and it lives
//     here now).
// Core hands over the spec + data + scope and learns nothing back.

import { cellSpaceKey, defaultVizStores, resolvedPaneBindings } from '@txresbench/viz'
import { namespaceActionId, type DeclarativeCanvasHost, type DeclarativeCanvasPublish } from '@/modules/workbench/core'
import { runAction } from '@/core/actions/defineAction'
import { resolveCanvasCoords, type CanvasTemplate } from './canvasBinding'
import { resolveDeclarativeCanvas } from './canvasFeed'
import { declarativeCanvas } from './declarativeCanvasFeed.store'
import { buildCanvasSources } from './canvasDataSource'

/** The project's plottable-XY coordinates, cached per `(projectId, catalogEpoch)`. The read
 *  is async and `publish` is synchronous, so the FIRST publish for an epoch resolves without
 *  positions, kicks the fetch off, and RE-publishes the last input when it lands. */
interface PositionsEntry {
  key: string
  /** undefined while in flight; `null` = resolved to "this project has no XY layout". */
  value: { positions: Float32Array; length: number } | null | undefined
  inFlight: boolean
}

let positionsCache: PositionsEntry | undefined
/** The most recent publish input per view, so a late positions arrival can re-publish. */
const lastInput = new Map<string, DeclarativeCanvasPublish>()

/**
 * The positions of every artifact a canvas DECLARED with `coords` (visualize-pane ITEM-29),
 * keyed `<projectId>|<catalogEpoch>|<artifactId>`.
 *
 * An artifact is content-addressed and immutable, so the epoch in the key is about the
 * PROJECT's identity rather than the artifact's content; it keeps the map bounded by a
 * session's browsing rather than by history. `null` records "resolved, and it has no XY
 * layout", so a broken declaration is asked once rather than on every republish.
 */
const declaredPositions = new Map<string, { positions: Float32Array; length: number } | null>()
/** Declared-coords reads in flight, so N views naming one artifact issue ONE read. */
const declaredInFlight = new Set<string>()

/** Test-only: drop the memoized positions + the per-view replay inputs. */
export function __resetCanvasHostForTests(): void {
  positionsCache = undefined
  lastInput.clear()
  declaredPositions.clear()
  declaredInFlight.clear()
}

function publish(input: DeclarativeCanvasPublish): void {
  const { spec, viewId, data, scope, api, projectId, hostCtx, catalogEpoch, order } = input
  lastInput.set(viewId, input)

  const key = `${projectId}|${catalogEpoch}`

  // ── ITEM-29: the coordinates the BLOCK DECLARED ────────────────────────────────────────
  //
  // A `canvas.datasets[].coords` names the artifact a base is drawn in, so this reads exactly
  // what the declaration asked for — no `layouts[0]`, no project-wide guess. Reads are fired
  // here (synchronously scheduled, resolved later) and the view is REPUBLISHED as each lands,
  // the same shape the project-wide read below already uses: `publish` cannot await, and a
  // base whose artifact has not resolved yet simply draws with no positions for one frame.
  const declared = Object.values(
    resolveCanvasCoords((spec.canvas ?? { series: [] }) as CanvasTemplate, scope),
  )
  const positionsByArtifact = new Map<string, { positions: Float32Array; length: number }>()
  for (const artifact of declared) {
    const cacheKey = `${key}|${artifact}`
    const known = declaredPositions.get(cacheKey)
    if (known != null) positionsByArtifact.set(artifact, known)
    if (known !== undefined || declaredInFlight.has(cacheKey)) continue
    declaredInFlight.add(cacheKey)
    void (async () => {
      try {
        // Through the MEMOIZED streaming source (ITEM-8), not a fresh pull source per call. The
        // previous factory minted a NEW instance every time, so two views naming one artifact
        // concurrently issued two reads and only the `declaredInFlight` set kept them apart —
        // which cannot help the case that matters, a second view arriving while the first is
        // still streaming. One instance means that second view JOINS the running read.
        const pos = await buildCanvasSources(api, projectId).pull.positions(artifact)
        declaredPositions.set(cacheKey, pos.length > 0 ? { positions: pos.positions, length: pos.length } : null)
      } catch (err) {
        // A DECLARED artifact that cannot be read is a real failure — the declaration named it
        // — so it is logged rather than silently degraded, and cached as "no layout" so the
        // republish below terminates instead of re-reading on every render.
        console.error(`[canvas] declared coords read failed for artifact ${artifact}`, err)
        declaredPositions.set(cacheKey, null)
      } finally {
        declaredInFlight.delete(cacheKey)
        const pending = lastInput.get(viewId)
        if (pending && `${pending.projectId}|${pending.catalogEpoch}` === key) publish(pending)
      }
    })()
  }

  if (!positionsCache || positionsCache.key !== key) {
    positionsCache = { key, value: undefined, inFlight: false }
  }
  const cache = positionsCache
  // The PROJECT-WIDE `layouts[0]` read is UNCHANGED, and deliberately not gated on
  // `declared.length === 0`. Gating it read as an optimisation and was a trap: a canvas where
  // ONE dataset declares `coords` and another does not is exactly the mixed shape this key
  // makes possible, and the fallback is what the undeclared base still needs. It is one
  // memoized read per epoch either way, and `positionsFor` checks the declaration FIRST — so a
  // block that says which coordinates it means is never overruled by it.
  //
  // REPORTED, not silently kept: for a base that declares NOTHING this is still
  // `cat.layouts[0]` — the project's FIRST plottable-xy artifact handed to the default base —
  // which is the INV-3 violation ITEM-29 exists to end. Ending it outright would have changed
  // a shipping surface (one shipped analysis' scatter has no coordinate picker to declare
  // from), and DEC-15's ruling for this exact shape is declare-and-MIGRATE, not
  // declare-and-break. The migration is a UI change to an analysis form, not a mechanical one,
  // so it is named here rather than done in passing. Every surface this round ADDS declares.
  if (cache.value === undefined && !cache.inFlight) {
    cache.inFlight = true
    void (async () => {
      try {
        const src = buildCanvasSources(api, projectId).pull
        const cat = await src.catalog()
        // The `layouts` catalog channel IS the plottable-XY artifacts (capability-classified by
        // the datatype registry) — an empty channel ⇒ no coordinates, fall back to fabrication.
        const layout = cat.layouts[0]
        if (!layout) {
          cache.value = null
          return
        }
        const pos = await src.positions(layout.id)
        cache.value = pos.length > 0 ? { positions: pos.positions, length: pos.length } : null
      } catch (err) {
        // Best-effort (a backend-free gallery / no-serve build throws) — the scatter then falls
        // back to the column fabrication. A REAL error is logged, distinct from an expected
        // no-data / no-serve result.
        console.error('[canvas] plottable-xy positions read failed', err)
        cache.value = null
      } finally {
        cache.inFlight = false
        // Re-publish every live view with the coordinates now in hand. Guarded on the cache
        // still being the current epoch's (a newer epoch supersedes an in-flight read), AND on
        // each pending input belonging to THAT key.
        //
        // The second guard is what makes the replay terminate. `positionsCache` holds ONE entry;
        // replaying an input from a different key resets it and starts another read, whose own
        // replay resets it back — two live views on different keys ping-pong forever. It became
        // reachable when a view's publish stopped being discarded the moment its region unmounted:
        // an input can now outlive the epoch it was captured in.
        if (positionsCache === cache) {
          for (const pending of [...lastInput.values()]) {
            if (`${pending.projectId}|${pending.catalogEpoch}` === cache.key) publish(pending)
          }
        }
      }
    })()
  }

  const feed = resolveDeclarativeCanvas(spec, {
    data,
    positions: cache.value ?? undefined,
    positionsByArtifact,
    scope,
  })
  // No plottable canvas right now (no `canvas` block, or its dynamic content expands to zero
  // series — e.g. the last criterion was just removed). CLEAR the feed (owner-guarded) so the
  // canvas returns to its empty hero rather than leaving a stale active feed pinned.
  if (!feed) {
    declarativeCanvas.clear(viewId)
    return
  }
  // Controlled cell-close routing (ITEM-17 / DEC-7): a controlled cell's `cell-close(coordId)`
  // is routed to the declared close action (`removeCriterion` / a `showX` toggle) that mutates
  // the state the cell derives from — never a raw `removePane`, so the `for_each` render can't
  // re-create it (the reopen-loop guard). `null` when the canvas declares no controlled cells.
  const closeActions = feed.closeActions
  const onCellClose = Object.keys(closeActions).length
    ? (coordId: string): void => {
        const binding = closeActions[coordId]
        if (!binding) return
        void runAction(namespaceActionId(spec.id, binding.action), { view_id: viewId, ...binding.params }, hostCtx).catch(
          (err: unknown) => api.ui.notify(err instanceof Error ? err.message : String(err), 'error'),
        )
      }
    : null
  declarativeCanvas.setFeed(viewId, feed.option, feed.resolver, onCellClose, order)
}

export const canvasHost: DeclarativeCanvasHost = {
  publish,
  clear(viewId) {
    lastInput.delete(viewId)
    declarativeCanvas.clear(viewId)
  },
}

// ── read-only e2e seam (mirrors `window.__declarativeStores` / `window.__workbench`) ─────────────
// What each canvas PANE currently is: its declared identity (coordId / kind / title / kind-switch
// allow-list) from the published feed, and — crucially — the ROW COUNT its dataset resolved to,
// read out of the viz DatasetStore the grid renders from.
//
// The row count comes from the STORE deliberately, never from re-invoking the feed's resolver. The
// resolver always answers with the current keep-mask, which is exactly why a dead live link could
// ship green: `window.__declarativeStores` showed the mask re-deriving on every keystroke while
// the plot beside it never moved, because viz had pinned the dataset it resolved the first time.
// An assertion that stops at the derived mask re-certifies that bug; this one stops where the
// pixels come from.
//
// The seam exists at all because the grid is deck.gl/WebGL2 and a headless browser cannot paint it,
// so there is no pixel to assert; a read-only window seam over the real state is the app's
// established answer (see `declarativeMount.ts`).
if (typeof window !== 'undefined') {
  ;(window as unknown as { __canvasPanes?: unknown }).__canvasPanes = () => {
    const { option, paneOwners } = declarativeCanvas.get()
    const datasets = defaultVizStores.datasetStore.getState()
    const gridPanes = defaultVizStores.gridWorkspace.getState().cells
    const defaultId = option?.datasets?.[0]?.id ?? option?.dataset?.id
    return (option?.series ?? []).map(s => {
      const dsId = s.datasetId ?? defaultId
      const owner = paneOwners.get(s.coordId)
      const gridPane = gridPanes[s.coordId]
      return {
        /** The coordId the DECLARATION wrote. Composition namespaces panes by contributing view
         *  so two declarations cannot collide on the shared grid; that is an internal key, and a
         *  reader asserting on a pane should not have to know it exists. */
        id: owner?.local ?? s.coordId,
        /** Which view placed it — the composed canvas holds panes from every open pane. */
        viewId: owner?.viewId ?? null,
        kind: s.type,
        title: typeof s.title === 'string' ? s.title : null,
        switchTo: s.switchTo ? [...s.switchTo] : null,
        /** `null` ⇒ the pane binds nothing, or viz has not reached a ready catalog for it yet — so
         *  a poll can tell "not resolved yet" apart from "resolved to zero rows". */
        rows: dsId ? (datasets.getEntry(dsId)?.catalog?.pointCount ?? null) : null,
        /** The key the viz DatasetStore filed this pane's dataset under — deliberately the COMPOSED
         *  id, not the declaration's, because it is the identity that is reused or retired, and a
         *  dataset identity is also a selection space. `rows` alone cannot see the difference
         *  between content re-resolved under the same identity and content resolved under a new
         *  one; both reshape the pane, and only the first keeps the space. */
        datasetKey: dsId ?? null,
        /**
         * The pane's CANONICAL ROW IDENTITY as viz pulled it — `"<first>..<last>/<count>"`, or
         * `null` when its dataset declares none (an isolated identity space, ITEM-10).
         *
         * The SELECTION half of "are these two panes linked" (ledger #34), which the space key
         * cannot answer: a dataset carrying canonical ids routes its panes to viz's canonical
         * selection space, where two panes cross-select exactly to the extent their ids overlap.
         * A range rather than the array so the seam stays cheap to read and an assertion can be
         * exact about both directions — the SAME range (linked) and DISJOINT ranges (isolated).
         */
        identity: (() => {
          const ids = dsId ? datasets.getEntry(dsId)?.pointIds : null
          return ids && ids.length > 0 ? `${ids[0]}..${ids[ids.length - 1]}/${ids.length}` : null
        })(),
        /**
         * The COORDINATE-SPACE key viz filed this pane under (`cellSpaceKey`) — the scope
         * link-zoom and the shared camera fan within, and the only place the answer to "are
         * these two panes linkable" actually lives (ledger #34).
         *
         * Read from viz's RESOLVED grid pane, never recomputed from the declaration: the whole
         * of #34 lived in the gap between the two — the pane declared its coordinates precisely
         * through `coords` while the key viz scoped by contained no trace of them, because
         * nothing translated that declaration into `encode.layout`. A reader asserting on the
         * declaration watches the half that was already right.
         *
         * `null` ⇒ viz has not resolved this pane onto the grid yet (not yet mounted).
         */
        spaceKey: gridPane ? cellSpaceKey(gridPane) : null,
        /** The coordinate/layout id half of that key on its own — the artifact the pane is
         *  drawn in, so a reader can tell "same coordinates" from "same dataset identity". */
        layoutId: gridPane?.layoutId ?? null,
        /**
         * The RESOLVED per-channel bindings the grid renders this pane from — viz's own answer
         * after the declaration's `encode` has been overlaid onto the chart's catalog defaults.
         *
         * Deliberately NOT `s.encode`. The whole of the unset-group-by bug lived in the gap
         * between the two: the declaration correctly said "no grouping" while the resolved binding
         * named the first categorical column in the catalog, because a dropped channel is
         * indistinguishable from one the view never mentioned and the default filled it in. A reader asserting on the declaration
         * watches the half that was already right. `null` ⇒ the pane resolved no explicit
         * bindings (a chart with no binding schema, or one not yet mounted).
         */
        bindings: (resolvedPaneBindings(s.coordId) ?? null) as Record<string, unknown> | null,
      }
    })
  }
}
