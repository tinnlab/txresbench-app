// The core-owned HOST WIRING layer (ITEM-10/11 — what is LEFT of the old
// `workbench/host/createHost.ts` after the data + jobs planes moved out to the
// extensions that publish them).
//
// The old file built SEVEN unrelated things. Five are host wiring and stay here,
// core-owned: the P2 datatype-lattice adapter, the in-process event bus, the guarded
// localStorage KV, the kit-backed `UiHost`, and the `createWorkbenchHost` /
// `useWorkbenchApi` composition — plus the shared column cache / `createClientDataCtx`
// (a resident synchronous `DataCtx` over any async column source, used by the
// data-driven param defaults). The two that LEFT are `createDataHost` →
// `extensions/data` and `createComputeHost` → `extensions/jobs`; the fake host's two
// inline plane literals moved WITH them (`makeFakeDataHost` / `makeFakeJobsHost`), so
// the gallery keeps its backend-free data + run surfaces.
//
// Importing `@/modules/workbench/extensions` here is deliberate: it is the module-eval
// point at which the builtin capability PROVIDERS register, so any `useWorkbenchApi`
// below is guaranteed a stocked broker. It is the same core→extensions builtin-wiring
// edge `installBuiltinWidgets` already uses.

import { useMemo } from 'react'
import { datatypeRegistry } from '@/core/datatypes'
import { message } from '@ziee/kit'
import {
  annotationTarget,
  createWorkbenchApi,
  type WorkbenchAPI,
  type WorkbenchHost,
  type EventBusLike,
  type KeyValueBackend,
  type UiHost,
  type DatatypeLattice,
  type ValueRef,
  type DataCtx,
  type ResolvedColumn,
} from '@/modules/workbench/core'
import {
  axesByHash,
  axesLabelled,
  axisByLabel,
  DATA_CAPABILITY_ID,
  JOBS_CAPABILITY_ID,
  makeFakeDataHost,
  makeFakeJobsHost,
  type ArtifactRow,
  type AxisSummary,
} from '@/modules/workbench/extensions'

// --- P2 datatype lattice: adapt the app's registry (exactly as discover.ts) ---
export const workbenchLattice: DatatypeLattice = {
  isA: (sub, sup) => datatypeRegistry.isA(sub, sup),
  matches: (id, sel) =>
    datatypeRegistry.matches(id, sel as Parameters<typeof datatypeRegistry.matches>[1]),
  get: id => datatypeRegistry.get(id) as ReturnType<DatatypeLattice['get']>,
}

// --- a minimal in-process event bus for the extension `events` facade ---
function createEventBus(): EventBusLike {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  return {
    on: (event, cb) => {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return { dispose: () => set.delete(cb) }
    },
    emit: (event, payload) => {
      listeners.get(event)?.forEach(cb => {
        try {
          cb(payload)
        } catch {
          /* a listener error must not break emit */
        }
      })
    },
  }
}

// --- guarded localStorage KV (the per-extension `storage` namespaces on top) ---
function createKeyValueBackend(): KeyValueBackend {
  const ls = (): Storage | null => {
    try {
      const probe = '__cyto_wb_kv_probe__'
      window.localStorage.setItem(probe, probe)
      window.localStorage.removeItem(probe)
      return window.localStorage
    } catch {
      return null
    }
  }
  const mem = new Map<string, string>()
  return {
    get: async key => ls()?.getItem(key) ?? mem.get(key) ?? null,
    set: async (key, value) => {
      const s = ls()
      if (s) s.setItem(key, value)
      else mem.set(key, value)
    },
    delete: async key => {
      const s = ls()
      if (s) s.removeItem(key)
      else mem.delete(key)
    },
    keys: async prefix => {
      const s = ls()
      const all = s ? Object.keys({ ...s }) : [...mem.keys()]
      return all.filter(k => k.startsWith(prefix))
    },
  }
}

// --- shell UI services: kit toasts + a progress wrapper ---
function createUiHost(): UiHost {
  return {
    notify: (msg, level) => {
      if (level === 'error') message.error(msg)
      else if (level === 'success') message.success(msg)
      else message.info(msg)
    },
    // `openView` focuses/opens a contributed view; the shell wires the concrete
    // dock-focus behavior when it mounts (a no-op-safe default here).
    openView: () => {},
    progress: async (task, label) => {
      if (label) message.info(label)
      return task()
    },
  }
}

