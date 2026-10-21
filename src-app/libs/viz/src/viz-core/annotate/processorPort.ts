// processorPort.ts — the STABLE, PUBLIC contract between the annotation editor and an
// external "processor" (a segmentation/AI model, a WASM kernel, a remote service, …).
// This is the ITEM-10 seam: pure TYPES only. The editor exposes a `ProcessorPort`; a
// processor depends on nothing of the editor beyond these types.
//
// viz-core purity rule (mirrors `spatial/regionSelect.ts` / `spatial/imageMeta.ts` /
// `annotate/annotateModel.ts`): NO deck.gl / React / store / backend imports here — and,
// crucially for the annotation editor, NO AI/model/onnxruntime import of any kind.
//
// INVARIANTS THIS FILE ANCHORS:
// - INV-3: the editor runs NO inference and bundles NO model. A processor is ALWAYS
//   external; this port only captures gestures + view state and displays/commits the
//   geometry & masks a processor produces. `setPending` is DISPLAY state only — it never
//   triggers inference.
// - INV-4: every coordinate crossing this seam is in FULL-RESOLUTION image pixels
//   (level-independent), the same canonical space `annotateModel.ts` stores. A processor
//   reads full-res coords and writes full-res coords; the editor owns level↔world math.
// - INV-2/DEC-E: a PORT, not a coupling — the dependency arrow is one-way and the barrel
//   is the contract. A committed result is indistinguishable from hand-drawn geometry
//   (undo / reshape / export / link all apply).
//
// STRUCTURED-CLONE SAFETY (DEC-E): every type on this seam is composed of typed arrays +
// plain objects with NO class instances, so `structuredClone(x)` succeeds on every input
// and every result. That makes a future cross-window / Web-Worker / cross-process
// processor a PURE ADDITION — the same values serialize across a `postMessage` boundary
// with zero shape change. Do not introduce Map/Set/Date/class instances here.

import type { Annotation, AnnotationClass } from './annotateModel'

// ── coordinate spaces ─────────────────────────────────────────────────────────

/**
 * The coordinate space a value on this seam is expressed in. Everything a processor
 * reads or writes defaults to `'fullRes'` — full-resolution image pixels, the canonical
 * annotation store space (INV-4). The other members exist so a caller can be explicit;
 * the editor's `coords.ts` facade (ITEM-14) is the ONLY place level↔physical↔world math
 * lives. `{ level: n }` is a plain object (structured-clone-safe), never a class.
 *
 * - `'fullRes'`  — level-0 image pixels (the default / canonical annotation space).
 * - `'physical'` — physical units (usually microns) via the NGFF pixel-size affine.
 * - `'world'`    — deck.gl world/micron space the layers are placed into.
 * - `{ level: n }` — a specific pyramid level's pixels (n = 0 is full-res).
 */
export type AnnotationSpace =
  | 'fullRes'
  | 'physical'
  | 'world'
  | { readonly level: number }

/**
 * An axis-aligned rectangle `[minX, minY, maxX, maxY]` in FULL-RESOLUTION image pixels
 * (INV-4) unless a sibling `space` field says otherwise. A plain readonly tuple —
 * structured-clone-safe. Used for a box gesture, a view/result bounds, and mask extents.
 */
export type WorldRect = readonly [number, number, number, number]

// ── read side (snapshots) ─────────────────────────────────────────────────────

/**
 * A stable, serializable reference to the image currently under annotation. Carries only
 * what a processor needs to fetch or reason about pixels itself — NEVER a live PixelSource
 * / loader handle (that would leak an editor internal and break clone-safety). The
 * processor uses `sourceId` to resolve its own read path; `width`/`height` are the
 * full-resolution pixel dimensions.
 */
export interface ImageRef {
  /** opaque, stable id of the image source (INV-2: the processor resolves pixels itself). */
  readonly sourceId: string
  /** full-resolution width in pixels (level 0). */
  readonly width: number
  /** full-resolution height in pixels (level 0). */
  readonly height: number
  /** number of pyramid levels (1 = single-scale), so a processor can pick a working LOD. */
  readonly levelCount: number
  /** number of channels available for read. */
  readonly channelCount: number
  /** physical size per full-res pixel `[sx, sy]` (usually microns), when known (INV-4). */
  readonly pixelSize?: readonly [number, number]
}

/**
 * A read-only snapshot of the camera — the Vitessce "readable scope" a processor may use
 * to size its work (e.g. run only over the visible region). `center` and `bounds` are in
 * FULL-RESOLUTION pixels (INV-4); `zoom` is deck.gl's log2 zoom. A plain object snapshot,
 * taken fresh per call (stateless-per-call) — mutating it never affects the editor.
 */
