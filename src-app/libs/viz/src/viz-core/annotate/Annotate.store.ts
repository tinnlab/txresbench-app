// Annotate.store.ts — the PER-IMAGE-CELL annotation authoring store (ITEM-5 + ITEM-6).
//
// One fresh store per image cell (minted by `createAnnotateStore()`, wrapped in a context
// by `AnnotateContext.tsx`) so annotation edit state, the active tool, the class table and
// the undo stack are STRICTLY per-instance and never leak between cells (§5 multi-instance;
// INV-2). It mirrors the viz package's existing `Coordination.store` factory idiom
// (`create<…>()(subscribeWithSelector(…))` + a `create*Store()` factory) rather than the
// `@txresbench/framework` store-kit (which the viz package does not depend on) — same isolation
// guarantee, native to this package.
//
// State shape (ITEM-5):
//   • normalized `byId` + ordered `ids` (a flat array is an O(N) scan; the normalized map is
//     O(1) touch + structural-sharing-friendly for the patch stack).
//   • `activeTool`, `activeClassId`, `classes`, `selection: Set<AnnotationId>`.
//   • bounded FIFO `undoStack` / `redoStack`.
//   Geometry is stored as flat `Float64Array` rings on each `Annotation` (annotateModel);
//   it is kept OUT of any Immer draft — every edit assigns a WHOLE new geometry object
//   (swap-ref), so a `produceWithPatches` patch carries the array by reference and Immer
//   never tries to proxy/freeze a typed array (which throws). `setAutoFreeze(false)` makes
//   that contract explicit.
//
// Undo/redo (ITEM-6, DEC-C): every mutation runs the doc `{byId,ids,classes}` through
//   `produceWithPatches` → push `{patches,inverse}` (O(diff), NOT an O(collection) snapshot);
//   undo applies the inverse, redo re-applies the patches; a new edit clears redo. Because
//   the editor commits ONCE on pointer-up (the live gesture lives in a `useRef`, never the
//   store — see `useAnnotateEditor`), a drag of N moves coalesces into exactly ONE entry.
//   `selection` is snapshotted per entry (kept OUT of the patch doc so the Set stays a plain
//   Set, not an Immer-drafted one) so undoing a delete restores the object AND its selection.

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import {
  produceWithPatches,
  applyPatches,
  enablePatches,
  setAutoFreeze,
  type Patch,
} from 'immer'
import type {
  Annotation,
  AnnotationId,
  AnnotationClass,
  AnnotationGeometry,
  AnnotateTool,
} from './annotateModel'
import type { GeoFeature } from './processorPort'
import {
  hierObjectsFromAnnotations,
  isAncestorOrSelf,
  resolveHierarchy,
} from './hierarchy'

// Immer setup (module-load, idempotent): patches for the O(diff) undo stack, and NO
// auto-freeze — annotations hold `Float64Array` rings and `Object.freeze` on a typed array
// with elements throws, so freezing must stay off.
enablePatches()
setAutoFreeze(false)

/** Bounded undo/redo depth (DEC-C ~100–200). Exported so a test can exercise the cap. */
export const MAX_HISTORY = 150

/** The Immer-tracked document — the slice undo/redo replays patches over. Selection is
 *  deliberately NOT here (it is snapshotted per entry so it stays a plain `Set`). */
interface AnnotateDoc {
  byId: Record<AnnotationId, Annotation>
  ids: AnnotationId[]
  classes: AnnotationClass[]
}

/** One history entry: the forward patches + their inverse, plus the selection on each side
 *  (so undoing a delete restores the prior selection — "object + class + selection"). */
interface UndoEntry {
  patches: Patch[]
  inverse: Patch[]
  selBefore: AnnotationId[]
  selAfter: AnnotationId[]
}

/** Input to `add` / `commitResult`. `id` is optional so a processor-injected result can
 *  carry a stable origin id (update-by-id on re-run); omitted ⇒ a fresh UUID. */
export interface AddAnnotationInput {
  geometry: AnnotationGeometry
  classId?: string | null
  label?: string | null
  locked?: boolean
  properties?: Readonly<Record<string, unknown>>
  id?: AnnotationId
  /** hierarchy level tag (host-supplied) — carried through so an import/processor result seeds it. */
  level?: string | null
  /** hierarchy parent id — carried through so an imported tree seeds intact. */
  parentId?: AnnotationId | null
}