// --- the resident client `DataCtx`: `resolveColumn` is synchronous, so a client ctx
// needs its columns resident; we back it with a per-project, process-shared column
// cache that `warm(refs)` fills asynchronously. The cache is SHARED across every ctx
// for a project so two readers of the same column read it once (not a cold miss each).
// Value columns degrade to all-NA (drift DR-2 — the value-axis name→index map is
// deferred); annotations resolve when readable; nothing ever throws.
//
// ITEM-9 deleted the selection RUNTIME that consumed this ctx; ITEM-39 deleted the
// dimension primitives that consumed it after that. The ONE remaining consumer is the
// data-driven param defaults (`AnalysisRunPanel` → `buildDataSummary`), which warms a
// declared `summaryColumns` ref set and reads each column once — so `warm` takes the
// REFS directly. (It used to take a whole index-set predicate and walk it with
// `collectRefKeys`; the predicate AST + that walker are gone with the evaluator, and the
// sole caller only ever passed a trivial one-ref wrapper.) ---

/** The catalog shape the client ctx reads: the project's DECLARED axes with their
 *  cardinalities (the open-axis wire shape). Never a `n_cells` scalar — a ctx keyed on
 *  one domain-named field reports `n = 0` for every catalog that does not carry that
 *  field, which silently turns EVERY column into an all-NA column of length 0.
 *
 *  It reads the full {@link AxisSummary}, `content_hash` included: the axis IDENTITY
 *  (INV-3) is what `refresh()` resolves its position axis by. */
interface ColumnSourceCatalog {
  axes: AxisSummary[]
}

/** The minimal async read seam a client `DataCtx` needs (host data plane OR the
 *  `DataApi` facade both satisfy it after a thin bind). */
export interface ClientColumnSource {
  catalog(): Promise<ColumnSourceCatalog>
  readColumn(read: { artifactId: string; selector?: string }): Promise<{ values: Float32Array | Uint32Array }>
}

/** Which of the catalog's axes this ctx treats as its position/value axes. Both
 *  default to the catalog's declared axis ORDER (the server orders `axes` by the
 *  declared axis order of the project's datatypes), so a caller that knows the
 *  datatype it is summarizing should name them explicitly.
 *
 *  These are axis LABELS, not `content_hash`es, and they cannot be anything else: they
 *  are matched against the axis a declared `ValueRef` names (`{axis, annotation}`), and
 *  an analysis DECLARATION carries a label only. A declaration cannot carry a
 *  `content_hash` — it is written before the artifacts it will run against exist, so
 *  there is no hash to write down.
 *
 *  That is a fact about the DECLARATION vocabulary, not a licence to key on a label
 *  (INV-3). Every use resolves the label through `axisByLabel` against the catalog the
 *  ctx already reads — `refresh()` for the position axis, `key()` for the shared column
 *  cache — and a label naming two axes resolves to NOTHING rather than to one of them. */
export interface ClientDataCtxAxes {
  positionAxis?: string
  valueAxis?: string
}

/** A resident client `DataCtx` plus the async warmer that fills the columns a caller
 *  references before a (synchronous) read. */
export interface ClientDataCtxHandle {
  ctx: DataCtx
  /** fill the process-shared cache with the columns `refs` name (best-effort). */
  warm(refs: ValueRef[]): Promise<void>
  /** (re)read the project axes (bumps the axis version). Resolves to the failure when
   *  the catalog read failed, so a caller can distinguish "no data" from "no read". */
  refresh(): Promise<void>
  /** the last catalog-read failure, if the most recent `refresh()` failed. */
  lastError(): unknown
}

// Process-shared, per-project column cache. The key is
// `${projectId}::${axis.content_hash}::${refName}` — the axis's IDENTITY (INV-3), never
// its label. Shared so the widget-preview ctx and the shell-runtime ctx read the same
// resident columns; the axis segment is what keeps two axes' columns of the same NAME
// from colliding, so it has to be the thing that actually distinguishes two axes.
//
// This segment WAS the label, defended in a "DOCUMENTED INV-3 EXCEPTION" comment whose
// argument was that both sides of the cache speak the declaration's vocabulary (`warm()`
// fills from a `ValueRef`'s `{axis, annotation}`; `resolveAnnotation(axis, name)` reads
// back with the same ref-supplied label) and a ref carries no hash. The premise is true
// and the conclusion did not follow: the ctx already READS THE CATALOG, so the label→axis
// join the ref cannot carry is available right here, and `axisByLabel` performs it. Two
// distinct axes sharing a label collided in this cache — the second reader silently got
// the first's values — which is the same name-as-identity defect the schema (ITEM-8) and
// the derivation (`derive_axes`) each already had removed.
//
// A label that does not resolve to EXACTLY ONE declared axis yields NO key: the column is
// not cached and not served (`resolveAnnotation` degrades to all-NA), because serving one
// of two candidate axes' columns would assert an identity the label does not carry. Same
// refusal-over-fabrication rule as `axisByLabel` / the `refresh()` position-axis read.
//
// FE-3 — bounding policy (a warmed column is otherwise resident forever + grows
// unbounded across a multi-project session): warm-once WITHIN the active project, but
// (1) when a project warms, evict every entry belonging to a DIFFERENT project (the
// shell is single-active-project; switching projects drops the previous project's
// columns), and (2) cap the total entry count, dropping the OLDEST (Map insertion
// order) past the ceiling — a backstop for a single project with very many columns.
const SHARED_ANNOTATION_CACHE = new Map<string, ResolvedColumn>()
const ANNOTATION_CACHE_MAX_ENTRIES = 64