export interface ProcessorViewState {
  /** viewport center `[x, y]` in full-res px. */
  readonly center: readonly [number, number]
  /** deck.gl zoom (log2 scale). */
  readonly zoom: number
  /** the visible extent in full-res px (viewport-cull hint for the processor). */
  readonly bounds: WorldRect
}

/**
 * The most recent user gesture the processor may consume as its PROMPT (INV-3: the editor
 * only captures it; the processor decides what to do). A discriminated union — all three
 * arms are plain objects / typed-coordinate arrays (structured-clone-safe). Coordinates
 * are full-res px (INV-4):
 * - `click` — a single point (e.g. a point-prompt / marker seed).
 * - `box`   — an axis-aligned box (e.g. a bounding-box prompt).
 * - `lasso` — a freehand ring, flat interleaved `[x0,y0, x1,y1, …]` (the same path the
 *   editor's `selectRegion` consumes — byte-equal input).
 */
export type Gesture =
  | { readonly kind: 'click'; readonly at: readonly [number, number] }
  | { readonly kind: 'box'; readonly rect: WorldRect }
  | { readonly kind: 'lasso'; readonly ring: Float64Array }

// ── write side (results) ──────────────────────────────────────────────────────

/**
 * A label-mask result: a dense per-pixel id raster the editor renders via
 * `LabelMaskLayer` and can correct in place. `data` is row-major `width × height`, each
 * texel an integer object id (0 = background). `Uint16Array` (≤ 65535 ids) or
 * `Uint32Array` (DEC-D: the editable raster widens to Uint32 so > 65535 ids are
 * representable). All fields typed-array / plain-object — structured-clone-safe, and a
 * typed array passed by reference is zero-copy from a Worker/WASM producer.
 */
export interface LabelMaskResult {
  /** row-major id raster, length === width * height. */
  readonly data: Uint16Array | Uint32Array
  readonly width: number
  readonly height: number
  /**
   * optional id → category-code map (a plain array indexed by object id, NOT a Map, to
   * stay clone-safe). Drives the class LUT for hide/solo/relabel (ITEM-11/12).
   */
  readonly categoryForId?: ReadonlyArray<number>
  /**
   * optional placement of `data` within the full-res image, `[minX,minY,maxX,maxY]` px
   * (INV-4). Absent ⇒ the raster covers the whole full-res image. Lets a processor return
   * only the region it worked on (a dirty-rect commit).
   */
  readonly bounds?: WorldRect
}

/**
 * A GeoJSON-shaped feature a processor commits as vector geometry. Kept deliberately
 * close to `annotateModel.ts` so a commit is INDISTINGUISHABLE from hand-drawn geometry
 * (DEC-E): the editor turns each `GeoFeature` into a stored `Annotation`. Coordinates are
 * flat interleaved xy in full-res px (INV-4). `properties` is the foreign-property
 * passthrough bag (INV-7). A plain object — structured-clone-safe.
 */
export interface GeoFeature {
  /**
   * OPTIONAL stable id the processor wants the created annotation to carry (INV-7). When
   * present it becomes the stored `Annotation.id`, so a re-run (update-by-group) can preserve
   * per-feature identity — supply the SAME id across runs and the feature keeps its id
   * (reference / re-commit / link by id). Absent ⇒ the editor mints a fresh UUID.
   */
  readonly id?: string
  /** geometry as flat rings (polygon: exterior first then holes) or a single point pair. */
  readonly geometry:
    | { readonly kind: 'polygon'; readonly rings: ReadonlyArray<Float64Array> }
    | { readonly kind: 'point'; readonly xy: readonly [number, number] }
    | { readonly kind: 'path'; readonly xy: Float64Array }
  /** class code / key this feature belongs to (resolved against the editor's classes). */
  readonly classId?: string | null
  /** human label. */
  readonly label?: string | null
  /** unmodeled GeoJSON `properties` retained verbatim for lossless round-trip (INV-7). */
  readonly properties?: Readonly<Record<string, unknown>>
}

/**
 * Options every commit shares. `origin` + `groupId` implement napari's "re-run replaces
 * its prior output" contract: a processor stamps its outputs with a stable `origin`, and a
 * second run with the same `origin`/`groupId` UPDATES-by-group rather than appending
 * duplicates. `space` defaults to `'fullRes'` (INV-4). A plain object — clone-safe.
 */
export interface CommitOpts {
  /** stable producer id (e.g. `"sam2"`), so a re-run can replace its own prior output. */
  readonly origin?: string
  /** groups the features/mask of ONE run, for update-by-group replacement. */
  readonly groupId?: string
  /** coordinate space of the committed geometry/mask; defaults to `'fullRes'` (INV-4). */
  readonly space?: AnnotationSpace
  /** default class applied to features that carry no `classId`. */
  readonly defaultClass?: AnnotationClass
}