export interface AnnotateState {
  byId: Record<AnnotationId, Annotation>
  ids: AnnotationId[]
  classes: AnnotationClass[]
  activeTool: AnnotateTool
  activeClassId: string | null
  /** Host-supplied ordered level vocabulary (coarse→fine); empty ⇒ no hierarchy levels (DEC-8). */
  levels: string[]
  /** The level being authored/filtered; null ⇒ all levels (ITEM-11). */
  activeLevel: string | null
  selection: Set<AnnotationId>
  undoStack: UndoEntry[]
  redoStack: UndoEntry[]
  canUndo: boolean
  canRedo: boolean
}

export interface AnnotateActions {
  /** Add a hand-drawn annotation; returns its id. */
  add(input: AddAnnotationInput): AnnotationId
  /** Replace one annotation's geometry (reshape / vertex-edit / whole-feature translate). */
  reshape(id: AnnotationId, geometry: AnnotationGeometry): void
  /** Delete an annotation (removes it from `selection` too). */
  delete(id: AnnotationId): void
  /** Relabel: set the class and/or label of ONE annotation (touches only that object). */
  relabel(id: AnnotationId, patch: { classId?: string | null; label?: string | null }): void
  /** Commit a processor-produced result via the SAME add path (indistinguishable + undoable,
   *  DEC-E); the whole batch is ONE undo entry. Returns the created ids. */
  commitResult(inputs: readonly AddAnnotationInput[]): AnnotationId[]
  setTool(tool: AnnotateTool): void
  setActiveClass(classId: string | null): void
  /** Set the host-supplied level vocabulary (coarse→fine). Not an undo step. */
  setLevels(levels: readonly string[]): void
  /** Set the active authoring/filter level (null = all). Not an undo step. */
  setActiveLevel(level: string | null): void
  /** Set ONE object's hierarchy level (undoable — rides the Immer doc). */
  setLevel(id: AnnotationId, level: string | null): void
  /** Reparent ONE object (undoable). Rejects a cycle (newParent = id or a descendant of id). */
  setParent(id: AnnotationId, parentId: AnnotationId | null): void
  /** Batch containment-resolve every object's parent (QuPath dual rule); ONE undo entry.
   *  Returns the number of objects whose parent changed. */
  resolveHierarchy(): number
  /** Set the selection (id / id-list / null-clears). Not itself an undo step. */
  select(sel: AnnotationId | readonly AnnotationId[] | null): void
  /** Add a class to the table; returns its id. Undoable. */
  addClass(cls: { name: string; color: readonly [number, number, number]; id?: string }): string
  /** Patch a class's name/color. Undoable. */
  updateClass(id: string, patch: { name?: string; color?: readonly [number, number, number] }): void
  undo(): void
  redo(): void
}

export type AnnotateStoreState = AnnotateState & AnnotateActions

function freshId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  // Fallback (non-secure) — only hit where WebCrypto is absent.
  return 'a-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function initialState(): AnnotateState {
  return {
    byId: {},
    ids: [],
    classes: [],
    activeTool: 'select',
    activeClassId: null,
    levels: [],
    activeLevel: null,
    selection: new Set<AnnotationId>(),
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
  }
}

/**
 * Mint a FRESH, fully-independent annotation store for ONE image cell. Two instances share
 * NOTHING — an action on one never touches the other's `byId` / `selection` / history (the
 * §5 per-cell isolation contract; proven by `Annotate.store.test.ts`'s two-instance case).
 */