/** Drop cached columns that don't belong to the active project (project-switch evict). */
function evictForeignProjectColumns(activeProjectId: string): void {
  const prefix = `${activeProjectId}::`
  for (const k of SHARED_ANNOTATION_CACHE.keys()) {
    if (!k.startsWith(prefix)) SHARED_ANNOTATION_CACHE.delete(k)
  }
}

/**
 * Drop this project's cached columns whose AXIS is no longer declared (INV-3).
 *
 * Keying on identity is what makes this expressible: a retired axis is one whose
 * `content_hash` has left the catalog (re-imported data is new bytes, so a new axis), and
 * its entries can never be hit again — they would sit in the cache occupying `capAnnotationCache`'s
 * ceiling and evicting LIVE columns. With a LABEL key neither half was true: a replaced
 * axis kept the same key, so the stale column was not garbage but a WRONG HIT, and there
 * was no way to tell a retired axis from a relabelled one.
 */
function evictRetiredAxisColumns(projectId: string, live: Map<string, AxisSummary>): void {
  const prefix = `${projectId}::`
  for (const k of SHARED_ANNOTATION_CACHE.keys()) {
    if (!k.startsWith(prefix)) continue
    const sep = k.indexOf('::', prefix.length)
    if (sep < 0) continue
    if (!live.has(k.slice(prefix.length, sep))) SHARED_ANNOTATION_CACHE.delete(k)
  }
}

/** Cap total entries, evicting oldest-first (Map preserves insertion order). */
function capAnnotationCache(): void {
  while (SHARED_ANNOTATION_CACHE.size > ANNOTATION_CACHE_MAX_ENTRIES) {
    const oldest = SHARED_ANNOTATION_CACHE.keys().next().value
    if (oldest === undefined) break
    SHARED_ANNOTATION_CACHE.delete(oldest)
  }
}

function naColumn(len: number): ResolvedColumn {
  const na = new Uint8Array(len)
  na.fill(1)
  return { values: new Float64Array(len), na }
}

function toResolvedColumn(raw: { values: Float32Array | Uint32Array }, len: number): ResolvedColumn {
  const src = raw.values
  const values = new Float64Array(len)
  const na = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    const v = i < src.length ? src[i] : Number.NaN
    values[i] = v
    na[i] = Number.isFinite(v) ? 0 : 1
  }
  return { values, na }
}

/**
 * Build a resident client `DataCtx` over an async column source (drift DR-2: value
 * columns are not client-resolvable yet, so they degrade to all-NA; the ctx never
 * throws — a missing annotation degrades to an uncovered column).
 *
 * `n` is the length of the ctx's POSITION AXIS, read off the catalog's declared axes.
 * It used to be `catalog().n_cells ?? 0`, which meant any catalog without that one
 * domain-named field reported `n = 0` → `naColumn(0)` → every column silently resolved
 * empty, with the surrounding `catch {}` swallowing the fact that anything was wrong.
 * Both halves are fixed: the length comes from the DECLARED axis, and a failed catalog
 * read is recorded + logged instead of being discarded.
 */