/**
 * What a commit returns to the processor: the ids the editor assigned. These are the SAME
 * `Annotation.id`s a hand-drawn feature gets, so the processor can later reference,
 * re-commit (update-by-group), or link them. A plain object — structured-clone-safe.
 */
export interface CommitResult {
  /** stable annotation ids the editor assigned to the committed features (in order). */
  readonly ids: readonly string[]
  /** the `groupId` the commit was recorded under (echoed for a subsequent replace). */
  readonly groupId?: string
  /** number of prior features this commit replaced (update-by-group), 0 on first run. */
  readonly replaced: number
}

/**
 * DISPLAY-ONLY progress/pending state a processor pushes so the editor can show "working…"
 * (INV-3: this NEVER runs inference — it only paints a hint). `progress` is 0..1 when
 * known; `region` is the full-res px area being worked on (a spinner/overlay bound). A
 * plain object — structured-clone-safe. Passing `null` to `setPending` clears it.
 */
export interface PendingState {
  /** short status label shown to the user (e.g. "Segmenting…"). */
  readonly message?: string
  /** 0..1 fractional progress, when the processor reports it. */
  readonly progress?: number
  /** the full-res px region the processor is working on (INV-4), for a bounded overlay. */
  readonly region?: WorldRect
}

// ── the port ──────────────────────────────────────────────────────────────────

/**
 * The stable, semver-public seam an external processor drives. Minted per editor instance
 * by the `adapter/` factory (out of scope here — this file is pure types). Every method is
 * STATELESS-PER-CALL: reads return a fresh snapshot (mutating it never touches the editor);
 * writes are self-contained (no session/handshake to hold). All coordinates are
 * FULL-RESOLUTION image pixels (INV-4) unless a `space` opt says otherwise. The editor
 * runs NO model — a processor supplies every mask/geometry (INV-3).
 */
export interface ProcessorPort {
  /**
   * READ — a serializable reference to the image under annotation (dimensions, level &
   * channel counts, physical pixel size). NEVER a live loader (INV-2). Fresh per call.
   */
  getImageRef(): ImageRef

  /**
   * READ — a snapshot of the camera (center/zoom/visible bounds) in full-res px (INV-4),
   * so a processor can scope work to the visible region. Stateless-per-call: the returned
   * object is a copy; mutating it does not move the camera.
   */
  getViewState(): ProcessorViewState

  /**
   * READ — the most recent user gesture (`click` | `box` | `lasso`) the processor may use
   * as its prompt, in full-res px (INV-4); `null` when none is active. The `lasso` ring is
   * byte-equal to `selectRegion`'s input. Fresh snapshot per call; reading it does not
   * consume or clear it, and never triggers inference (INV-3).
   */
  getActiveGesture(): Gesture | null

  /**
   * WRITE — commit vector features as stored annotations, indistinguishable from
   * hand-drawn (undo/reshape/export/link all apply). Coords full-res px (INV-4) unless
   * `opts.space` overrides. Re-running with the same `origin`/`groupId` replaces that
   * group. Returns the assigned ids. Stateless-per-call.
   */
  commitPolygons(features: ReadonlyArray<GeoFeature>, opts?: CommitOpts): CommitResult

  /**
   * WRITE — commit point features (marker/seed outputs) as stored annotations. Same
   * update-by-group + full-res-coords (INV-4) contract as `commitPolygons`. Returns the
   * assigned ids. Stateless-per-call.
   */
  commitPoints(features: ReadonlyArray<GeoFeature>, opts?: CommitOpts): CommitResult

  /**
   * WRITE — commit a dense label mask the editor renders via `LabelMaskLayer` and can
   * correct in place. The id raster is full-res px (INV-4); `result.bounds` may place it
   * within the image (a dirty-rect commit). Uint16/Uint32 accepted by reference
   * (zero-copy). Returns the recorded group's ids/metadata. Stateless-per-call.
   */
  commitLabelMask(result: LabelMaskResult, opts?: CommitOpts): CommitResult

  /**
   * WRITE — set (or clear, with `null`) a DISPLAY-ONLY pending/progress hint. INV-3: this
   * only paints "working…"; it NEVER runs a model. Stateless-per-call — the last value set
   * is what shows.
   */
  setPending(pending: PendingState | null): void
}

// Re-export the shared annotation types a processor commonly needs alongside the port, so
// consumers import the whole seam from ONE barrel entry (DEC-E: the barrel is the contract).
export type { Annotation, AnnotationClass }