export function createAnnotateStore() {
  return create<AnnotateStoreState>()(
    subscribeWithSelector((set, get) => {
      // Read the current doc slice (base for `produceWithPatches` / `applyPatches`).
      const doc = (): AnnotateDoc => {
        const s = get()
        return { byId: s.byId, ids: s.ids, classes: s.classes }
      }

      /**
       * Run a recipe over the doc, push the resulting patch-pair onto the undo stack (bounded,
       * redo cleared), and set the new doc + selection. `selAfter` defaults to the current
       * selection (most edits leave it untouched).
       */
      const commit = (
        recipe: (d: AnnotateDoc) => void,
        selAfter?: AnnotationId[],
      ): void => {
        const s = get()
        const [next, patches, inverse] = produceWithPatches(doc(), recipe)
        if (patches.length === 0) return // no-op edit → no history churn
        const selBefore = [...s.selection]
        const after = selAfter ?? selBefore
        const undoStack = s.undoStack.concat({ patches, inverse, selBefore, selAfter: after })
        while (undoStack.length > MAX_HISTORY) undoStack.shift()
        set({
          byId: next.byId,
          ids: next.ids,
          classes: next.classes,
          selection: new Set(after),
          undoStack,
          redoStack: [],
          canUndo: undoStack.length > 0,
          canRedo: false,
        })
      }

      const addOne = (d: AnnotateDoc, input: AddAnnotationInput): AnnotationId => {
        const id = input.id ?? freshId()
        d.byId[id] = {
          id,
          geometry: input.geometry,
          classId: input.classId ?? null,
          label: input.label ?? null,
          ...(input.locked !== undefined ? { locked: input.locked } : {}),
          ...(input.properties !== undefined ? { properties: input.properties } : {}),
          ...(input.level !== undefined ? { level: input.level } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        }
        d.ids.push(id)
        return id
      }

      return {
        ...initialState(),

        add(input) {
          let id = ''
          commit(d => {
            id = addOne(d, input)
          })
          return id
        },

        commitResult(inputs) {
          const created: AnnotationId[] = []
          commit(d => {
            for (const input of inputs) created.push(addOne(d, input))
          })
          return created
        },

        reshape(id, geometry) {
          if (!get().byId[id]) return
          commit(d => {
            const a = d.byId[id]
            if (a) d.byId[id] = { ...a, geometry }
          })
        },

        delete(id) {
          if (!get().byId[id]) return
          const selAfter = [...get().selection].filter(s => s !== id)
          commit(d => {
            delete d.byId[id]
            const i = d.ids.indexOf(id)
            if (i >= 0) d.ids.splice(i, 1)
          }, selAfter)
        },

        relabel(id, patch) {
          if (!get().byId[id]) return
          commit(d => {
            const a = d.byId[id]
            if (!a) return
            d.byId[id] = {
              ...a,
              classId: patch.classId !== undefined ? patch.classId : a.classId,
              label: patch.label !== undefined ? patch.label : a.label,
            }
          })
        },

        addClass(cls) {
          const id = cls.id ?? freshId()
          commit(d => {
            d.classes.push({ id, name: cls.name, color: [cls.color[0], cls.color[1], cls.color[2]] })
          })
          return id
        },

        updateClass(id, patch) {
          commit(d => {
            const i = d.classes.findIndex(c => c.id === id)
            if (i < 0) return
            const c = d.classes[i]
            d.classes[i] = {
              id: c.id,
              name: patch.name !== undefined ? patch.name : c.name,
              color: patch.color !== undefined
                ? [patch.color[0], patch.color[1], patch.color[2]]
                : c.color,
            }
          })
        },

        setTool(tool) {
          set({ activeTool: tool })
        },

        setActiveClass(classId) {
          set({ activeClassId: classId })
        },

        setLevels(levels) {
          set({ levels: [...levels] })
        },

        setActiveLevel(level) {
          set({ activeLevel: level })
        },

        setLevel(id, level) {
          if (!get().byId[id]) return
          commit(d => {
            const a = d.byId[id]
            if (a) d.byId[id] = { ...a, level }
          })
        },

        setParent(id, parentId) {
          const s = get()
          if (!s.byId[id]) return
          if (parentId === id) return
          if (parentId != null && !s.byId[parentId]) return
          // cycle guard: the new parent must not be id itself or a descendant of id.
          const parentOf = new Map<AnnotationId, AnnotationId | null>(
            s.ids.map(x => [x, s.byId[x]?.parentId ?? null]),
          )
          if (parentId != null && isAncestorOrSelf(parentOf, parentId, id)) return
          if ((s.byId[id].parentId ?? null) === parentId) return
          commit(d => {
            const a = d.byId[id]
            if (a) d.byId[id] = { ...a, parentId }
          })
        },

        resolveHierarchy() {
          const s = get()
          const resolved = resolveHierarchy(
            hierObjectsFromAnnotations({ byId: s.byId, ids: s.ids }),
          )
          let changed = 0
          commit(d => {
            for (const id of d.ids) {
              const a = d.byId[id]
              if (!a) continue
              const next = resolved.get(id) ?? null
              if ((a.parentId ?? null) !== next) {
                d.byId[id] = { ...a, parentId: next }
                changed++
              }
            }
          })
          return changed
        },

        select(sel) {
          const ids = sel == null ? [] : Array.isArray(sel) ? sel : [sel as AnnotationId]
          set({ selection: new Set(ids) })
        },

        undo() {
          const s = get()
          if (s.undoStack.length === 0) return
          const undoStack = s.undoStack.slice()
          const entry = undoStack.pop() as UndoEntry
          const prev = applyPatches(doc(), entry.inverse) as AnnotateDoc
          const redoStack = s.redoStack.concat(entry)
          set({
            byId: prev.byId,
            ids: prev.ids,
            classes: prev.classes,
            selection: new Set(entry.selBefore),
            undoStack,
            redoStack,
            canUndo: undoStack.length > 0,
            canRedo: true,
          })
        },

        redo() {
          const s = get()
          if (s.redoStack.length === 0) return
          const redoStack = s.redoStack.slice()
          const entry = redoStack.pop() as UndoEntry
          const next = applyPatches(doc(), entry.patches) as AnnotateDoc
          const undoStack = s.undoStack.concat(entry)
          set({
            byId: next.byId,
            ids: next.ids,
            classes: next.classes,
            selection: new Set(entry.selAfter),
            undoStack,
            redoStack,
            canUndo: true,
            canRedo: redoStack.length > 0,
          })
        },
      }
    }),
  )
}

/** A per-cell annotation store instance (the `create()`-bound handle). */
export type AnnotateStore = ReturnType<typeof createAnnotateStore>

// ── ITEM-16 · the counting job (JTBD: "why would people need to drop point?") ───────────────
//
// A point tool that only leaves a dot serves NONE of its four real jobs — counting (mitoses /
// Ki-67+ / TILs, where the entire deliverable IS the number), landmarks, segmenter seeds, and
// detection ground truth. These selectors supply the number and the seed payload.
//
// DERIVED, NEVER STORED (TEST-19). A separately-persisted counter would drift the moment an
// undo, a delete, a relabel or a processor commit touched the collection — and the drift would
// be invisible, because the count is exactly what the user trusts. Computing from the committed
// annotations makes "the number is wrong" unrepresentable: add/undo/redo/delete/reclass all move
// the tally for free because they move the thing it is derived from.

/** Live per-class tally for one pane, over EVERY committed annotation regardless of geometry kind.
 *
 *  DRIFT-3.8 — this counted POINTS ONLY when it was built for the counting job, and that made the
 *  Classes list lie: a pane holding one Tumor POLYGON and no Tumor points rendered `Tumor 0` beside
 *  an `Objects (1)` panel listing that very polygon. A number beside a class in a list headed
 *  *Classes* reads as "how many things of this class exist", so it counts points, polygons and
 *  brush regions alike (brush commits a `polygon`, so it needs no separate arm). That makes the two
 *  readouts derive from the SAME set — `total` equals the hierarchy panel's `Objects (N)`, which is
 *  also `ids.length` (it lists every node, roots and children alike).
 *
 *  `byClass` is keyed by class id; annotations with no class land in `unclassified` (a legitimate
 *  state — the user may count before naming). `points` is the POINT SUBSET, kept because the seed
 *  export hands out points only (`pointSeedFeatures`) and its label must name that payload's size,
 *  not the object count. */
export interface AnnotationTally {
  readonly byClass: Readonly<Record<string, number>>
  readonly unclassified: number
  readonly total: number
  /** How many of `total` are point geometry — the `pointSeedFeatures` payload size. */
  readonly points: number
}

/** Count committed annotations per class. O(annotations); call from a selector/render. */
export function annotationTally(state: Pick<AnnotateState, 'byId' | 'ids'>): AnnotationTally {
  const byClass: Record<string, number> = {}
  let unclassified = 0
  let total = 0
  let points = 0
  for (const id of state.ids) {
    const a = state.byId[id]
    if (!a) continue
    total++
    if (a.geometry.kind === 'point') points++
    if (a.classId == null) unclassified++
    else byClass[a.classId] = (byClass[a.classId] ?? 0) + 1
  }
  return { byClass, unclassified, total, points }
}

/**
 * The committed points as `ProcessorPort` **`GeoFeature`s** — the exact shape
 * `ProcessorPort.commitPoints` accepts, so counted points hand straight to an external
 * segmenter as click/marker SEEDS with no new seam and no translation layer (INV-2/INV-3: the
 * editor still runs no model; it only hands coordinates out). Coordinates are full-res px
 * (INV-4). Pure — returns a fresh array; mutating it never touches the store.
 */
export function pointSeedFeatures(
  state: Pick<AnnotateState, 'byId' | 'ids'>,
): GeoFeature[] {
  const out: GeoFeature[] = []
  for (const id of state.ids) {
    const a = state.byId[id]
    if (!a || a.geometry.kind !== 'point') continue
    out.push({
      id: a.id,
      geometry: { kind: 'point', xy: [a.geometry.xy[0], a.geometry.xy[1]] },
      classId: a.classId,
      label: a.label,
    })
  }
  return out
}