export function createClientDataCtx(
  src: ClientColumnSource,
  projectId: string,
  axes: ClientDataCtxAxes = {},
): ClientDataCtxHandle {
  let n = 0
  let axisVersion = 0
  let catalogError: unknown
  // Until the first successful `refresh()` the axis names are whatever the caller
  // declared (possibly nothing); `refresh` fills the blanks from the catalog's declared
  // axis ORDER, which the server emits in the datatypes' own declaration order.
  let positionAxis = axes.positionAxis ?? ''
  let valueAxis = axes.valueAxis ?? ''
  // The catalog's DECLARED axes, each carrying its `content_hash` (INV-3). Held because
  // the cache key is an axis IDENTITY and a `ValueRef` only ever names a LABEL, so every
  // read has to perform the label→axis join — and this is the list to join against.
  let declared: AxisSummary[] = []
  const ambiguityWarned = new Set<string>()
  /**
   * The cache key for one (axis LABEL, column name) pair, keyed on the axis's IDENTITY.
   *
   * `undefined` when the label does not name exactly one declared axis. AMBIGUOUS (two
   * axes share it) is the case this exists for: a key built from the label would put two
   * unrelated axes' columns in one slot. ABSENT (no axis carries it, incl. every read
   * before the first successful `refresh()`) also yields no key — it is an ordinary miss,
   * so it is silent, where ambiguity is said out loud once per label.
   */
  const key = (axisLabel: string, name: string): string | undefined => {
    const axis = axisByLabel({ axes: declared }, axisLabel)
    if (axis) return `${projectId}::${axis.content_hash}::${name}`
    if (axesLabelled({ axes: declared }, axisLabel).length > 1 && !ambiguityWarned.has(axisLabel)) {
      ambiguityWarned.add(axisLabel)
      console.warn(
        '[workbench] client DataCtx: the column axis label names more than one axis; refusing to guess which',
        projectId,
        axisLabel,
      )
    }
    return undefined
  }
  const ctx: DataCtx = {
    get n() {
      return n
    },
    get axisVersion() {
      return axisVersion
    },
    get positionAxis() {
      return positionAxis
    },
    get valueAxis() {
      return valueAxis
    },
    // DR-2: a non-negative sentinel so a value ref never throws `UnknownEntry`…
    entryIndex: () => 0,
    // …and its column degrades to all-NA (client value-column preview is deferred).
    readColumn: () => naColumn(n),
    // annotation columns resolve from the shared warmed cache, keyed by the axis's
    // IDENTITY (else all-NA — including a label that names two axes, which resolves to no
    // key at all rather than to one of the two).
    resolveAnnotation: (axis, name) => {
      const k = key(axis, name)
      return (k ? SHARED_ANNOTATION_CACHE.get(k) : undefined) ?? naColumn(n)
    },
  }

  const refresh = async (): Promise<void> => {
    try {
      declared = (await src.catalog()).axes ?? []
      // Every cached column belongs to a DECLARED axis; one whose axis has left the
      // catalog is unreachable under identity keying, so drop it here rather than let it
      // hold a slot against the cap. `axesByHash` is the membership set (INV-3).
      evictRetiredAxisColumns(projectId, axesByHash({ axes: declared }))
      // The caller's explicit axis names win; otherwise take the catalog's declared
      // order (axis 0 = positions, axis 1 = values). NO domain field name is read.
      //
      // INV-3 — `n` comes off the AXIS, never off a label re-lookup. This used to read
      // `declared.find(a => a.name === positionAxis)?.length`, a round trip out to the
      // label and back: with two axes sharing a label it could resolve to a DIFFERENT
      // axis than the one whose name it had just taken, and report that other axis's
      // cardinality as the position count. Unnamed ⇒ the first declared axis object
      // itself; named ⇒ `axisByLabel`, which refuses an ambiguous label rather than
      // guessing which of the two the caller meant.
      const position = axes.positionAxis
        ? axisByLabel({ axes: declared }, axes.positionAxis)
        : declared[0]
      // An ambiguous label yields NO axis, which would otherwise be an all-NA ctx with
      // no trace of why — the same silent-empty failure the B2 fix above removed. Say it.
      if (axes.positionAxis && !position && declared.some(a => a.name === axes.positionAxis)) {
        console.warn(
          '[workbench] client DataCtx: the position axis label names more than one axis; refusing to guess which',
          projectId,
          axes.positionAxis,
        )
      }
      if (!axes.positionAxis) positionAxis = position?.name ?? ''
      if (!axes.valueAxis) valueAxis = declared[1]?.name ?? ''
      n = position?.length ?? 0
      catalogError = undefined
      axisVersion++
    } catch (e) {
      // Record + surface. A swallowed failure here is indistinguishable from "the
      // project genuinely has no data", and it renders every column empty.
      catalogError = e
      console.error('[workbench] client DataCtx: project catalog read failed', projectId, e)
    }
  }

  const warm = async (refs: ValueRef[]): Promise<void> => {
    // FE-3: bound the shared cache — drop other projects' columns on the active-project
    // read path (keeps only the active project resident) before (re)filling.
    evictForeignProjectColumns(projectId)
    if (n === 0) await refresh()
    await Promise.all(
      refs.map(async ref => {
        // Every ANNOTATION ref (`{col}` / `{metric}` / the general `{axis, annotation}`)
        // is a per-position column readable via the data plane; its cache identity is
        // the (axis, name) PAIR, taken from the ref itself rather than scraped back out
        // of `refKey`'s string with a regex that has to remember to capture the axis
        // group. An `{entry}` ref is NOT client-resolvable (DR-2) → skipped, and
        // `resolveAnnotation` degrades it to all-NA.
        const target = annotationTarget(ref, positionAxis)
        if (!target || !target.name) return
        // No key ⇒ the ref's axis label does not identify ONE declared axis, so there is
        // no slot this column could occupy that would not be some other axis's slot too.
        // Refuse to warm it (`resolveAnnotation` then degrades it to all-NA).
        const k = key(target.axis, target.name)
        if (!k || SHARED_ANNOTATION_CACHE.has(k)) return
        try {
          const raw = await src.readColumn({ artifactId: target.name })
          SHARED_ANNOTATION_CACHE.set(k, toResolvedColumn(raw, n))
          capAnnotationCache()
        } catch {
          /* unreadable → left uncached, resolveAnnotation degrades to all-NA */
        }
      }),
    )
  }

  return { ctx, warm, refresh, lastError: () => catalogError }
}

/** Build a real `WorkbenchHost` bound to a project (the shell's per-project host). */
export function createWorkbenchHost(projectId: string): WorkbenchHost {
  return {
    projectId,
    events: createEventBus(),
    storage: createKeyValueBackend(),
    ui: createUiHost(),
    datatypes: workbenchLattice,
    // No injected planes: each publishing extension builds its REAL backend itself
    // (`extensions/data` → the workstore plane, `extensions/jobs` → the jobs plane).
  }
}

/** The workbench extension id the shell's own API instance is scoped to. */
export const SHELL_EXTENSION_ID = 'cyto.workbench.shell'

/**
 * A memoized `WorkbenchAPI` for the current project — the shell's single handle to
 * the data/compute/registry surface. Re-created only when the project
 * changes (the host binds `projectId`). Extensions/panels read it via a context the
 * shell provides (`useWorkbench`).
 */
export function useWorkbenchApi(projectId: string): WorkbenchAPI {
  return useMemo(
    () => createWorkbenchApi(createWorkbenchHost(projectId), SHELL_EXTENSION_ID),
    [projectId],
  )
}

// --- a seeded FAKE host for the gallery + unit-style e2e seams (no backend) ---
/** The synthetic AXES the fake data plane reports (gallery previews). Core does not
 *  invent an axis NOUN here — the seed may name its own; these are the neutral
 *  defaults the gallery renders against. Each carries a `content_hash` because the
 *  fake plane must report the same SHAPE the real one does (INV-3): a fake that omits
 *  the identity is a surface on which a label-keyed consumer looks correct. */
const FAKE_HOST_AXES: AxisSummary[] = [
  { content_hash: 'fake-axis-positions', name: 'positions', length: 5000 },
  { content_hash: 'fake-axis-values', name: 'values', length: 20_000 },
]

export interface FakeHostSeed {
  projectId?: string
  artifacts?: ArtifactRow[]
  producedTypeIds?: string[]
  /** override the synthetic axes the fake data plane reports. */
  axes?: AxisSummary[]
}

export function makeFakeHost(seed: FakeHostSeed = {}): WorkbenchHost {
  const projectId = seed.projectId ?? 'gallery-project'
  const artifacts = seed.artifacts ?? []
  const axes = seed.axes ?? FAKE_HOST_AXES
  return {
    projectId,
    events: createEventBus(),
    storage: createKeyValueBackend(),
    ui: createUiHost(),
    datatypes: workbenchLattice,
    // The two fake PLANES the gallery/e2e drive the workbench with, injected by
    // capability id. They live with the extensions that consume them, so the real and
    // fake backends of one capability can never drift apart.
    planes: {
      [DATA_CAPABILITY_ID]: makeFakeDataHost({
        projectId,
        artifacts,
        axes,
        isA: (sub, sup) => workbenchLattice.isA(sub, sup),
      }),
      [JOBS_CAPABILITY_ID]: makeFakeJobsHost(),
    },
  }
}
