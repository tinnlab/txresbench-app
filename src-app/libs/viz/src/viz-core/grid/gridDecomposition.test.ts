// gridDecomposition.test.ts — the INV-10 / DEC-19 STRUCTURAL GUARD, read as source text.
//
// Technique borrowed verbatim from `src/viz-core/tools/registry.test.ts`, which already reads
// `grid/PaneToolbar.tsx` / `grid/GridWorkspace.tsx` as strings to enforce a structural rule. No new
// dependency, and it survives the `.lifecycle/` merge strip because it lives in product test source.
//
// SCOPE CAP (DEC-23 / GUARD-SUB). This guard is deliberately limited to MECHANICALLY DECIDABLE
// facts — a file exists, an identifier is present/absent, a dep list is exactly this list. It is
// never extended to stand in for a behavioural property: a source-string guard asserting a semantic
// property has an unbounded evasion space, so each audit round would find another spelling and the
// finding profile would never decay. Behaviour is proven at the e2e tier instead.
//
// `registry.test.ts:471` is the in-tree counter-example this file is written against: a NEGATIVE
// source assertion (`src` must not match X) passes VACUOUSLY the moment the code it names moves to
// another file — the guard silently stops guarding. So every absence assertion here is paired with
// a POSITIVE one (the identifier is present in the file that now claims it).
//
// Current coverage: ALL SIX SPLITS — 0a (ITEM-14, the seam), 0b (ITEM-21, the per-cell display
// store, guarded in `cellDisplayStore.test.ts`), A (ITEM-5/6, deck + camera), B (ITEM-16, the
// overlays), C (ITEM-17, the docks), D (ITEM-15, the pane chrome) — plus the SPLIT E block at the
// bottom, which is the whole-decomposition guard: the layer set, the acyclicity MATRIX over every
// pair, the ratchet CHAIN, and the ownership of the OTHER source-reading guard in this package.
// Thresholds move DOWN, never up.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments } from '../../../tests/sourceScan'

const here = dirname(fileURLToPath(import.meta.url))
const read = (f: string) => readFileSync(join(here, f), 'utf8')
/** How many times `needle` occurs in `haystack`. The wiring clauses assert this against an EXACT
 *  expected count rather than with `toContain`, for DEC-35's reason: a token threaded to N shell
 *  sites is satisfied by ONE surviving site, so a substring test certifies "the plane's output
 *  reaches SOMETHING" and is blind to a half-disconnected consumer. Splits P–S were converted when
 *  DEC-35 was recorded; Splits H–O were flagged known-weak there and converted afterwards. */
const sites = (haystack: string, needle: string) => haystack.split(needle).length - 1
/** The plane's RETURN block, with its anchor asserted PRESENT (FIX_ROUND-2 / C4).
 *
 *  Every "X is not returned" clause below is a NEGATIVE assertion over `plane.slice(anchor)`, and the
 *  anchor was an unguarded `lastIndexOf('return {')`: absent, that is `-1`, `slice(-1)` is the FINAL
 *  CHARACTER of the file, and every following `expect(...includes(name)).toBe(false)` passes on a
 *  one-character string. So `return{`, `return Object.freeze({`, or a differently-broken line would
 *  let the plane EXPORT the very setters these clauses exist to keep internal — silently.
 *
 *  This is the discipline `paneToolbarItems.test.ts` already applies to its own bounds
 *  (`expect(indexOf).toBeGreaterThan(-1)` on both ends); it was simply not applied here. */
const returnBlock = (plane: string, file: string): string => {
  const at = plane.lastIndexOf('return {')
  expect(
    at,
    `${file}: no \`return {\` block found — the "not returned" clauses below would assert over the ` +
      "file's last character and pass vacuously. Did the plane's return shape change?",
  ).toBeGreaterThan(-1)
  return plane.slice(at)
}

/** Every `.ts`/`.tsx` in the grid directory. Used by the "exactly one definition" clauses — a
 *  package-wide sweep is the only form that catches a helper COPIED rather than moved, which a
 *  two-file present/absent pair cannot see. */
const allGridFiles = (): string[] =>
  // `.test.tsx` too, not just `.test.ts` (FIX_ROUND-2 / C17). The filter excluded ONE of the two
  // test extensions, so a component test placed in this directory would be scanned as PRODUCT
  // source — and the "exactly one definition in the package" sweeps below would red on a symbol the
  // test itself named. A false RED, but the same class: a file list that does not mean what it says.
  readdirSync(here).filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
/** Every `.ts`/`.tsx` under `src/`, recursively, as paths relative to THIS directory. The
 *  package-wide form of `allGridFiles` — needed by the "exactly one definition" clauses for symbols
 *  that moved OUT of the grid directory (Split T), where a grid-only sweep would miss the copy. */
const allVizFiles = (): string[] => {
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(dir, e.name), r)
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(r) // C17: both test extensions
    }
  }
  walk(join(here, '../..'), '../..')
  return out
}

// The stripper itself moved to `tests/sourceScan.ts` (FIX_ROUND-2 / C15) so the OTHER source-text
// guard in this package — `paneToolbarItems.test.ts`, which read RAW source — reads through the same
// tested implementation instead of a second copy. The four-case suite below still owns it.
// The guard's own helper is now guarded (DRIFT-50). `stripComments` is the single point every
// absence assertion in this file passes through, so a defect in it is a defect in ALL of them — and
// the defect it had was invisible precisely because it made assertions PASS. The first case below is
// the real shell's real header line, verbatim, and it FAILS on the two-regex implementation.
describe('grid decomposition — the guard\'s own comment stripper', () => {
  it('a `/*` inside a LINE comment does not open a block comment', () => {
    const src = ["// viz-core rule: depends only on @deck.gl/* + react", "import { PaneTree } from './PaneTree'", "/** doc */", "const x = 1"].join('\n')
    const out = stripComments(src)
    expect(out, 'the import must survive — this is the DRIFT-50 regression').toContain("import { PaneTree } from './PaneTree'")
    expect(out).toContain('const x = 1')
    expect(out).not.toContain('viz-core rule')
    expect(out).not.toContain('doc')
  })

  it('a `/*` inside a STRING does not open a block comment', () => {
    const out = stripComments(["const glob = '@deck.gl/*'", 'const y = 2'].join('\n'))
    expect(out).toContain('const y = 2')
    expect(out).toContain("'@deck.gl/*'")
  })

  it('it still removes what it is FOR — both comment forms', () => {
    const out = stripComments(['const a = 1 // trailing', '/* block */ const b = 2', '/**\n * multi\n */\nconst c = 3'].join('\n'))
    expect(out).not.toContain('trailing')
    expect(out).not.toContain('block')
    expect(out).not.toContain('multi')
    for (const keep of ['const a = 1', 'const b = 2', 'const c = 3']) expect(out).toContain(keep)
  })

  // The stripper must not be satisfiable by deletion: a subject that is CODE survives, or every
  // positive assertion in this file becomes the false-FAIL half of the vacuity pair.
  it('applied to the real shell, the import block survives', () => {
    const out = stripComments(readFileSync(join(here, 'GridWorkspace.tsx'), 'utf8'))
    expect(out).toContain("from './PaneTree'")
    expect(out).toContain("from './useGridLinking'")
    expect(out).toContain("from './GridDeckLayer'")
  })
})

const SEAM_FILE = 'GridWorkspaceContext.tsx'
const SHELL_FILE = 'GridWorkspace.tsx'
const DECK_FILE = 'GridDeckLayer.tsx'
const OVERLAY_FILE = 'GridOverlayLayer.tsx'
const DOCK_FILE = 'GridDockLayer.tsx'
const PANE_FILE = 'GridPaneLayer.tsx'
const PANE_DOCKS_STORE = '../../adapter/PaneDocks.store.ts'

// ── THE LIVE CAP, AND WHY IT IS NOT ONE OF THE RECORDED RATCHETS ─────────────────────────────────
//
// Every `SHELL_FILE_LINES_AT_SPLIT_X` below is a MEASUREMENT taken the day that split landed —
// "measured with the tree final … immediately before the commit", as Split S's own doc comment says.
// The descent they record is history and is not edited here. What they were ALSO used for is the
// live check ("the shell is at or below its Split-X ratchet"), and those two roles are not the same
// number: a measurement makes a terrible cap, because it leaves ZERO headroom by construction.
//
// ── THE FAILURE THAT MOTIVATED THIS SPLIT, with the evidence ─────────────────────────────────────
// `main` was RED on three clauses in this file:
//     body 1557 > 1525 · file 1955 > 1906 (Split S) · file 1955 > 1899 (Split T)
// Anchor vs measurement on the day each was set — measured with THIS file's own metrics:
//     Split S (cb7e04b0)  ratchet 1906  file measured 1906   → 100.0 %
//     Split T (66a5a370)  ratchet 1899  file measured 1899   → 100.0 %
//     body    (c446dc37)  cap     1525  body measured 1525   → 100.0 %
// All three were anchored AT the measurement. `domain_surface/mod.rs` warns about exactly this
// shape four constants above its own instance of it — "a floor set just under the measurement is a
// floor that a normal, correct fix breaks" — and at 100.0 % these were not caps at all; they were
// tripwires armed for the next commit that touched the file.
//
// DID THE SHELL BLOAT, OR DID THE ANCHOR GO STALE? The shell GREW, legitimately, and the growth is
// fully accounted — three commits, file/body measured at each:
//     1899 / 1525   66a5a370  (the anchors)
//     1899 / 1525   c6a2e01a  the QC→filter chain            +0 file  +0 body
//     1937 / 1539   9cb6165b  one inset rule                +38 file +14 body
//     1955 / 1557   0176aa1a  hosted-surface close          +18 file +18 body
//     1955 / 1557   main
// Not one line of it is bloat. `9cb6165b` adds a PUBLIC prop (`registerHostedSurfaceClose`), its two
// exported types and their doc comments, plus the `useEffect` that hands the closer over and
// withdraws it on unmount. `0176aa1a` replaces `if (kind === 'edit-plot') … else closeDataTable`
// with an exhaustive `switch` carrying a `never` arm, after a third kind arrived and the `else`
// silently routed it to the wrong close. That last one is the sharpest reading of the defect: an
// exhaustive switch is ~16 lines longer than the two-branch `if` it replaces, so a cap anchored at
// the measurement makes the CORRECT form of a correctness fix a red gate.
//
// THE FRACTION, AND WHAT IT COSTS. The cap is re-anchored at the measurement + 5 %, floored:
//     file 1955 → 2052   (97 lines of headroom)
//     body 1557 → 1634   (77 lines)
// 5 % is chosen against the two things the number trades off, both measured from the chain below:
//   * DETECTION — the guard exists to catch a decomposed plane being RE-ABSORBED. The nineteen
//     recorded splits removed between 7 and 654 lines; 97 lines of headroom still detects fifteen
//     of the nineteen (every split from P upward). The four it goes blind to — Q→R 27, P→Q 43,
//     R→S 50, S→T 7 — are the tail, and no headroom above ~7 lines can see the smallest of them
//     without being the tripwire this block exists to remove.
//   * DURABILITY — the observed legitimate growth is 56 file lines in 12 days (≈4.7/day), so 97
//     lines is roughly three weeks. That is deliberately SHORT rather than generous: a large
//     headroom silently destroys the guard, whereas a short one is fine PROVIDED re-anchoring is
//     cheap. `capFailure` below is what makes it cheap — it prints the arithmetic and the decision
//     procedure into the failure, so the next crossing costs minutes instead of an investigation.
// And `headroomBand` keeps the fraction honest in BOTH directions: a cap re-anchored at +0 (this
// whole defect) fails, and a cap left stale-loose after the shell shrinks fails too — which is what
// keeps the ratchet ratcheting.

/** Re-anchor at the measurement + this. Also the LOWER bound `headroomBand` enforces is `MIN`. */
const CAP_HEADROOM = 0.05
const MIN_CAP_HEADROOM = 0.03
const MAX_CAP_HEADROOM = 0.2

/** The live FILE cap. Not a ratchet value — see the block above. */
const SHELL_FILE_LINES_CAP = 2052
/** The live BODY cap. The tighter of INV-10 (b)'s pair: a file shrinks by moving type declarations
 *  out, a component body cannot. */
const SHELL_BODY_LINES_CAP = 1634

/** The component body's line span, measured from the source so the number cannot drift from a claim
 *  made in prose. Shared by the body cap and the band check. */
const measureShellBody = (): number => {
  const lines = read(SHELL_FILE).split('\n')
  const start = lines.findIndex(l => /^export function GridWorkspace\(/.test(l))
  expect(start, 'the component must be findable').toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  expect(end, 'the component body must be closed at column 0').toBeGreaterThan(start)
  return end - start + 1
}

/** The one sentence a cap failure needs and never carried: the RE-ANCHOR value, and the question to
 *  answer before using it. Modelled on `server/tests/domain_surface/mod.rs::reconcile_hint`, which
 *  was added for the identical failure mode on the floors in that file. */
const capFailure = (what: string, name: string, got: number, cap: number): string =>
  `the shell's ${what} is ${got} against a cap of ${cap}.\n\n` +
  `  RE-ANCHORING THIS CAP — it is the measurement + ${Math.round(CAP_HEADROOM * 100)}%, so ordinary ` +
  `feature work crosses it every few weeks and that is expected. Decide WHICH this is, on evidence, ` +
  `before touching the constant:\n` +
  `    (a) run \`git log -p --follow -- <shell>\` over the commits since the last re-anchor and ` +
  `attribute the delta commit by commit, the way the block above ${name} does. If every commit is ` +
  `feature or correctness work, the growth is ACCOUNTED — re-anchor.\n` +
  `    (b) if a commit moved a decomposed PLANE back into the shell, that is the regression this cap ` +
  `exists to catch: move it back out; do NOT raise the cap.\n` +
  `    (c) accounted case ONLY: set ${name} = ${Math.floor(got * (1 + CAP_HEADROOM))} (${got} + ` +
  `${Math.round(CAP_HEADROOM * 100)}%) and record the re-measure + the per-commit attribution in the ` +
  `block above it, the way this round did.\n` +
  `  The RECORDED ratchets (SHELL_FILE_LINES_AT_SPLIT_*) are measurements, not caps. Do not edit them.`

const expectShellWithinFileCap = (): void => {
  const lines = read(SHELL_FILE).split('\n').length
  expect(lines, capFailure('FILE', 'SHELL_FILE_LINES_CAP', lines, SHELL_FILE_LINES_CAP)).toBeLessThanOrEqual(
    SHELL_FILE_LINES_CAP,
  )
}

/** SPLIT A's move manifest, as DECLARATION forms rather than bare identifiers.
 *
 *  Bare identifiers would be unusable here: this guard reads source TEXT, and every one of these
 *  names still appears in `GridWorkspace.tsx` — in the comments that explain where it WENT. Each
 *  entry is therefore a BINDING form (`const x =`, `const [x, setX] =`, a JSX element open, a window
 *  assignment), which is the mechanically decidable shape of "this lives here". Two of them were
 *  caught by their own prose on the first run — `<DeckGL` matched the comment "`the <DeckGL>
 *  imperative handle`" — so both now carry the character that only the code form has.
 *
 *  Each entry is asserted ABSENT from the shell AND PRESENT in the deck layer — the anti-vacuity
 *  pairing this file exists to enforce (`registry.test.ts:471` is the in-tree counter-example: a
 *  lone absence assertion goes green the moment the code it names is DELETED). */
const SPLIT_A_MOVED: readonly string[] = [
  'const allViewStates =', // the coordination-store camera subscription
  'const [localStates, setLocalStates] =', // the unlinked per-cell camera
  'const sharedBySpace =', // per-coordinate-space shared camera
  'const controlledViewState =', // the derived camera every consumer read
  'const deckViewState =', // + the chart cells' fitted cameras
  'const onViewStateChange =', // the camera write handler
  'const annotLayerCache =', // camera-culled annotation layer cache
  'const annotationLayers =', // …and the memo that culls on the live camera
  'const crossTooltips =', // projects a highlight through each cell's camera
  '<DeckGL\n', // the deck ELEMENT (the trailing newline distinguishes it from prose "<DeckGL>")
  '.__VIZ_GRID_VIEW__ =', // the dev per-cell zoom reader (the ASSIGNMENT, not a mention)
]

/** SPLIT B's move manifest, in the same DECLARATION-form dialect as `SPLIT_A_MOVED` and for the
 *  same reason: every one of these names still appears in `GridWorkspace.tsx`, in the comments that
 *  record where it WENT.
 *
 *  The list is the SILENT-FAILURE guard for this split specifically. Split A's misses were caught by
 *  the compiler because the state it moved was a `useState` inside the component being cut. Split B
 *  moves state whose writers are reachable through refs and callbacks, where a missed writer type-
 *  checks and simply stops working — so the four moved states are each pinned by their DECLARATION
 *  (which no comment can spell) plus the JSX `data-testid` of every overlay they drive.
 *
 *  `finishPolygon` is deliberately ABSENT from this list: the shell keeps a same-named STABLE WRAPPER
 *  that forwards to the layer's handle (the tool rail's `onFinishPolygon` prop must not churn), so an
 *  absence assertion on it would be false. `cancelPolygon` has no such wrapper and IS asserted. */
const SPLIT_B_MOVED: readonly string[] = [
  // ── the four transient states, which are the whole point of the split ─────────────────────────
  'const [rectDraft, setRectDraft] =',
  'const [polyDraft, setPolyDraft] =',
  'const [selHoverMove, setSelHoverMove] =',
  'const [hovered, setHovered] =',
  // ── their WRITERS. A state moved without every writer type-checks and silently stops working ──
  'const onDrawPointerDown =',
  'const onDrawPointerMove =',
  'const onDrawPointerUp =',
  'const onAnnotatePointerDown =',
  'const onAnnotatePointerMove =',
  'const onAnnotatePointerUp =',
  'const onDeckHover =',
  'const cancelPolygon =',
  // ── the gesture bookkeeping + geometry helpers those writers own ──────────────────────────────
  'const grabCommittedAt =',
  'const selPanRef =',
  'const annotatePanRef =',
  'const onDrawWheel =',
  'const wheelRefFor =',
  'const hoveredFields =',
  // ── and the overlay ELEMENTS themselves, by the test id each one is driven through ────────────
  'data-testid="viz-grid-select-overlay"',
  'viz-grid-annotate-overlay-$',
  'viz-grid-bodydrop-$',
  'viz-placement-hint-$',
  'viz-grid-a11y-focus-$',
]

/** The shell's file-line ratchet AT SPLIT A. Measured on the tree this split landed on; INV-10's
 *  final cap (1,600) is reached by Split E and lives in `render-perf-budgets.json`. Kept here, not
 *  there, because the per-split ratchet is this guard's business and the budgets file is the e2e
 *  gate's single source of truth for the PERF budgets, which this split may not touch.
 *  It may only ever be lowered. */
const SHELL_FILE_LINES_AT_SPLIT_A = 6010
/** …and AT SPLIT B. Measured on the tree this split landed on (5,465 by `wc -l`; the assertion
 *  below counts `split('\n')` elements, hence 5,466). Ratcheted DOWN from Split A's
 *  6,010; INV-10's final cap (1,600) is reached by Split E. It may only ever be lowered.
 *  Set with ZERO slack, unlike Split A's, so the shell cannot re-absorb even a few lines silently.
 *
 *  RE-MEASURED once, before this split was committed: the first value (5,454) was taken mid-edit,
 *  the shell then gained 12 more lines of split commentary, and the ratchet was therefore RED on the
 *  very tree it was written to describe. A cap the code has never satisfied is not a zero-slack
 *  ratchet, it is a mis-measurement — and the only safe moment to re-take it is BEFORE the commit,
 *  because from here on every re-measurement is indistinguishable from the regrowth this guard
 *  exists to catch. If this number ever needs raising again, the shell grew: that is the finding,
 *  not the fix. */
const SHELL_FILE_LINES_AT_SPLIT_B = 5466

/** SPLIT C's move manifest, same DECLARATION-form dialect as A and B — and for a sharper reason here
 *  than in either: the shell KEEPS a comment naming every one of these (that is where the reader is
 *  told where they went), so a bare-identifier list would be green on prose alone.
 *
 *  Split C's silent-failure surface is narrower than Split B's: everything it moves is a LEXICAL
 *  binding of the component being cut, so `tsc` catches a missed consumer. The one exception is the
 *  state it moves — `exportTarget` — whose three writers (`openExportCell` / `openExportGrid` /
 *  `closeExport`) are also lexical, which is why the compiler is a real backstop here and was not for
 *  Split B. These entries pin the move itself so the shell cannot re-absorb it. */
const SPLIT_C_MOVED: readonly string[] = [
  // ── the three large inline builders (~380 lines of render helpers) ────────────────────────────
  'const buildEditForm =',
  'const buildExportDialog =',
  'const buildPlotDataTable =',
  // ── the ONE state this split moves, plus its close path ───────────────────────────────────────
  'const [exportTarget, setExportTarget] =',
  'const closeExport =',
  // ── the portal/internal partition + the four per-pane dock loops (INV-8's shape) ──────────────
  'const openIds = [...editCellIds]',
  'const portaled: Array<',
  'const portaledData: Array<',
  'const portaledAnnotate: Array<',
  'const portaledMask: Array<',
  'const annotateDocks = resolveAnnotateDocks({',
  'const maskDocks = resolveMaskDocks({',
  // ── and the surfaces themselves: every portal, and the internal right panel by its test id ────
  'createPortal(',
  'data-testid="viz-edit-panel"',
]

/** …and AT SPLIT C. Measured on the tree this split landed on, AFTER the code was final and
 *  immediately before the commit — DRIFT-19's rule, which exists because Split B's ratchet was taken
 *  mid-edit, the shell then gained 12 lines, and a "zero-slack" cap shipped RED against the very tree
 *  it described. From here on a re-measurement is indistinguishable from the regrowth this guard
 *  catches: if this number ever needs raising, the shell grew, and that is the finding, not the fix. */
const SHELL_FILE_LINES_AT_SPLIT_C = 4812

/** …and AT SPLIT D. Same rule as Split C's: taken with the tree final, immediately before the commit
 *  (DRIFT-19 / DRIFT-23). Zero slack. If this number ever needs raising, the shell grew — that is the
 *  finding, not the fix. */
const SHELL_FILE_LINES_AT_SPLIT_D = 4462

/** The seam members that are NOT `RefObject`s, with the reason each is permitted under DEC-20.
 *  Anything else in the interface must be a `React.RefObject<…>` — see the test below. */
const NON_REF_MEMBERS: Record<string, string> = {
  stores: 'store handle — one identity per <Viz> instance',
  coordination: 'store handle facade — useMemo(…, [stores])',
  cellDisplay: 'store handle — the Split-0b per-cell display slice, one per workspace instance',
  paneDocks: 'store handle — the Split-D per-pane dock slice, one per workspace instance',
}

/** The dep set the seam value may be memoized on — every entry must itself be a stable identity. */
const ALLOWED_SEAM_DEPS = ['cellDisplay', 'coordination', 'paneDocks', 'stores']

describe('grid decomposition — Split 0a (the seam)', () => {
  it('the seam file exists', () => {
    expect(existsSync(join(here, SEAM_FILE))).toBe(true)
  })

  // DEC-20, the load-bearing rule: a per-frame-changing value may NEVER enter this context. The
  // mechanically-decidable form of that rule is "every member is a ref object or a declared store
  // handle", because a ref/store handle cannot change identity per frame by construction.
  it('every seam member is a RefObject or a declared store handle (DEC-20)', () => {
    const src = read(SEAM_FILE)
    const body = src.match(/export interface GridWorkspaceSeam \{([\s\S]*?)\n\}/)
    expect(body, 'GridWorkspaceSeam interface must be declared in the seam file').not.toBeNull()

    // `readonly name: Type` lines, comments and blank lines stripped.
    const members = [...body![1].matchAll(/^\s*readonly\s+(\w+)\s*:\s*(.+?)\s*$/gm)].map(m => ({
      name: m[1],
      type: m[2].replace(/,?$/, ''),
    }))
    expect(members.length, 'the seam must actually declare members').toBeGreaterThan(0)

    for (const { name, type } of members) {
      if (name in NON_REF_MEMBERS) continue
      expect(
        /^React\.RefObject</.test(type),
        `seam member "${name}: ${type}" is neither a RefObject nor a declared store handle — ` +
          'a per-frame-changing value in this context re-couples every consumer (DEC-20)',
      ).toBe(true)
    }
  })

  // The seam's VALUE identity is what consumers actually subscribe to. A dep list containing a
  // reactive value would rebuild the object every frame and re-render every consumer — the exact
  // failure DEC-20 forbids by name, and one that no type check can see.
  it('the shell builds the seam value on a stable dep set only', () => {
    const src = read(SHELL_FILE)
    const memo = src.match(/const seam = useMemo<GridWorkspaceSeam>\(([\s\S]*?)\n  \)/)
    expect(memo, 'GridWorkspace must build the seam through useMemo<GridWorkspaceSeam>').not.toBeNull()
    const deps = memo![1].match(/\n\s*\[([^\]]*)\],?\s*$/)
    expect(deps, 'the seam useMemo must carry an explicit dep list').not.toBeNull()
    const names = deps![1]
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    expect(names.sort()).toEqual(ALLOWED_SEAM_DEPS)
  })

  // The anti-cheat pair (TEST-21): "absent from the shell" must never be satisfiable by DELETING a
  // capability. Every seam member is asserted PRESENT as a real binding, so a member cannot be
  // declared in the interface and quietly never supplied.
  //
  // SPLIT I RELOCATION (DRIFT-33's rule, applied a second time). Four seam refs — `selMultiRef`,
  // `committedByCellRef`, `polySlotRef`, `dragRef` — are now DECLARED in the selection plane and
  // RETURNED to the shell, so `const x = useRef` no longer appears here for them. The assertion was
  // neither deleted nor loosened: the `useRef` form is now required in whichever module OWNS the
  // ref, AND a ref owned by a plane must additionally be threaded back through that plane's
  // destructure in the shell. The property — the seam carries only []-stable identities, and every
  // member is really supplied — is still checked exactly once per member, and it is now checked
  // MORE strictly for the four that moved (two conditions instead of one).
  it('every seam member is really bound, in the shell or in the plane that owns it', () => {
    const seamSrc = read(SEAM_FILE)
    const shellSrc = read(SHELL_FILE)
    const planeSrcs = ALL_HOOKS.map(h => read(h))
    const body = seamSrc.match(/export interface GridWorkspaceSeam \{([\s\S]*?)\n\}/)![1]
    const members = [...body.matchAll(/^\s*readonly\s+(\w+)\s*:/gm)].map(m => m[1])

    for (const name of members) {
      if (name in NON_REF_MEMBERS) {
        // `const x = …` or `const [x] = useState(factory)` — the per-instance store form.
        expect(new RegExp(`const \\[?${name}\\]? = `).test(shellSrc), `${name} must be bound in the shell`).toBe(true)
      } else {
        const decl = new RegExp(`const ${name} = useRef`)
        const inShell = decl.test(shellSrc)
        const owningPlane = planeSrcs.findIndex(src => decl.test(src))
        expect(
          inShell || owningPlane >= 0,
          `${name} must be a useRef in the shell or in a data plane — the seam may only carry []-stable identities`,
        ).toBe(true)
        if (!inShell) {
          // A plane-owned ref must come BACK through that plane's DESTRUCTURE, or the seam hands
          // consumers a different object than the plane writes. Scoped to the destructure BLOCK on
          // purpose: a bare `name,` search anywhere in the shell is satisfied by the seam object
          // literal itself, which made the first version of this assertion vacuous (probe P-I5).
          //
          // `[^}]` and NOT `[\s\S]` (SPLIT J). The lazy `[\s\S]*?` form still ANCHORED at the
          // earliest `const {` in the file and simply ran forward to this call, so the capture was
          // ~600 comma-tokens of unrelated body and the destructure's FIRST member came out glued to
          // the prose above it (`…rule).\n  const {\n    annotateStoresRef`). Split I passed only
          // because none of ITS four refs happened to be listed first — i.e. the guard was one
          // member-ordering away from silent. A class that cannot cross a `}` anchors the match to
          // the nearest enclosing `const {`, which is what "the destructure BLOCK" meant all along.
          const hookName = ALL_HOOKS[owningPlane].replace(/\.ts$/, '')
          const destructure = shellSrc.match(new RegExp(`const \\{([^}]*?)\\} = ${hookName}\\(`))
          expect(destructure, `the shell must destructure ${hookName}'s return`).not.toBeNull()
          expect(
            destructure![1].split(',').map(t => t.trim()).includes(name),
            `${name} is owned by ${ALL_HOOKS[owningPlane]}, so the shell must receive it back through that plane's destructure`,
          ).toBe(true)
        }
      }
    }
    // …and the provider is actually mounted, so the seam is a live contract rather than dead API.
    expect(shellSrc).toContain('<GridWorkspaceSeamProvider value={seam}>')
  })
})

describe('grid decomposition — Split A (the deck + camera layer)', () => {
  it('the deck layer file exists', () => {
    expect(existsSync(join(here, DECK_FILE))).toBe(true)
  })

  // THE POINT OF SPLIT A, in its mechanically-decidable form. INV-1 ("the camera must not re-render
  // pane chrome") held before this split only by memo discipline: `GridWorkspace` still SUBSCRIBED to
  // the camera, so a wheel re-rendered it and re-created every chrome element it returns; `memo` on
  // the chrome could stop the chrome's body re-running but never stop the element being created.
  // After the split it holds STRUCTURALLY, and this pair of assertions is what "structurally" means:
  // the camera bindings are not in the shell at all, and they are in the child that owns them.
  it.each(SPLIT_A_MOVED)('%s moved out of the shell and into the deck layer', decl => {
    const shell = read(SHELL_FILE)
    const deck = read(DECK_FILE)
    expect(shell.includes(decl), `${decl} must NOT be declared in ${SHELL_FILE} after Split A`).toBe(false)
    expect(deck.includes(decl), `${decl} must be declared in ${DECK_FILE} — an absence assertion that is not paired with a presence one is satisfied by DELETING the capability`).toBe(true)
  })

  // The camera crosses UPWARD through ref handles, never downward as a context value (DEC-20). The
  // seam's own "every member is a RefObject or a declared store handle" test already forbids a camera
  // VALUE; this asserts the positive half — that the handles the shell's 12 reads / 6 writes depend
  // on are actually declared, so the split cannot have quietly dropped one. A missed WRITE handle is
  // how a split breaks keyboard panning with no perf signal at all (INV-9).
  it('the seam declares the four ITEM-6 camera handles, and the deck layer fills every one', () => {
    const seam = read(SEAM_FILE)
    const deck = read(DECK_FILE)
    for (const handle of ['viewStateRef', 'onViewStateChangeRef', 'localStatesRef', 'seedViewStateRef']) {
      expect(seam.includes(`readonly ${handle}:`), `${handle} must be a seam member`).toBe(true)
      expect(
        new RegExp(`${handle}\\.current = `).test(deck),
        `${handle} must be FILLED by ${DECK_FILE} — a handle nobody writes reads as an empty camera, which is indistinguishable from "the gesture did nothing"`,
      ).toBe(true)
    }
  })

  // The shell renders the layer, and renders it UNCONDITIONALLY: `localStates` is React state inside
  // it, so a conditional mount would silently reset every pane's camera whenever the grid transiently
  // had no deck-hosted pane, and would leave all four seam handles stale. The visibility decision is
  // a PROP.
  it('the shell mounts the deck layer unconditionally and gates the canvas by prop', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('<GridDeckLayer')
    expect(shell).toMatch(/<GridDeckLayer\n\s+visible=\{/)
    expect(
      /\{glOk && denseRects\.length \+ chartDeckRects\.length > 0 && \(\s*\n\s*<GridDeckLayer/.test(shell),
      'the deck LAYER must not be conditionally mounted — only its <DeckGL> may be gated',
    ).toBe(false)
  })

  // ── THE CAMERA-COMMIT CHOKEPOINT (DEC-46) ─────────────────────────────────────────────────────
  // The camera has FIVE writers and only ONE of them is a callback (`onViewStateChange`). Notifying
  // the shell FROM that callback is therefore a per-writer rule, and a per-writer rule is satisfied
  // by 1 of 5 — which is how the host `dispatchAction`, a popped-out workspace and the image-framing
  // SEED all came to move the deck while an open plot-data table kept listing the pre-move window.
  // The fix is structural: notify from the ONE value every writer lands in. This guard pins the
  // structure, because the failure mode is ADDITIVE — the next writer's author reaches for a sixth
  // call site, each of which looks locally correct.
  //
  // Scope-capped per this file's header: it asserts call-site COUNT and LOCATION (mechanically
  // decidable), never that the notification is correct. That is `plot-data-table-camera.spec.ts`.
  it('onCameraCommit has exactly ONE call site in the package, and it is not in the gesture callback', () => {
    const deck = stripComments(read(DECK_FILE))
    const calls = sites(deck, 'onCameraCommit?.()') + sites(deck, 'onCameraCommit()')
    expect(
      calls,
      'the camera commit must be announced from ONE chokepoint keyed on the camera itself — a second call site means a per-writer rule, and a per-writer rule silently omits the next writer',
    ).toBe(1)
    // …and every OTHER file in the package must not call it at all (a call moved out of the deck
    // layer would pass the count above while re-creating the very fan-out this pins).
    for (const f of allVizFiles()) {
      if (f.endsWith(DECK_FILE)) continue
      const src = stripComments(read(f))
      expect(sites(src, 'onCameraCommit?.()') + sites(src, 'onCameraCommit()'), `${f} must not invoke onCameraCommit`).toBe(0)
    }
    // The one call site is inside the chokepoint EFFECT (keyed on the camera map), not inside the
    // gesture handler: `onViewStateChange` sees writers 1–2 of 5.
    const handler = deck.slice(deck.indexOf('const onViewStateChange = useCallback('))
    const handlerBody = handler.slice(0, handler.indexOf('onViewStateChangeRef.current = onViewStateChange'))
    expect(handlerBody.length, 'anchor for the gesture handler not found — the guard would be vacuous').toBeGreaterThan(200)
    expect(
      handlerBody.includes('onCameraCommit'),
      'onCameraCommit must NOT be invoked from onViewStateChange — that callback is only 2 of the 5 camera writers',
    ).toBe(false)
    // The chokepoint is keyed on the camera's VALUE (the shell turns a commit into a re-render, so
    // an identity key would feed back into this component and loop).
    expect(deck).toContain('cameraSignature(deckViewState)')
  })

  // INV-10's ratchet at this split. Not a proxy for the perf win (that is TEST-P1 / TEST-P6) — it is
  // the anti-REGROWTH guard: without it the shell reabsorbs the next feature and Split B starts from
  // a bigger file than Split A left.
  it('the shell is at or below the LIVE file cap — the Split-A ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })
})

describe('grid decomposition — Split B (the overlay layer)', () => {
  it('the overlay layer file exists', () => {
    expect(existsSync(join(here, OVERLAY_FILE))).toBe(true)
  })

  // THE POINT OF SPLIT B, mechanically. Four states — `rectDraft` (every pointermove of a marquee
  // drag), `hovered` (once per rAF of a cursor sweep), `selHoverMove`, `polyDraft` — were declared in
  // the shell and read ONLY by overlay chrome, so each of those gestures re-rendered the whole
  // 6,000-line closure. Absence-in-the-shell + presence-in-the-layer is what "they moved" means.
  it.each(SPLIT_B_MOVED)('%s moved out of the shell and into the overlay layer', decl => {
    const shell = read(SHELL_FILE)
    const overlay = read(OVERLAY_FILE)
    expect(shell.includes(decl), `${decl} must NOT be declared in ${SHELL_FILE} after Split B`).toBe(false)
    expect(
      overlay.includes(decl),
      `${decl} must be declared in ${OVERLAY_FILE} — an absence assertion that is not paired with a presence one is satisfied by DELETING the capability`,
    ).toBe(true)
  })

  // The two UPWARD handles. `apiRef` is how the shell's four draft-reset sites (leaving Select, the
  // rail's shape switch, `clearGridSelection`, the rail's Finish) still reach state they no longer
  // own; `deckHoverRef` is how deck's `onHover` reaches an owner that is deck's SIBLING. A handle the
  // layer never fills reads as "the gesture did nothing" — the exact silent failure this split risks.
  //
  // RELOCATED at SPLIT S (ITEM-35): the deck-hover FORWARDER (`deckHoverRef.current?.(info)`) used to
  // sit in the shell and now lives in `useGridHover.ts` with the rest of the sink. `overlayApiRef`
  // stays a shell declaration (Split Q borrows it rather than owning it). The guarded property is
  // unchanged: the layer FILLS both handles, somebody forwards deck hover through one, and deck is
  // handed the stable wrapper. Only the location of the forwarder moved. See DRIFT-57.
  it('the overlay layer fills both upward handles, and the hover plane forwards deck hover through one', () => {
    const shell = read(SHELL_FILE)
    const overlay = read(OVERLAY_FILE)
    expect(/apiRef\.current = /.test(overlay), 'GridOverlayLayer must fill apiRef').toBe(true)
    expect(/deckHoverRef\.current = /.test(overlay), 'GridOverlayLayer must fill deckHoverRef').toBe(true)
    expect(shell).toContain('const overlayApiRef = useRef<GridOverlayApi | null>(null)')
    expect(read(HOVER_FILE), 'the sink forwards through the ref').toContain('deckHoverRef.current?.(info)')
    // …and deck is handed the STABLE wrapper, never a handler rebuilt per render (that would defeat
    // GridDeckLayer's memo, which is the only thing keeping the deck out of the shell's render path).
    expect(shell).toContain('onDeckHover={deckHoverSink}')
  })

  // Mounted UNCONDITIONALLY, for the same reason the deck layer is: it owns React state (the drafts
  // and the hover), so a conditional mount would drop an in-flight gesture and leave both upward
  // handles stale. Every visibility decision is a PROP (`drawActive` / `annotateActive` / …).
  it('the shell mounts the overlay layer unconditionally', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('<GridOverlayLayer')
    expect(shell).toMatch(/<GridOverlayLayer\n\s+drawActive=\{/)
    expect(
      /&& \(\s*\n\s*<GridOverlayLayer/.test(shell),
      'the overlay LAYER must not be conditionally mounted — only its individual overlays may be gated',
    ).toBe(false)
  })

  // The seam grew by exactly two members in this split, and both are gesture refs shared between the
  // shell's commit path and the layer's draw handlers. Asserted by NAME so a later split cannot
  // quietly drop one and leave a lasso committing into a stale slot.
  it('the seam carries the two gesture refs Split B shares with the shell', () => {
    const seam = read(SEAM_FILE)
    const overlay = read(OVERLAY_FILE)
    for (const handle of ['polySlotRef', 'dragRef']) {
      expect(seam.includes(`readonly ${handle}:`), `${handle} must be a seam member`).toBe(true)
      expect(overlay.includes(handle), `${handle} must be read by ${OVERLAY_FILE}`).toBe(true)
    }
  })

  // INV-10's ratchet at this split.
  it('the shell is at or below the LIVE file cap — the Split-B ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  // The ratchet is monotone: Split B's cap must be STRICTLY below Split A's, or the guard has stopped
  // guarding while still passing (INV-11's "monotonically non-increasing" clause).
  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_B).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_A)
  })
})

describe('grid decomposition — Split C (the dock layer)', () => {
  it('the dock layer file exists', () => {
    expect(existsSync(join(here, DOCK_FILE))).toBe(true)
  })

  // THE POINT OF SPLIT C, mechanically. ~640 lines of inline render helpers — three large builders,
  // the portal/internal partition and four per-pane dock loops — ran inside the shell's render on
  // every commit, and the export dialog's target was shell state. Absence-in-the-shell +
  // presence-in-the-layer is what "they moved" means, and the pairing is what stops the absence half
  // from being satisfied by DELETING a dock (`registry.test.ts:471` is the in-tree counter-example).
  it.each(SPLIT_C_MOVED)('%s moved out of the shell and into the dock layer', decl => {
    const shell = read(SHELL_FILE)
    const dock = read(DOCK_FILE)
    expect(shell.includes(decl), `${decl} must NOT be declared in ${SHELL_FILE} after Split C`).toBe(false)
    expect(
      dock.includes(decl),
      `${decl} must be declared in ${DOCK_FILE} — an absence assertion that is not paired with a presence one is satisfied by DELETING the capability`,
    ).toBe(true)
  })

  // The UPWARD handle. `exportTarget` lives in the layer, but BOTH its openers render in the shell
  // (a pane toolbar's Export via `<CellView>`, and the tool rail's whole-grid Export), so they reach
  // it exactly the way Split B's four draft-reset sites reach the drafts. A handle the layer never
  // fills reads as "the Export button does nothing" — silent, and invisible to every perf counter.
  //
  // SPLIT M RELOCATION (DRIFT-33's rule, applied a THIRD time — after Split G's `selectSegmentMode`
  // and Split J's `selectAnnotateMode`). `dockApiRef` and both opener bodies moved into the windows
  // plane, so requiring them IN THE SHELL would go red for a correct change. Neither deleted nor
  // loosened: the ref + both openers are now required in the module that OWNS them AND asserted
  // ABSENT from the shell, and the shell must still MOUNT the ref onto the layer. The property —
  // "the layer publishes a handle upward and the openers reach `exportTarget` through it rather than
  // through a reactive prop" — is checked exactly as before, and now additionally pins WHERE.
  it('the dock layer fills its upward handle, and the windows plane drives both openers through it', () => {
    const shell = read(SHELL_FILE)
    const dock = read(DOCK_FILE)
    const plane = read(WINDOWS_FILE)
    expect(/apiRef\.current = /.test(dock), 'GridDockLayer must fill apiRef').toBe(true)
    expect(plane).toContain('const dockApiRef = useRef<GridDockApi | null>(null)')
    expect(plane).toContain('dockApiRef.current?.openExportCell(cellId)')
    expect(plane).toContain('dockApiRef.current?.openExportGrid()')
    expect(stripComments(shell), 'the shell must not re-declare the handle').not.toContain('const dockApiRef =')
    // …and the shell still MOUNTS it, or the layer's handle is filled into a ref nobody reads.
    expect(shell).toContain('apiRef={dockApiRef}')
  })

  // HAZARD THE SPLIT WAS WARNED ABOUT (DRIFT-8's thirteenth camera read). The export dialog's lazy
  // `getVectorScene` reads the camera at EXPORT time through the seam ref — strictly fresher than the
  // render-time `controlledViewState[cellId]` it replaced at Split A. Moving the builder into a
  // component is exactly the moment someone "simplifies" that back into a subscribed camera value,
  // which would put the camera into a component that renders chrome (INV-1) and violate DEC-20.
  it('the export dialog reads the camera through the seam ref, never a subscribed camera value', () => {
    const dock = read(DOCK_FILE)
    expect(dock).toContain('const vs = viewStateRef.current[cellId]')
    // The INDEX form, not the bare identifier: this file's own comment names `controlledViewState`
    // when it records what the read replaced, and a guard matched by the prose that explains it is
    // the vacuity failure this suite is written against (see the header).
    expect(
      /controlledViewState\[/.test(dock),
      'GridDockLayer must not read a camera VALUE — the camera crosses through viewStateRef only (DEC-20)',
    ).toBe(false)
    expect(
      /useStore\([^)]*viewStates/.test(dock),
      'GridDockLayer must not subscribe to the coordination camera record',
    ).toBe(false)
  })

  // Mounted UNCONDITIONALLY, for the same reason the deck and overlay layers are: it owns React state
  // (`exportTarget`), so a conditional mount would drop an open export dialog and leave `dockApiRef`
  // stale. The primary-container decision is a PROP.
  it('the shell mounts the dock layer unconditionally and gates its content by prop', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('<GridDockLayer')
    expect(shell).toMatch(/<GridDockLayer\n\s+isPrimaryContainer=\{/)
    expect(
      /&& \(\s*\n\s*<GridDockLayer/.test(shell),
      'the dock LAYER must not be conditionally mounted — only its individual docks may be gated',
    ).toBe(false)
  })

  // INV-10 (d): no extracted layer may import another extracted layer's private module. Split C is
  // the first split with a genuine pull toward breaking it — three helpers (`EMPTY_HIDDEN`,
  // `hiddenGroupSet`, `filterLegendEntries`) and the mask-review shape are read by BOTH the dock
  // layer and the shell's still-resident legend loop, and the cheap fix would have been to export
  // them from one layer and import them into the other. They went to the shared model modules
  // instead; this asserts the layer graph stayed acyclic.
  it('the dock layer imports no other extracted layer', () => {
    const dock = read(DOCK_FILE)
    for (const other of [DECK_FILE, OVERLAY_FILE, SHELL_FILE]) {
      const mod = other.replace(/\.tsx$/, '')
      expect(
        new RegExp(`from '\\./${mod}'`).test(dock),
        `${DOCK_FILE} must not import ${other} — layers share only the seam and the model modules`,
      ).toBe(false)
    }
    // …and the shared helpers really landed in the model modules both sides already import.
    expect(dock).toMatch(/from '\.\/gridModel'/)
    expect(dock).toMatch(/from '\.\.\/annotate\/maskDock'/)
  })

  // INV-10's ratchet at this split.
  it('the shell is at or below the LIVE file cap — the Split-C ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_C).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_B)
  })
})

/** SPLIT D's move manifest, same DECLARATION-form dialect as A/B/C. The shell keeps a comment naming
 *  the layer and several of the identifiers, so a bare-identifier list would be green on prose alone;
 *  each entry below carries a character only the CODE form has (a JSX open with its newline, a
 *  `data-testid` template, a `function` keyword).
 *
 *  Split D's silent-failure surface is the widest of the four: `<CellView>` is a 25-prop boundary and
 *  four of its props are the open-set membership tests DRIFT-20 pinned in the shell. A prop silently
 *  dropped in the move type-checks only because `CellView` marks it optional, so the manifest pins
 *  the ELEMENTS and the loops, and the separate open-set table below pins the state. */
const SPLIT_D_MOVED: readonly string[] = [
  // ── the content overlay: the seven per-cell providers and the CellView element itself ──────────
  '<ChartSelectModeContext.Provider',
  '<HoverHighlightContext.Provider',
  '<ChartLayerSinkContext.Provider',
  '<CellView\n',
  '<AnnotateProvider store={',
  // ── the per-cell affordances that ride on a pane ──────────────────────────────────────────────
  'viz-cell-dataset-$',
  'viz-cell-link-pick-$',
  'viz-cell-link-popover-$',
  'function linkPickBtnStyle(',
  // ── the in-cell WYSIWYG legend loop, by the element it measures and the three legend bodies ────
  'ref={el => measureLegend(r.id, el, beside)}',
  'viz-cell-legend-$',
  '<InCellLegend\n',
  '<InCellVisualMap\n',
  '<BlendLegend legend={d}',
  // ── and the plot-title overlay ────────────────────────────────────────────────────────────────
  'viz-cell-title-$',
]

/** The FIVE states DRIFT-20 recorded as Split D/E's inherited cargo, in the form
 *  `[the shell declaration that must be gone, the store binding that must exist]`.
 *
 *  This is the pairing that matters most in this split, because the absence half alone is trivially
 *  satisfiable two ways: by DELETING the surface (the `registry.test.ts:471` failure mode) and — new
 *  here — by leaving the state in the shell under a different spelling. The presence half is asserted
 *  against `PaneDocks.store.ts`, which is neither the shell nor any layer, so it also records WHERE
 *  the five went: not into a layer (none of them is read by only one) but into a store all four
 *  readers reach through the seam. */
const SPLIT_D_HOISTED: readonly (readonly [string, string])[] = [
  ['const [editCellIds, setEditCellIds] =', 'readonly editCellIds: ReadonlySet<string>'],
  ['const [dataTableCellIds, setDataTableCellIds] =', 'readonly dataTableCellIds: ReadonlySet<string>'],
  ['const [annotateOpenIds, setAnnotateOpenIds] =', 'readonly annotateOpenIds: ReadonlySet<string>'],
  ['const [segmentOpenIds, setSegmentOpenIds] =', 'readonly segmentOpenIds: ReadonlySet<string>'],
  ['const [maskReview, setMaskReview] =', 'readonly maskReview: Readonly<Record<string, MaskCellReview>>'],
]

describe('grid decomposition — Split D (the pane-chrome layer)', () => {
  it('the pane layer file exists', () => {
    expect(existsSync(join(here, PANE_FILE))).toBe(true)
  })

  // THE POINT OF SPLIT D, mechanically: ~370 lines of per-cell chrome — the `rects.map` -> `<CellView>`
  // content overlay with its seven providers, the in-cell legend loop and the plot-title loop — ran
  // inside the shell's render on every commit. Absence-in-the-shell + presence-in-the-layer is what
  // "they moved" means, and the pairing is what stops the absence half from being satisfied by
  // deleting a pane's chrome outright.
  it.each(SPLIT_D_MOVED)('%s moved out of the shell and into the pane layer', decl => {
    const shell = read(SHELL_FILE)
    const pane = read(PANE_FILE)
    expect(shell.includes(decl), `${decl} must NOT be declared in ${SHELL_FILE} after Split D`).toBe(false)
    expect(
      pane.includes(decl),
      `${decl} must be declared in ${PANE_FILE} — an absence assertion that is not paired with a presence one is satisfied by DELETING the capability`,
    ).toBe(true)
  })

  // DRIFT-20's inherited obligation, discharged. TESTS.md TEST-P8's final manifest requires these
  // five ABSENT from the shell; Split C could not deliver it (four are pinned by `<CellView>`, which
  // leaves the shell only here, and `maskReview` is pinned by the label-mask layer builder). They are
  // absent because they were HOISTED, never because a dock was dropped — which is what the second
  // half of each pair asserts.
  it.each(SPLIT_D_HOISTED)('%s left the shell and lives in the pane-docks store', (shellDecl, storeDecl) => {
    const shell = read(SHELL_FILE)
    const store = readFileSync(join(here, PANE_DOCKS_STORE), 'utf8')
    expect(shell.includes(shellDecl), `${shellDecl} must NOT be declared in ${SHELL_FILE} after Split D`).toBe(false)
    expect(
      store.includes(storeDecl),
      `${storeDecl} must be declared in PaneDocks.store.ts — "absent from the shell" is otherwise satisfied by deleting the surface`,
    ).toBe(true)
  })

  // …and the shell must not have kept a private mirror of any of them. A `useState` was the shape the
  // manifest above pins; this catches the OTHER shape — re-deriving the set into a shell ref, which
  // would type-check, keep every test green, and quietly restore the coupling the hoist removed.
  it('the shell keeps no mirror of the hoisted sets, only the derived modes', () => {
    const shell = read(SHELL_FILE)
    // USAGE forms, not bare identifiers: the shell keeps comments naming `maskReviewRef` and
    // `annotateOpenIdsRef` to record what the store reads replaced, and a guard matched by the prose
    // that explains it is the vacuity failure this suite is written against (see the header).
    for (const mirror of ['annotateOpenIdsRef.current', 'maskReviewRef.current', 'setSegmentOpenIds(', 'setEditCellIds(']) {
      expect(shell.includes(mirror), `${mirror} must be gone from ${SHELL_FILE} — the store is the single owner`).toBe(
        false,
      )
    }
    // The shell's remaining reads are the DERIVED ones, and they must be selector-narrowed rather
    // than a whole-set read: a `useStore(paneDocks, s => s.annotateOpenIds)` here would re-render the
    // shell on every dock open, which is the coupling this split removes.
    expect(shell).toContain('useStore(paneDocks, selectAnyDataTableOpen)')
    // SPLIT G (ITEM-23) RELOCATION, not a relaxation: the SEGMENT mode subscription went with the
    // mask plane into `useGridMasks.ts`. Asserted THERE, and asserted ABSENT here — so the
    // "derived mode, never the set" property is still checked in exactly one place and the shell
    // cannot silently take the subscription back.
    expect(shell).not.toContain('useStore(paneDocks, selectSegmentMode)')
    expect(read('useGridMasks.ts')).toContain('useStore(paneDocks, selectSegmentMode)')
    // SPLIT J (ITEM-26) RELOCATION, on exactly the precedent above: the ANNOTATE mode subscription
    // went with the annotate plane into `useGridAnnotate.ts`. This is the assertion Split J's first
    // `vitest` run turned RED, which is the guard doing its job — the subscription is a coupling
    // this suite tracks by OWNER, not merely by existence.
    expect(shell).not.toContain('useStore(paneDocks, selectAnnotateMode)')
    expect(read('useGridAnnotate.ts')).toContain('useStore(paneDocks, selectAnnotateMode)')
    // …and the whole-SET ban applies to every plane that took a mode, or the ban just moved house.
    for (const src of [shell, read('useGridMasks.ts'), read('useGridAnnotate.ts')]) {
      expect(
        /useStore\(paneDocks, s => s\.(annotateOpenIds|segmentOpenIds|editCellIds|dataTableCellIds)\)/.test(src),
        'no module may subscribe to a whole open SET — only to a derived mode',
      ).toBe(false)
    }
  })

  // The per-CELL boundary is the reason the hoist is a decomposition rather than a relocation. Its
  // mechanically-decidable form: the layer contains a per-cell component that subscribes through the
  // four BOOLEAN selectors, and the layer does NOT take the sets as props (which would put a
  // whole-record value back on the chrome path and make the store pure ceremony).
  it('the pane layer subscribes per CELL, and takes no open set as a prop', () => {
    const pane = read(PANE_FILE)
    expect(pane).toContain('const GridPaneCell = memo(GridPaneCellImpl)')
    for (const sel of ['selectEditOpen', 'selectDataOpen', 'selectAnnotateOpen', 'selectSegmentOpen']) {
      // `(id)` and not `()`: the selector must be resolved for ONE cell, which is the whole
      // difference between a per-cell subscription and a whole-set read with extra steps.
      expect(pane.includes(`${sel}(id)`), `${PANE_FILE} must resolve ${sel} for ONE cell id`).toBe(true)
    }
    expect(pane).toContain('selectCell(id)')
    expect(
      /readonly (editCellIds|dataTableCellIds|annotateOpenIds|segmentOpenIds|maskReview):/.test(pane),
      'the pane layer must not take an open SET as a prop — it subscribes per cell',
    ).toBe(false)
  })

  // Mounted UNCONDITIONALLY, for the same reason as its three siblings — except here the reason is
  // the inverse and worth naming: this layer owns NO state, so a conditional mount would not lose
  // any, but it WOULD unmount every `<CellView>` (and with it every chart cell's canvas + every
  // pane's popped-out-window registration) on a transient empty-catalog render. The catalog gate
  // stays INSIDE, exactly where it was.
  it('the shell mounts the pane layer unconditionally and gates the cells by prop', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('<GridPaneLayer')
    expect(shell).toMatch(/<GridPaneLayer\n\s+chartSelectMode=\{/)
    expect(
      /&& \(\s*\n\s*<GridPaneLayer/.test(shell),
      'the pane LAYER must not be conditionally mounted — only its cell map may be gated',
    ).toBe(false)
    expect(read(PANE_FILE)).toContain('{effectiveCatalog &&')
  })

  // INV-10 (d): the layer graph stays acyclic. Split D is the split most tempted to break it — the
  // pane chrome and the dock layer share the legend records, `filterLegendEntries`/`hiddenGroupSet`/
  // `EMPTY_HIDDEN`, and now the open sets. All of them are reached through shared MODEL modules
  // (`gridModel.ts`) or through the SEAM (the two stores), never by importing a sibling.
  it('the pane layer imports no other extracted layer', () => {
    const pane = read(PANE_FILE)
    for (const other of [DECK_FILE, OVERLAY_FILE, DOCK_FILE, SHELL_FILE]) {
      const mod = other.replace(/\.tsx$/, '')
      expect(
        new RegExp(`from '\\./${mod}'`).test(pane),
        `${PANE_FILE} must not import ${other} — layers share only the seam and the model modules`,
      ).toBe(false)
    }
    expect(pane).toMatch(/from '\.\/gridModel'/)
    expect(pane).toMatch(/from '\.\.\/\.\.\/adapter\/PaneDocks\.store'/)
  })

  // …and the two sibling layers that also read the open sets do it through the SEAM, not as props
  // handed down by the shell. A prop would have kept the shell subscribed to the set (it has to read
  // a value to pass it), which is precisely what DRIFT-20 said pinned them there.
  it('the dock and overlay layers read the open sets off the seam, not as props', () => {
    const dock = read(DOCK_FILE)
    const overlay = read(OVERLAY_FILE)
    expect(dock).toContain('const editCellIds = useStore(paneDocks, s => s.editCellIds)')
    expect(dock).toContain('const maskReview = useStore(paneDocks, s => s.maskReview)')
    expect(overlay).toContain('paneDocks.getState().annotateOpenIds.has(cell)')
    for (const src of [dock, overlay]) {
      expect(
        /readonly (editCellIds|dataTableCellIds|annotateOpenIds|segmentOpenIds|maskReview): /.test(src),
        'an open set handed down as a prop keeps the SHELL subscribed to it — the coupling this split removes',
      ).toBe(false)
    }
  })

  // INV-10's ratchet at this split. Measured with the working tree FINAL and the scratch probes
  // already removed, immediately before the commit — DRIFT-19's rule, restated at Split C as
  // DRIFT-23: a cap taken mid-edit ships RED against the very tree it describes, and from here on a
  // re-measurement is indistinguishable from the regrowth this guard exists to catch.
  it('the shell is at or below the LIVE file cap — the Split-D ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_D).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_C)
  })
})

// ── SPLIT E (ITEM-18) — the whole-decomposition guard ────────────────────────────────────────────
// Each block above guards ONE split against ONE sibling. This block guards the SET: properties that
// are true of the decomposition as a whole and that no per-split block can see, which is exactly the
// class of regression a staged decomposition invites (each split green, the shape still wrong).

/** Every file the decomposition produced, in DEC-20's declared naming. Kept in the guard rather than
 *  read out of `render-perf-budgets.json` so a budgets edit cannot quietly shrink the layer set; the
 *  budgets file's `structural.layerFiles` is asserted to AGREE with this list below, which is the
 *  pairing that makes both authoritative. */
const ALL_LAYERS = [SEAM_FILE, DECK_FILE, OVERLAY_FILE, DOCK_FILE, PANE_FILE] as const

/** …and AT SPLIT E. This split adds guard + ledger only; the ratchet is re-measured anyway, because
 *  a ratchet carried forward on the assumption that nothing changed is not a measurement. Taken with
 *  the tree final, immediately before the commit (DRIFT-19 / DRIFT-23). */
const SHELL_FILE_LINES_AT_SPLIT_E = 4462

describe('grid decomposition — Split E (the whole decomposition)', () => {
  // INV-10 (a). Named individually rather than looped over a glob, so DELETING a layer is a failure
  // rather than a smaller loop.
  it.each(ALL_LAYERS)('%s exists', f => {
    expect(existsSync(join(here, f))).toBe(true)
  })

  // …and the budgets file names the SAME five. Two sources of truth that must agree beats one that
  // can be edited in isolation — a budgets edit dropping a layer would otherwise be invisible here,
  // and a guard edit dropping one would be invisible to the e2e gate.
  it('the budgets file declares exactly the layer set this guard enforces', () => {
    const budgets = JSON.parse(readFileSync(join(here, '../../../scripts/render-perf-budgets.json'), 'utf8'))
    expect([...budgets.structural.layerFiles].sort()).toEqual([...ALL_LAYERS].sort())
  })

  // INV-10 (d) as a MATRIX over every ordered pair, not the four one-off checks the per-split blocks
  // make. The per-split checks each ask "does MY layer import a sibling"; none of them can see a
  // sibling importing a layer that landed LATER, which is precisely the direction a late split adds.
  // The seam and the shared model modules are the only permitted shared surface.
  it('no extracted layer imports any other extracted layer (full pair matrix)', () => {
    const offenders: string[] = []
    for (const a of ALL_LAYERS) {
      const src = read(a)
      for (const b of [...ALL_LAYERS, SHELL_FILE]) {
        if (a === b) continue
        const mod = b.replace(/\.tsx$/, '')
        // The seam is the ONE exception, by construction: it is the shared surface, and every layer
        // imports it. It is also a leaf — asserted separately below.
        if (b === SEAM_FILE) continue
        if (new RegExp(`from '\\./${mod}'`).test(src)) offenders.push(`${a} imports ${b}`)
      }
    }
    expect(offenders, 'layers share only the seam and the model modules (INV-10 (d))').toEqual([])
  })

  // The seam must be a LEAF of the layer graph. A seam that imported a layer would close the cycle
  // the matrix above opens, through the one edge the matrix deliberately exempts.
  it('the seam imports no layer and no shell', () => {
    const seam = read(SEAM_FILE)
    for (const other of [DECK_FILE, OVERLAY_FILE, DOCK_FILE, PANE_FILE, SHELL_FILE]) {
      const mod = other.replace(/\.tsx$/, '')
      expect(new RegExp(`from '\\./${mod}'`).test(seam), `${SEAM_FILE} must not import ${other}`).toBe(false)
    }
  })

  // …and every layer really does mount in the shell. Absence-from-the-shell is meaningless if the
  // layer is never rendered: that is the "satisfied by deleting the capability" failure at the level
  // of a whole component rather than an identifier.
  it.each([DECK_FILE, OVERLAY_FILE, DOCK_FILE, PANE_FILE])('the shell mounts %s', f => {
    expect(read(SHELL_FILE)).toContain(`<${f.replace(/\.tsx$/, '')}`)
  })

  // INV-11's monotonicity clause, as a CHAIN rather than the adjacent pairs each split asserts. An
  // adjacent-pair check cannot see a later split re-raising the cap back above an earlier one.
  //
  // WHAT THE RATCHET CHAIN DOES AND DOES NOT PROVE (a correction of record, FIX_ROUND-2 / C13,
  // AMENDED when the live cap was split out of the recorded ratchets — see `SHELL_FILE_LINES_CAP`).
  // Ledger C observed that only the LAST "the shell is at or below its Split-X ratchet" clause can
  // bind: the shell is far under every earlier threshold, so eighteen of the nineteen are
  // `<current> <= <a bigger number>` and cannot fail on this tree. That is correct, and it is
  // structurally inherent to a ratchet — a threshold that a later split has already beaten is
  // HISTORY, not a live check, and the honest reading of the chain is "this is the recorded descent",
  // not "each split is independently guarded right now".
  //
  // The amendment is that the nineteen clauses no longer PRETEND otherwise. Reading a recorded
  // measurement as a live cap is what put `main` in the red, and it was not confined to the last
  // two: Split R's 1956 sat ONE line above the shell's 1955, so it was the next to fire, and Q
  // (1983) and P (2026) after it. All nineteen now assert the LIVE cap; the constants stay as the
  // recorded descent, which is what the monotonicity clause below quantifies over and what makes a
  // re-raise visible. The nineteen "only ever moved DOWN" tests are likewise comparisons between two
  // file-local literals and assert nothing about product code — they guard the CONSTANTS, which is
  // all they claim to do.
  it('the line ratchet is monotonically non-increasing across every split', () => {
    // ALL TWENTY, not the five this listed before. The clause said "across every split" and
    // quantified over A–E, so a re-raise anywhere in F–T — the fifteen splits that actually took the
    // shell from 4,462 to 1,899 — was invisible to the one test whose job is to see it.
    const chain = [
      ['A', SHELL_FILE_LINES_AT_SPLIT_A],
      ['B', SHELL_FILE_LINES_AT_SPLIT_B],
      ['C', SHELL_FILE_LINES_AT_SPLIT_C],
      ['D', SHELL_FILE_LINES_AT_SPLIT_D],
      ['E', SHELL_FILE_LINES_AT_SPLIT_E],
      ['F', SHELL_FILE_LINES_AT_SPLIT_F],
      ['G', SHELL_FILE_LINES_AT_SPLIT_G],
      ['H', SHELL_FILE_LINES_AT_SPLIT_H],
      ['I', SHELL_FILE_LINES_AT_SPLIT_I],
      ['J', SHELL_FILE_LINES_AT_SPLIT_J],
      ['K', SHELL_FILE_LINES_AT_SPLIT_K],
      ['L', SHELL_FILE_LINES_AT_SPLIT_L],
      ['M', SHELL_FILE_LINES_AT_SPLIT_M],
      ['N', SHELL_FILE_LINES_AT_SPLIT_N],
      ['O', SHELL_FILE_LINES_AT_SPLIT_O],
      ['P', SHELL_FILE_LINES_AT_SPLIT_P],
      ['Q', SHELL_FILE_LINES_AT_SPLIT_Q],
      ['R', SHELL_FILE_LINES_AT_SPLIT_R],
      ['S', SHELL_FILE_LINES_AT_SPLIT_S],
      ['T', SHELL_FILE_LINES_AT_SPLIT_T],
    ] as const
    for (let i = 1; i < chain.length; i++) {
      expect(
        chain[i][1],
        `the ratchet at Split ${chain[i][0]} (${chain[i][1]}) must not exceed Split ${chain[i - 1][0]}'s (${chain[i - 1][1]}) — INV-11 requires monotonically non-increasing thresholds`,
      ).toBeLessThanOrEqual(chain[i - 1][1])
    }
  })

  // ── THE TRIPWIRE DETECTOR: the cap's HEADROOM, checked in both directions ──────────────────────
  // The defect this file shipped was not "the cap was wrong by 50 lines", it was "the cap was
  // anchored AT the measurement", and nothing said so until three commits later when it fired.
  // `domain_surface/mod.rs` learned the same lesson on its floors and fixed the CLASS — re-anchoring
  // the instance AND the five other constants already past its own stated tripwire — rather than the
  // instance. This is the mechanical form of that: the cap must sit inside a BAND above the live
  // measurement.
  //
  //   TOO TIGHT (< MIN) — the defect itself. A cap set at the measurement is a tripwire armed for
  //     the next commit, and it presents as a deterministic red on `main` that costs every branch
  //     cut from it an independent investigation to re-derive the same answer.
  //   TOO LOOSE (> MAX) — the cap has gone STALE in the other direction: the shell shrank and the
  //     cap did not follow, so a whole plane could be re-absorbed inside the slack without the guard
  //     noticing. A ratchet that never tightens is not a ratchet.
  //
  // Both arms print the re-anchor value, so satisfying this is arithmetic rather than judgement.
  it('the live caps sit in the headroom BAND — neither a tripwire nor stale slack', () => {
    const band = (what: string, name: string, got: number, cap: number) => {
      const headroom = cap / got - 1
      const pct = (v: number) => `${(v * 100).toFixed(1)}%`
      expect(
        headroom,
        `${name} (${cap}) is only ${pct(headroom)} above the measured ${what} (${got}). A cap anchored ` +
          `at or just above the measurement is a TRIPWIRE, not a cap — it reds on the next ordinary ` +
          `commit. This is the exact defect this band exists to prevent; it shipped three times in ` +
          `this file at 100.0%. Set ${name} = ${Math.floor(got * (1 + CAP_HEADROOM))}.`,
      ).toBeGreaterThanOrEqual(MIN_CAP_HEADROOM)
      expect(
        headroom,
        `${name} (${cap}) is ${pct(headroom)} above the measured ${what} (${got}) — stale slack. The ` +
          `shell shrank and the cap did not follow, so a decomposed plane could move back inside the ` +
          `slack unnoticed. TIGHTEN it: ${name} = ${Math.floor(got * (1 + CAP_HEADROOM))}.`,
      ).toBeLessThanOrEqual(MAX_CAP_HEADROOM)
    }
    band('FILE lines', 'SHELL_FILE_LINES_CAP', read(SHELL_FILE).split('\n').length, SHELL_FILE_LINES_CAP)
    band('BODY lines', 'SHELL_BODY_LINES_CAP', measureShellBody(), SHELL_BODY_LINES_CAP)
  })

  it('the shell is at or below the LIVE file cap — the Split-E ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  // INV-10's OTHER obligation, and the one most likely to be forgotten because it lives in a
  // different file: `tools/registry.test.ts` reads grid sources as text too, and its two file lists
  // are not extended by a refactor that moves code out of the files they name. An extracted layer
  // that declared a local tool union, or imported a lucide glyph directly, would escape it silently.
  // DEC-19 gives THIS guard ownership of that; here is the mechanically-decidable form of ownership.
  // ── THE RENDER-ORDER INVARIANT BETWEEN TWO SIBLING LAYERS (FIX_ROUND-2 / B4) ────────────────────
  // `viewStateRef.current` is ASSIGNED during `GridDeckLayer`'s render (GridDeckLayer.tsx:220) and
  // READ during `GridDockLayer`'s render (`buildPlotDataTable` / `getVectorScene`). In the shell
  // those two lived in one component; since the decomposition the invariant is carried by nothing
  // but JSX SOURCE ORDER — the deck layer is an earlier sibling, so React renders it first.
  //
  // It holds today, and the consequence of it ceasing to hold is silent: a reorder, or a conditional
  // mount of the deck layer, would freeze an open plot-data table's visible-window rows against a
  // stale camera with no error anywhere. Source order is mechanically decidable, so it is asserted
  // rather than left to a comment (DEC-23's scope cap: a FACT about the file, not a behaviour).
  it('the deck layer renders BEFORE the dock layer, and neither mount is conditional', () => {
    const shell = stripComments(read(SHELL_FILE))
    const deckAt = shell.indexOf('<GridDeckLayer')
    const dockAt = shell.indexOf('<GridDockLayer')
    expect(deckAt, '<GridDeckLayer> must be mounted by the shell').toBeGreaterThan(-1)
    expect(dockAt, '<GridDockLayer> must be mounted by the shell').toBeGreaterThan(-1)
    expect(
      deckAt,
      '<GridDeckLayer> must precede <GridDockLayer> in the shell: the dock layer READS ' +
        '`viewStateRef.current` during render and the deck layer ASSIGNS it during render, so the ' +
        'ordering IS the invariant. Reordering them freezes an open plot-data table against a stale ' +
        'camera, silently.',
    ).toBeLessThan(dockAt)
    // …and neither may become conditional: `{cond && <GridDeckLayer` would skip the assignment on
    // exactly the renders where the dock layer still reads it.
    for (const tag of ['<GridDeckLayer', '<GridDockLayer']) {
      const before = shell.slice(Math.max(0, shell.indexOf(tag) - 120), shell.indexOf(tag))
      expect(
        /[&?]\s*$|&&\s*\(?\s*$/.test(before.trimEnd()),
        `${tag}> must be mounted UNCONDITIONALLY — a guarded mount breaks the render-order handshake`,
      ).toBe(false)
    }
  })

  // ── DEAD SURFACE IS UNFINISHED WORK, AS A RULE OVER THE DIRECTORY (FIX_ROUND-2 / A13 + C10) ─────
  // Two findings of one class, both left by the decomposition and both invisible because nothing
  // looks: `useGridWindows.ts` kept an `import { ContainerWindows }` for an element that stayed in
  // the shell, and `GridWorkspaceContext.tsx` exported a `useGridWorkspaceSeamOptional` hook with
  // zero call sites anywhere in `src-app`. Neither tsc (`noUnusedLocals` is not set on this package)
  // nor a linter (no biome config covers `libs/viz`) sees either one.
  //
  // Guarding the two symbols would encode the two instances. These guard the RULE, over the whole
  // directory, so the next unused import or unwired hook is caught on the day it lands.
  it('no grid module imports a name it never uses', () => {
    const offenders: string[] = []
    for (const f of allGridFiles()) {
      const src = stripComments(read(f))
      // Strip the import statements themselves before counting references, or every import is
      // trivially "used" by its own declaration.
      const body = src.replace(/^\s*import\s[\s\S]*?from\s*'[^']*'\s*$/gm, '').replace(/^\s*import\s*'[^']*'\s*$/gm, '')
      for (const m of src.matchAll(/^\s*import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*'[^']*'/gm)) {
        const names: string[] = []
        if (m[1]) names.push(m[1])
        for (const raw of (m[2] ?? '').split(',')) {
          const n = raw.trim().replace(/^type\s+/, '')
          if (!n) continue
          names.push(n.includes(' as ') ? n.split(' as ')[1].trim() : n)
        }
        for (const n of names) {
          if (!new RegExp(`\\b${n}\\b`).test(body)) offenders.push(`${f}: imports '${n}' and never uses it`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every hook a grid module EXPORTS has a consumer', () => {
    // A hook exported and never called is a seam nobody crossed — the "wire it end-to-end in the
    // same PR" rule, mechanically. Scoped to hooks (`use*`) because those are the decomposition's
    // own surface; exported types are consumed positionally and are idiomatically unnamed at the
    // import site.
    const all = allVizFiles()
    const offenders: string[] = []
    for (const f of allGridFiles()) {
      const src = stripComments(read(f))
      for (const m of src.matchAll(/^export function (use\w+)/gm)) {
        const name = m[1]
        const consumers = all.filter(o => !o.endsWith(`/${f}`) && new RegExp(`\\b${name}\\b`).test(stripComments(read(o))))
        if (consumers.length === 0) offenders.push(`${f}: exports '${name}' with no consumer in the package`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the sibling source guard (tools/registry.test.ts) covers every grid module, by DERIVATION', () => {
    const reg = readFileSync(join(here, '../tools/registry.test.ts'), 'utf8')
    // FIX_ROUND-1 / C4 — this clause used to require the FOUR layer files to appear in the sibling's
    // hand-written lists, and passed while the same decomposition added 23 modules to this directory
    // that no list named. Encoding "the 4 are listed" is encoding the gap, not closing it: the one
    // provably-live omission was `useGridTools.ts`, the file the sibling's own `selTool` guard had
    // just been re-pointed at. So the sibling now DERIVES its scan lists from this directory, and
    // what this owns is that it stays derived — a property no number of listed files can express.
    //
    // FIX_ROUND-2 widens this one step further, for the reason C4 itself gives. Deriving the GRID
    // half while four surfaces OUTSIDE `grid/` stayed hand-named left the same generator running one
    // directory over — and it was already live: the hand-list named two `annotate/` files that no
    // longer import lucide at all, and MISSED `controls/PaneEditForm.tsx` + `export/ExportDialog.tsx`,
    // which do. So the sibling now derives over ALL of `viz-core/`, and what this owns is that its
    // scans iterate a WALK, never a literal array.
    expect(
      reg,
      "registry.test.ts must DERIVE its scan list by walking viz-core (a `vizCoreModules()` readdir), not hand-list files — a hand-list stops guarding silently the moment code moves",
    ).toMatch(/const vizCoreModules = \(\): string\[\] => \{[\s\S]*?readdirSync\(dir, \{ withFileTypes: true \}\)/)
    // …and every scan actually USES it. Three sites: the local-tool-union scan and both
    // ICON_SURFACES lists. A helper that exists but is used in two of three is the same hole.
    expect(
      sites(reg, '= vizCoreModules()'),
      'all three of registry.test.ts scan lists must be assigned vizCoreModules()',
    ).toBe(3)
    // …and no scan may reintroduce a literal file list alongside it.
    expect(
      /const (files|ICON_SURFACES) = \[/.test(reg),
      'a scan list in registry.test.ts is a literal array again — derive it',
    ).toBe(false)
    // Non-vacuity of the derivation itself: the directory it reads is THIS one, and it is not empty.
    expect(allGridFiles().length).toBeGreaterThan(20)
    // …and its NEGATIVE assertion must assert its own precondition, or it goes vacuous the moment
    // `selTool` moves. This is the in-tree counter-example this whole suite is written against, so
    // it is fixed here rather than merely cited.
    expect(reg).toContain('const \\[selTool, setSelTool\\] = useState<SelTool>')
  })

  // ── EVERY memo() WRAPPER PINS ITS DISPLAY NAME (FIX_ROUND-1 / C1) ────────────────────────────────
  // The counter leg keys EVERY chrome budget on a component's display name: the spliced `jsxDEV`
  // resolves an element's name as `type.displayName || type.type.displayName || type.type.name`, so a
  // `memo(XImpl)` whose display name is not pinned reports as `XImpl` — and `byComponent.X` becomes
  // `undefined`, which every budget in the feature reads through `?? 0` as a PERFECT SCORE. Five
  // assertions across TEST-P1 / TEST-3 / TEST-11 / TEST-P3 / TEST-P9f stay green on a tree where
  // `CellView` is re-created on every wheel.
  //
  // This was pinned for `PaneToolbar` (paneToolbarItems.test.ts:43, after the author MEASURED
  // `PaneToolbar=0, PaneToolbarImpl=8`) and NOT for its twin `CellView`, whose source no test in the
  // package read at all. Guarding the twin one file at a time is how the pair came to be half-covered,
  // so this guards the RULE over every `memo()` in the grid directory — the next memo'd chrome
  // component is covered on the day it is written.
  it('every memo() component in the grid pins its display name (an unpinned name reads as a perfect score)', () => {
    const seen: string[] = []
    for (const f of allGridFiles()) {
      const src = stripComments(read(f))
      for (const m of src.matchAll(/(?:export )?const (\w+) = memo\((\w+)\)/g)) {
        const [, outer, inner] = m
        seen.push(`${f}:${outer}`)
        expect(
          new RegExp(`${outer}\\.displayName = '${outer}'`).test(src),
          `${f}: memo(${inner}) is exported as ${outer} but does not pin ${outer}.displayName — the element counter would report '${inner}', and every budget keyed on '${outer}' would then read 0 while the component re-renders`,
        ).toBe(true)
      }
    }
    // Non-vacuity: the sweep must actually have found the memo'd chrome. An empty `seen` (a renamed
    // wrapper, a moved file, a broken comment stripper) would make the loop above assert nothing.
    expect(seen.length, 'the memo sweep found no memo() component at all — the guard would be vacuous').toBeGreaterThanOrEqual(6)
    expect(seen).toContain('CellView.tsx:CellView')
    expect(seen).toContain('PaneToolbar.tsx:PaneToolbar')
  })

  // The INNER pin, for the two chrome components whose zero IS the feature's headline. Kept as an
  // explicit clause (not folded into the sweep above) because it is defence in depth against the
  // OTHER resolution order: it is what makes the name survive even if the memo-object pin is the one
  // that is dropped. `paneToolbarItems.test.ts` already pins PaneToolbar's half; this is the twin
  // that had nothing.
  it('the two chrome components pin the display name on the INNER implementation too', () => {
    expect(stripComments(read('CellView.tsx'))).toMatch(/CellViewImpl\.displayName = 'CellView'/)
    expect(stripComments(read('PaneToolbar.tsx'))).toMatch(/PaneToolbarImpl\.displayName = 'PaneToolbar'/)
  })
})

// ── SPLITS F + G (ITEM-22 / ITEM-23) — THE DATA-PLANE EXTRACTIONS ────────────────────────────────
// Splits A–E moved RENDER surfaces into layers. DEC-26's census showed the residual shell is mostly
// DATA plane — coloring, masks, selection, rasters — which is nobody's layer. These two splits move
// the two largest of those. They produce HOOKS, not layers: neither renders anything, so `ALL_LAYERS`
// is unchanged and the pair matrix above still describes the whole layer graph. What this block adds
// is the property the matrix cannot see — that a hook module does not become a BACK DOOR between two
// layers (a layer importing a hook that imports another layer is a cycle the matrix exempts nothing
// for, because the matrix only walks layer→layer edges).

/** The shell's file-line ratchet AT SPLIT F, and AT SPLIT G. Measured with the working tree FINAL,
 *  the scratch probe directory deleted, the full 15-test render-perf spec green and both unit runs
 *  green, immediately before each commit — DRIFT-19/23/27's rule, applied a fourth time. Zero slack.
 *  They may only ever be lowered; the chain check below enforces that against Split E's.
 *
 *  NOTE what these numbers do NOT say: INV-10 (b)'s final cap is 1,600, and 3,772 is not 1,600. See
 *  DEC-26 — the residual was CENSUSED line by line, the cap is reachable by a twelve-item set with
 *  ~0.3 % slack, and these two splits are the two largest of the twelve. The ratchet is the part of
 *  INV-10 (b) that actually enforces durability, and it is monotone: 6,010 → 5,466 → 4,812 → 4,462
 *  → 4,103 → 3,772. */
const SHELL_FILE_LINES_AT_SPLIT_F = 4103
const SHELL_FILE_LINES_AT_SPLIT_G = 3772

const COLORING_FILE = 'useGridColoring.ts'
const MASKS_FILE = 'useGridMasks.ts'
const DECK_INPUTS_FILE = 'useGridDeckInputs.ts'
const SELECTION_FILE = 'useGridSelection.ts'
const ANNOTATE_FILE = 'useGridAnnotate.ts'
const LINKING_FILE = 'useGridLinking.ts'
const WINDOWS_FILE = 'useGridWindows.ts'
const RASTER_FILE = 'useGridRaster.ts'
const A11Y_FILE = 'useGridA11y.ts'
const DATA_FILE = 'useGridData.ts'
const TOOLS_FILE = 'useGridTools.ts'
const DEV_SEAMS_FILE = 'useGridDevSeams.ts'
const HOVER_FILE = 'useGridHover.ts'
/** Neither a LAYER nor a data-plane HOOK — the split-tree render component (ITEM-28). Kept out of
 *  BOTH lists on purpose: `ALL_LAYERS` is what INV-10 (a) counts, and `ALL_HOOKS` is what the
 *  hook-pair matrix quantifies over. Its graph position is asserted separately, in both directions. */
const PANE_TREE_FILE = 'PaneTree.tsx'
/** Every non-layer module the decomposition produced. Kept separate from `ALL_LAYERS` because the
 *  INV-10 (a) "five layers exist" assertion must NOT silently start counting hooks. */
const ALL_HOOKS = [
  COLORING_FILE,
  MASKS_FILE,
  DECK_INPUTS_FILE,
  SELECTION_FILE,
  ANNOTATE_FILE,
  LINKING_FILE,
  WINDOWS_FILE,
  RASTER_FILE,
  A11Y_FILE,
  DATA_FILE,
  TOOLS_FILE,
  DEV_SEAMS_FILE,
  HOVER_FILE,
] as const

/** SPLIT F's move manifest, in the same DECLARATION-form dialect as Splits A–D — and for the same
 *  reason: the shell KEEPS a comment naming every one of these (that is where the reader is told
 *  where they went), so a bare-identifier list would be satisfied by the prose alone. */
const SPLIT_F_MOVED = [
  'const colorOverridesRef =',
  'const linkedHiddenForRef =',
  'const colorDatasetSig =',
  'const colorSig =',
  'const epochRef =',
  'function withColorOverrides(',
] as const

/** SPLIT G's move manifest, same dialect. */
const SPLIT_G_MOVED = [
  'const [maskData, setMaskData] =',
  'const maskDataRef =',
  'const resolvedLabelMask =',
  'const maskReady =',
  'const segmentCellIds =',
  'const toggleSegmentCell =',
  'const closeSegmentCell =',
  'const maskSessionsRef =',
  'const ensureMaskSession =',
  'const sharedMaskSessionsRef =',
  'const sharedSessionForCell =',
  'const applyMaskPick =',
  'const cellMaskWorldRect =',
  'const shareMaskAcrossGroup =',
  'const detachSharedMask =',
  'const [maskShareNotice, setMaskShareNotice] =',
  'const [maskEpoch, setMaskEpoch] =',
  'const bumpMask =',
  'const patchMaskReview =',
  'const unionDirty =',
] as const

describe('grid decomposition — Splits F + G (the data plane)', () => {
  it.each(ALL_HOOKS)('%s exists', f => {
    expect(existsSync(join(here, f))).toBe(true)
  })

  // TEST-30 / TEST-31, the move halves. Each identifier must be PRESENT in the hook (so "absent from
  // the shell" cannot be satisfied by deleting the feature — DRIFT's standing anti-cheat) and ABSENT
  // from the shell in DECLARATION form.
  it.each(SPLIT_F_MOVED)('SPLIT F: `%s` is declared in the coloring plane and not in the shell', decl => {
    expect(read(COLORING_FILE), `${decl} must be DECLARED by ${COLORING_FILE}`).toContain(decl)
    expect(read(SHELL_FILE), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  it.each(SPLIT_G_MOVED)('SPLIT G: `%s` is declared in the mask plane and not in the shell', decl => {
    expect(read(MASKS_FILE), `${decl} must be DECLARED by ${MASKS_FILE}`).toContain(decl)
    expect(read(SHELL_FILE), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // The shell must CALL both planes. Without this, "absent from the shell" is satisfiable by simply
  // deleting the call — the whole feature would vanish and every assertion above would still pass.
  it('the shell mounts both planes', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('useGridColoring({')
    expect(shell).toContain('} = useGridMasks({')
  })

  // The coloring plane returns NOTHING — that is the property that makes it a store-backed plane
  // rather than a value broker, and it is what actually removed the shell's colour prop-threading.
  // A future edit that starts returning values would re-broker colour through the shell silently.
  it('the coloring plane returns nothing (its outputs are store writes)', () => {
    expect(read(COLORING_FILE)).toMatch(/export function useGridColoring\([\s\S]*?\): void \{/)
    expect(read(COLORING_FILE)).toContain('cellDisplay.getState().replaceColors(')
  })

  // INV-10 (d) extended to the hooks, in BOTH directions. A hook that imported a layer, or a layer
  // that imported a hook, would let two layers reach each other through it.
  it('no hook imports a layer, and no layer imports a hook', () => {
    const offenders: string[] = []
    for (const h of ALL_HOOKS) {
      const src = read(h)
      for (const l of ALL_LAYERS) {
        if (new RegExp(`from '\\./${l.replace(/\.tsx$/, '')}'`).test(src)) offenders.push(`${h} imports ${l}`)
      }
    }
    for (const l of ALL_LAYERS) {
      const src = read(l)
      for (const h of ALL_HOOKS) {
        if (new RegExp(`from '\\./${h.replace(/\.ts$/, '')}'`).test(src)) offenders.push(`${l} imports ${h}`)
      }
    }
    expect(offenders, 'the data-plane hooks are leaves of the layer graph (INV-10 (d))').toEqual([])
  })

  // …and neither hook imports the other. Two planes that referenced each other would be one plane
  // with a seam, and the next split would have nowhere to cut.
  it('the two planes do not import each other', () => {
    expect(read(COLORING_FILE)).not.toContain(`from './${MASKS_FILE.replace(/\.ts$/, '')}'`)
    expect(read(MASKS_FILE)).not.toContain(`from './${COLORING_FILE.replace(/\.ts$/, '')}'`)
  })
  // INV-10's ratchet at these splits.
  it('the shell is at or below the LIVE file cap — the Split-G ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_F).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_E)
    expect(SHELL_FILE_LINES_AT_SPLIT_G).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_F)
  })

  // The cap is NOT met, and this guard says so OUT LOUD rather than passing quietly at 3,772. A
  // suite that is all-green while an invariant is red is how a missed cap becomes invisible; this
  // assertion is the one place the shortfall is mechanically recorded.
  //
  // ITS OWN FORECAST WAS WRONG, and that is recorded rather than quietly edited. This comment used to
  // say the assertion "will FLIP to a plain `toBeLessThanOrEqual(finalCap)` on the day the remaining
  // ten extractions land". Those ten extractions HAVE landed (Splits F–T, ITEM-22 … ITEM-36) and the
  // cap is still missed — 1,899 file / 1,525 body against 1,600 / 1,200. The forecast was computed on
  // DEC-26's GROSS census spans and did not model the WIRING every split adds back (409 lines across
  // twelve plane mounts, measured). DEC-37 carries the region-by-region account and the argument that
  // 1,200 is unreachable by hook extraction at all. Do NOT flip this assertion to satisfy the cap;
  // flipping it requires the cap to be met, which requires re-basing the cap.
  // INV-10 (b) has TWO numbers and only the FILE one was ever asserted. The BODY cap — the tighter of
  // the pair, and the one the invariant is really about (a file can be shrunk by moving type
  // declarations out; a component BODY cannot) — was measured by hand at each split and recorded in
  // prose, which is exactly the "status prose instead of code" failure the guidelines name. Measured
  // here, from the source, so the number cannot drift from the claim.
  // The measurement itself is `measureShellBody`, hoisted to module scope beside the live caps so the
  // headroom-BAND check reads the same number this clause does. One measurement, two readers.
  const measureBody = measureShellBody

  it('INV-10 (b) BODY cap: also NOT met, and the body is the tighter of the two numbers', () => {
    const budgets = JSON.parse(readFileSync(join(here, '../../../scripts/render-perf-budgets.json'), 'utf8'))
    const bodyCap = budgets.structural.gridWorkspaceBodyLines
    expect(bodyCap).toBe(1200)
    const body = measureBody()
    // The body must not re-grow past its LIVE cap. This used to read `toBeLessThanOrEqual(1525)` —
    // the body's measured value at Split T, i.e. a cap with ZERO headroom, which duly went red on
    // `main` at 1557 the moment an exhaustive `switch` replaced a two-branch `if`. See the block
    // beside `SHELL_BODY_LINES_CAP` for the evidence and the fraction.
    expect(body, capFailure('BODY', 'SHELL_BODY_LINES_CAP', body, SHELL_BODY_LINES_CAP)).toBeLessThanOrEqual(
      SHELL_BODY_LINES_CAP,
    )
    expect(
      body,
      `INV-10 (b) BODY is NOT met: ${body} lines against a cap of ${bodyCap}. See DEC-37 — the ` +
        'residual is 593 floor (gridRoot JSX 389 / measurement bindings 118 / renderPopupContainer 49 / ' +
        'seam 35 / return 2) + 409 wiring across twelve plane mounts, and floor+wiring+atomic alone is ' +
        '1,205. Extracting every remaining movable region cannot reach 1,200 because each extraction ' +
        'ADDS wiring. Do not flip this by relaxing the cap.',
    ).toBeGreaterThan(bodyCap)
  })

  it('INV-10 (b) final cap: still NOT met, and the gap is the recorded one', () => {
    const budgets = JSON.parse(readFileSync(join(here, '../../../scripts/render-perf-budgets.json'), 'utf8'))
    const finalCap = budgets.structural.gridWorkspaceFileLines
    expect(finalCap).toBe(1600)
    const lines = read(SHELL_FILE).split('\n').length
    expect(
      lines,
      `INV-10 (b) is NOT met: ${lines} file lines against a cap of ${finalCap}. This is DEC-26's ` +
        'recorded state, not a surprise — the census names the remaining ten extractions. When they ' +
        'land, DELETE this assertion and change the ratchet above to the cap.',
    ).toBeGreaterThan(finalCap)
  })
})

// ── SPLIT H (ITEM-24) — THE DECK LAYER INPUTS ────────────────────────────────────────────────────
// DEC-26's census named twelve movable regions; this is the second-largest and the first of the
// three this wave takes. Like F and G it produces a HOOK, not a layer, so `ALL_LAYERS` and the pair
// matrix above are untouched — but unlike F it RETURNS its outputs, and the assertion below pins
// WHY (a store-backed shape would have to write `layers` from an effect, i.e. an extra render pass
// per hover, which TEST-P1/P5 measure directly). See DEC-27.

/** The shell's file-line ratchet AT SPLIT H. Measured with the working tree final, the scratch probe
 *  directory deleted, the full 15-test render-perf spec green and both unit runs green, immediately
 *  before the commit — DRIFT-19/23/27's rule. Monotone chain: 6,010 → 5,466 → 4,812 → 4,462 →
 *  4,103 → 3,772 → 3,420. */
const SHELL_FILE_LINES_AT_SPLIT_H = 3419

/** SPLIT H's move manifest, in the same DECLARATION-form dialect as every split before it. */
const SPLIT_H_MOVED = [
  'const views =',
  'const layerFilter =',
  'const graphOverlay =',
  'const perCellGroupOverrides =',
  'const cellsForView =',
  'const layers =',
  'const selectionOutlineLayers =',
  'const hoverHighlightLayers =',
  'const chartLayers =',
  'const labelMaskLayers =',
  'const deckLayersBefore =',
  'const HOVER_HIGHLIGHT_RGBA',
] as const

describe('grid decomposition — Split H (the deck layer inputs)', () => {
  // COMMENTS STRIPPED on BOTH sides. The presence half must not be satisfiable by the plane's own
  // prose, and the absence half must not be turned red by the shell's — the same helper, applied
  // symmetrically, because an asymmetric application is itself the failure mode (its docblock says so).
  it.each(SPLIT_H_MOVED)('`%s` is declared in the deck-input plane and not in the shell', decl => {
    expect(stripComments(read(DECK_INPUTS_FILE)), `${decl} must be DECLARED by ${DECK_INPUTS_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // The shell must CALL the plane AND wire every output to the layer prop that consumes it. Asserting
  // the destructure alone would pass while the deck received nothing; asserting the JSX props is the
  // form that cannot be satisfied by a call whose results are dropped on the floor.
  it('the shell mounts the plane and wires all five outputs to their layer props', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain(
      'const { views, layerFilter, cellsForView, deckLayersBefore, labelMaskLayers } = useGridDeckInputs({',
    )
    /** token -> the number of shell sites that must carry it (DEC-35: an EXACT count, never
     *  `toContain`, so a second consumer cannot be silently dropped while one site survives). */
    const WIRED: Readonly<Record<string, number>> = {
      'views={views}': 1,
      'layerFilter={layerFilter}': 1,
      'layersBefore={deckLayersBefore}': 1,
      'layersAfter={labelMaskLayers}': 1,
      'cellsForView={cellsForView}': 1,
    }
    for (const [wire, n] of Object.entries(WIRED)) {
      expect(
        sites(shell, wire),
        `${wire} must reach ALL ${n} of its deck/pane-layer consumers from the plane`,
      ).toBe(n)
    }
  })

  // The plane is PURE — no state, no refs, no effects. That is the property that makes the
  // returns-a-bundle shape correct rather than a compromise (DEC-27), and it is also why `tsc` is a
  // complete writer-set backstop for this split: a declaration with no writer cannot escape.
  //
  // COMMENTS ARE STRIPPED FIRST. Written without that, this assertion went red against a CORRECT
  // tree because the module's own header comment says the words `useState` / `useRef` — the mirror
  // image of the vacuous-pass failure mode this file is written against, and the same fix: assert
  // over code, never over prose.
  it('the deck-input plane holds no state, no refs and no effects', () => {
    const src = stripComments(read(DECK_INPUTS_FILE))
    for (const banned of ['useState', 'useRef', 'useEffect', 'useLayoutEffect', 'useStore(']) {
      expect(src, `${banned} in ${DECK_INPUTS_FILE} would make it a state owner, not a derivation`).not.toContain(banned)
    }
    expect(src).toContain('useMemo')
  })

  // No hook may import another hook, in EITHER direction, for every pair. The Split-F/G block asserts
  // this for its one pair by name; with three hooks that spelling stops being exhaustive.
  it('no hook imports another hook (all pairs)', () => {
    const offenders: string[] = []
    for (const a of ALL_HOOKS) {
      const src = read(a)
      for (const b of ALL_HOOKS) {
        if (a === b) continue
        if (src.includes(`from './${b.replace(/\.ts$/, '')}'`)) offenders.push(`${a} imports ${b}`)
      }
    }
    expect(offenders, 'the data-plane hooks are leaves, and siblings').toEqual([])
  })

  it('the shell is at or below the LIVE file cap — the Split-H ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_H).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_G)
  })
})

// ── SPLIT I (ITEM-25) — THE SELECTION PUBLISH / PROVENANCE / COMMIT PLANE ─────────────────────────
// The third of DEC-26's remaining ten, and the first whose outputs include SEAM refs — which is why
// the seam-binding assertion above was RELOCATED rather than left to pass on the shell alone.

/** The shell's file-line ratchet AT SPLIT I. Measured with the tree final, immediately before the
 *  commit. Monotone chain: 6,010 → 5,466 → 4,812 → 4,462 → 4,103 → 3,772 → 3,419 → 3,087. */
const SHELL_FILE_LINES_AT_SPLIT_I = 3087

/** SPLIT I's move manifest, same declaration-form dialect. */
const SPLIT_I_MOVED = [
  'const exclusiveSel =',
  'const lastExclusiveEpochRef =',
  'const resolveProvenancePane =',
  'const liveProvenanceContext =',
  'const hiddenGroupsSig =',
  'const [polyDraftCount, setPolyDraftCount] =',
  'const finishPolygon =',
  'const [committedByCell, setCommittedByCell] =',
  'const [selMulti, setSelMulti] =',
  'const selMultiRef =',
  'const polySlotRef =',
  'const dragRef =',
  'const committedByCellRef =',
  'const anyCommittedArea =',
  'const [selSpaceHeld, setSelSpaceHeld] =',
  'const selectionIndex =',
  'const publishCellSelection =',
  'const paneIdsOf =',
  'const snapshotContext =',
  'const snapshotContextRef =',
  'const recordCellProvenance =',
  'const publishCellAreas =',
  'const commitRect =',
  'const commitPolygon =',
  'const clearGridSelection =',
] as const

describe('grid decomposition — Split I (the selection plane)', () => {
  it.each(SPLIT_I_MOVED)('`%s` is declared in the selection plane and not in the shell', decl => {
    expect(stripComments(read(SELECTION_FILE)), `${decl} must be DECLARED by ${SELECTION_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // `activeCellRef` is the control: it is a selection ref that did NOT move, because
  // `requestExportCell` writes it too. Without this assertion the manifest above would be equally
  // satisfied by a split that took it — and the shell's export path would have silently lost its
  // pane attribution. A ref with two owners is passed, not taken, and this pins that rule.
  it('`activeCellRef` stayed in the shell — a ref with two owners is passed, not taken', () => {
    expect(stripComments(read(SHELL_FILE))).toContain('const activeCellRef = useRef')
    expect(stripComments(read(SELECTION_FILE))).not.toContain('const activeCellRef =')
    // SPLIT M: `requestExportCell` — `activeCellRef`'s SECOND writer, and the whole reason this ref
    // did not move — is itself now in the windows plane. The clause is RELOCATED, not dropped: the
    // second writer must exist SOMEWHERE and the shell must still hand the ref to BOTH owners, which
    // is a stricter statement than "the shell declares it" ever was. Without this, a split that
    // deleted the export path entirely would satisfy the two assertions above.
    expect(stripComments(read(WINDOWS_FILE)), 'the second writer must exist').toContain('const requestExportCell =')
    expect(stripComments(read(WINDOWS_FILE)), 'and must really write it').toContain('activeCellRef.current = cellId')
    // …and the shell really HANDS it to that second owner. Scoped to the windows plane's ARGUMENT
    // block, for DRIFT-45's reason: a bare `activeCellRef,` search anywhere in the shell is satisfied
    // by the `seam` object literal, which is the exact vacuity probe P-I5 found in the sibling
    // assertion. (`useGridSelection` does NOT receive it: the selection plane attributes a draw
    // through the SEAM, which is why Split I could leave the ref in the shell in the first place.)
    const shell = stripComments(read(SHELL_FILE))
    const args = shell.match(/= useGridWindows\(\{([^}]*?)\}\)/)
    expect(args, 'the shell must call useGridWindows').not.toBeNull()
    expect(
      args![1].split(',').map(t => t.trim()).includes('activeCellRef'),
      'useGridWindows must RECEIVE activeCellRef — the shell owns it, the plane writes it',
    ).toBe(true)
  })

  // The shell must CALL the plane and WIRE its outputs to the three surfaces that consume them —
  // the overlay layer, the tool rail, and the seam. Asserting the destructure alone would pass while
  // the selection went nowhere.
  it('the shell mounts the plane and wires it to the overlay, the rail and the seam', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('} = useGridSelection({')
    /** token -> required shell-site count (DEC-35). `selMulti` reaches TWO surfaces — the overlay
     *  layer and the tool rail — and was the token this split's `toContain` form was blind to. */
    const WIRED: Readonly<Record<string, number>> = {
      'commitRect={commitRect}': 1,
      'commitPolygon={commitPolygon}': 1,
      'publishCellAreas={publishCellAreas}': 1,
      'setCommittedByCell={setCommittedByCell}': 1,
      'onPolyDraftCountChange={setPolyDraftCount}': 1,
      'selSpaceHeld={selSpaceHeld}': 1,
      'onClearSelection={clearGridSelection}': 1,
      'hasSelection={anyCommittedArea}': 1,
      'selMulti={selMulti}': 2,
      'polyDraftCount={polyDraftCount}': 1,
    }
    for (const [wire, n] of Object.entries(WIRED)) {
      expect(sites(shell, wire), `${wire} must reach ALL ${n} of its consumers from the plane`).toBe(n)
    }
  })

  // The provenance half must travel WHOLE. `liveProvenanceContext` is a one-line delegation to
  // `snapshotContextRef`, and the revalidation effect consumes both resolvers — splitting them would
  // have put a ref on one side of a module boundary and its only writer on the other.
  it('the provenance half is whole: resolvers, snapshot and both effects live together', () => {
    const plane = stripComments(read(SELECTION_FILE))
    for (const piece of [
      'revalidateSelectionIn(coord, resolveProvenancePane, liveProvenanceContext)',
      'snapshotContextRef.current(paneIdsOf(',
      'onSelectionPanes(resolveProvenancePane, liveProvenanceContext)',
      'coord.setSelectionProvenance(',
    ]) {
      expect(plane, `${piece} must live in the selection plane`).toContain(piece)
    }
    expect(stripComments(read(SHELL_FILE))).not.toContain('revalidateSelectionIn(')
  })

  it('the shell is at or below the LIVE file cap — the Split-I ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_I).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_H)
  })
})

// ── SPLIT J (ITEM-26) — THE ANNOTATE PLANE ───────────────────────────────────────────────────────
// The fourth of DEC-26's remaining ten. Like Split I it produces a HOOK that owns a SEAM ref, so it
// joins `ALL_HOOKS` above and the relocated seam-binding assertion covers it automatically — which
// is the point of having relocated that assertion rather than special-casing one plane.

/** The shell's file-line ratchet AT SPLIT J. Measured with the tree final, the scratch probe
 *  directory deleted, and both gates green, immediately before the commit (DRIFT-19/23's rule).
 *  Monotone chain: 6,010 → 5,466 → 4,812 → 4,462 → 4,103 → 3,772 → 3,419 → 3,087 → 2,898. */
const SHELL_FILE_LINES_AT_SPLIT_J = 2898

/** SPLIT J's move manifest, in the same declaration-form dialect as every split before it. */
const SPLIT_J_MOVED = [
  'const annotateStoresRef =',
  'const annotateUnsubsRef =',
  'const [annotateEpoch, setAnnotateEpoch] =',
  'const ensureAnnotateStore =',
  'const annotateCellsKey =',
  'const annotateCellIds =',
  'const annotateMode =',
  'const closeAnnotateCell =',
  'const toggleAnnotateCell =',
  'const gestureAnnotateCellRef =',
  'const [boundAnnotateCellId, setBoundAnnotateCellId] =',
  'const fallbackAnnotateStore =',
  'const annotateStoreFor =',
  'const boundAnnotateStore =',
  'const annotateUnproject =',
  'const annotateEditor =',
  'const annotateEditDraftRef =',
  'const processorPortsRef =',
  'const annotateActive =',
] as const

describe('grid decomposition — Split J (the annotate plane)', () => {
  it.each(SPLIT_J_MOVED)('`%s` is declared in the annotate plane and not in the shell', decl => {
    expect(stripComments(read(ANNOTATE_FILE)), `${decl} must be DECLARED by ${ANNOTATE_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // `isPrimaryWorkspace` is the control, and it is a REAL one: it was declared in the middle of the
  // annotate-stores span, so a split that took the span wholesale WOULD have taken it.
  //
  // RELOCATED at SPLIT R (ITEM-34). This clause used to assert the const "stayed in the SHELL —
  // a value with two owners". Its second owner was the window-hook effect, and SPLIT R moved that
  // effect into `useGridDevSeams.ts`, taking the const with it (it had no other code reader). The
  // control's PURPOSE is unchanged — the annotate plane must not have taken it — so only the
  // location half moves. See DRIFT-57.
  it('`isPrimaryWorkspace` is not the ANNOTATE plane\'s — it belongs to the dev-seams plane', () => {
    expect(stripComments(read(ANNOTATE_FILE))).not.toContain('const isPrimaryWorkspace =')
    expect(stripComments(read(DEV_SEAMS_FILE))).toContain('const isPrimaryWorkspace = containerId === PRIMARY_CONTAINER')
    // …and its reader travelled with it, which is what makes it live rather than dead.
    expect(stripComments(read(DEV_SEAMS_FILE)), 'the window-hook effect reads it').toContain('!isPrimaryWorkspace')
  })

  // The two DEV WINDOW SEAMS travel with the maps they publish. This is HAZARD 1's second half —
  // a `window.__viz*` alias is invisible to `tsc`, so "did the seam follow its state" has to be
  // asserted textually or not at all. Split G found `__vizSharedMasks` the hard way.
  it('the dev window seams travel with the maps they alias', () => {
    const plane = stripComments(read(ANNOTATE_FILE))
    const shell = stripComments(read(SHELL_FILE))
    for (const seam of ['__vizAnnotateStores', '__vizProcessorPorts']) {
      expect(plane, `${seam} must be installed from the plane that owns its map`).toContain(seam)
      expect(shell, `${seam} must be gone from the shell`).not.toContain(seam)
    }
    // RELOCATED at SPLIT R: the mask/display seams used to live in the SHELL, which is why this
    // clause could not be a blanket ban. They are now in `useGridDevSeams.ts`, so the scoping control
    // points there — the property being guarded (these two seams moved HERE, those four did not) is
    // unchanged. See DRIFT-57.
    expect(shell, 'no seam is installed by the shell any more').not.toContain('__viz')
    expect(
      stripComments(read(DEV_SEAMS_FILE)),
      'the mask/display window seams are NOT in scope for this split — they are the dev plane\'s',
    ).toContain('__vizSharedMasks')
  })

  // The shell must CALL the plane and WIRE its outputs to the five surfaces that consume them — the
  // seam, the deck, the pane layer, the overlay and the dock. Asserting the destructure alone would
  // pass while the annotate surface went nowhere.
  it('the shell mounts the plane and wires it to the seam, deck, pane, overlay and dock', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('} = useGridAnnotate({')
    /** token -> required shell-site count (DEC-35). Three of these reach TWO surfaces each — the
     *  annotate mode and the bound cell go to the overlay AND the pane chrome, the id set to the
     *  pane layer AND the dock — and a `toContain` form was blind to losing either half. */
    const WIRED: Readonly<Record<string, number>> = {
      'annotateEpoch={annotateEpoch}': 1,
      'annotateMode={annotateMode}': 2,
      'boundAnnotateCellId={boundAnnotateCellId}': 2,
      'annotateEditDraft={annotateEditor.editDraft}': 1,
      'ensureAnnotateStore={ensureAnnotateStore}': 1,
      'annotateCellIds={annotateCellIds}': 2,
      'onAnnotateCell={toggleAnnotateCell}': 1,
      'annotateActive={annotateActive}': 1,
      'gestureAnnotateCellRef={gestureAnnotateCellRef}': 1,
      'setBoundAnnotateCellId={setBoundAnnotateCellId}': 1,
      'annotateStoreFor={annotateStoreFor}': 1,
      'closeAnnotateCell={closeAnnotateCell}': 1,
    }
    for (const [wire, n] of Object.entries(WIRED)) {
      expect(sites(shell, wire), `${wire} must reach ALL ${n} of its consumers from the plane`).toBe(n)
    }
  })

  // The processor half must travel WHOLE. Its `getActiveGesture` reads two refs the EDITOR half owns
  // (`annotateEditDraftRef`, `gestureAnnotateCellRef`) and its mint calls `ensureAnnotateStore`,
  // which the STORES half owns — so a cut anywhere inside this plane strands a reader from its
  // writer. These four strings are the three seams that cut would have severed, plus the NF-7
  // dispose that would otherwise have been left behind with nothing to dispose.
  it('the processor port half is whole: its three cross-half reads and its NF-7 dispose live here', () => {
    const plane = stripComments(read(ANNOTATE_FILE))
    for (const piece of [
      'if (gestureAnnotateCellRef.current !== id) return null',
      'const draft = annotateEditDraftRef.current',
      'const store = ensureAnnotateStore(id)',
      'for (const port of ports.values()) port.dispose()',
    ]) {
      expect(plane, `${piece} must live in the annotate plane`).toContain(piece)
    }
    expect(stripComments(read(SHELL_FILE))).not.toContain('createProcessorPort(')
  })

  it('the shell is at or below the LIVE file cap — the Split-J ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_J).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_I)
  })
})

// ── SPLIT K (ITEM-27) — THE LINK-GROUP PLANE ─────────────────────────────────────────────────────
// The fifth of DEC-26's remaining ten. It joins `ALL_HOOKS`, so the layer/hook acyclicity matrix and
// the relocated seam-binding assertion cover it automatically.

/** The shell's file-line ratchet AT SPLIT K. Measured with the tree final, the scratch probe
 *  directory deleted, and both gates green, immediately before the commit (DRIFT-19/23's rule).
 *  Monotone chain: 6,010 → … → 3,087 → 2,898 → 2,772. */
const SHELL_FILE_LINES_AT_SPLIT_K = 2772

/** SPLIT K's move manifest, in the same declaration-form dialect as every split before it. */
const SPLIT_K_MOVED = [
  'const linkGroups =',
  'const linkColorIdx =',
  'const linkPicking =',
  'const cellLinkGroup =',
  'const linkColorFor =',
  'const linkAnchorDataset =',
  'const linkGroupHidden =',
  'const linkedHiddenFor =',
  'const [linkPopoverCell, setLinkPopoverCell] =',
  'const onToggleLink =',
  'const linkGroupsRef =',
  'const cellLinkGroupRef =',
  'const linkColumnFilterFor =',
  'const [propagateConfirm, setPropagateConfirm] =',
  'const applyDisplayToGroup =',
] as const

describe('grid decomposition — Split K (the link-group plane)', () => {
  it.each(SPLIT_K_MOVED)('`%s` is declared in the link plane and not in the shell', decl => {
    expect(stripComments(read(LINKING_FILE)), `${decl} must be DECLARED by ${LINKING_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // The two BORROWED refs are the control, and they are real ones: `linkColumnFilterFor` READS both
  // from a `[]`-dep callback, so a split that took its whole span WOULD have taken them — and the
  // shell's two writers (`perCellGroupLegendRef.current = …`, `perCellRangeRef.current = …`) would
  // then be writing refs the shell no longer declared. Without this assertion the manifest above is
  // equally satisfied by that split.
  it('`perCellGroupLegendRef` / `perCellRangeRef` stayed in the shell — read here, written there', () => {
    const shell = stripComments(read(SHELL_FILE))
    const plane = stripComments(read(LINKING_FILE))
    for (const ref of ['perCellGroupLegendRef', 'perCellRangeRef']) {
      expect(shell, `${ref} must still be DECLARED by the shell`).toContain(`const ${ref} = useRef`)
      expect(plane, `${ref} must NOT be re-declared by the plane`).not.toContain(`const ${ref} = useRef`)
      expect(shell, `the shell's writer for ${ref} must still be here`).toContain(`${ref}.current = `)
    }
    // …and `perCellRangeRef` reaches a SECOND consumer, which is what makes it two-owner not dead.
    expect(shell, 'the selection plane still borrows perCellRangeRef too').toContain('perCellRangeRef,')
  })

  // HAZARD 1's tsc-invisible half, in its NEGATIVE form. `applyDisplayToGroup` is published on
  // `window.__vizApplyDisplayToGroup` from an effect that ALSO publishes three mask values, so the
  // effect could not travel here — the callback is RETURNED and the effect reads it unchanged. The
  // assertion pins that the seam did NOT move, so "the window hook followed its state" can never be
  // claimed by accident for this split the way it legitimately was for Split J.
  //
  // RELOCATED at SPLIT R (ITEM-34): the publishing effect moved from the shell to
  // `useGridDevSeams.ts`, so the seams are asserted THERE. The guarded property is unchanged — the
  // LINK plane must not install them, and the effect must read the plane's callback rather than a
  // re-declared one, so the identity is still the same seam. See DRIFT-57.
  it('the link dev-window seams are the dev plane\'s, not the link plane\'s', () => {
    const dev = stripComments(read(DEV_SEAMS_FILE))
    const plane = stripComments(read(LINKING_FILE))
    for (const seam of ['__vizApplyDisplayToGroup', '__vizLinkCells']) {
      expect(dev, `${seam} is published by the dev plane's window effect`).toContain(seam)
      expect(plane, `${seam} must NOT be installed from the link plane`).not.toContain(seam)
    }
    // The effect reads the plane's callback rather than a re-declared one — same identity, same seam,
    // and the shell threads it across (the link plane returns it, the dev plane consumes it).
    expect(dev).toContain('w.__vizApplyDisplayToGroup = applyDisplayToGroup')
    expect(read(SHELL_FILE), 'the shell threads the callback from the link plane to the dev plane').toContain(
      'applyDisplayToGroup,',
    )
  })

  // The shell must CALL the plane and WIRE its outputs to the surfaces that consume them. Asserting
  // the destructure alone would pass while every link affordance went dead.
  it('the shell mounts the plane and wires it to the pane layer, the dock and the confirm dialog', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('} = useGridLinking({')
    /** token -> required shell-site count (DEC-35). */
    const WIRED: Readonly<Record<string, number>> = {
      'onToggleLink={onToggleLink}': 1,
      'linkColorFor={linkColorFor}': 1,
      'linkPicking={linkPicking}': 1,
      'linkAnchorDataset={linkAnchorDataset}': 1,
      'linkPopoverCell={linkPopoverCell}': 1,
      'setLinkPopoverCell={setLinkPopoverCell}': 1,
      'applyDisplayToGroup={applyDisplayToGroup}': 1,
      'overwriteLabels={propagateConfirm.overwriteLabels}': 1,
    }
    for (const [wire, n] of Object.entries(WIRED)) {
      expect(sites(shell, wire), `${wire} must reach ALL ${n} of its consumers from the plane`).toBe(n)
    }
    // …and the two hot-path derivations still reach the recolor effect and the layer-inputs memo,
    // which are the consumers a bundle-vs-store choice (DEC-27) is actually about. THREE sites each:
    // the destructure plus both consuming planes — the worst `toContain` blind spot in this split,
    // since two of the three could vanish while the assertion stayed green.
    for (const arg of ['linkedHiddenFor,', 'linkColumnFilterFor,']) {
      expect(
        sites(shell, arg),
        `${arg} must reach ALL 3 sites — the destructure plus the coloring + deck-input planes`,
      ).toBe(3)
    }
  })

  it('the shell is at or below the LIVE file cap — the Split-K ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_K).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_J)
  })
})

// ── SPLIT L (ITEM-28) — THE SPLIT-TREE RENDER COMPONENT ──────────────────────────────────────────
// The census row DRIFT-31 said the file cap was unreachable without. It is neither data nor a hook,
// which is exactly why the "data plane" framing could not see it.

/** The shell's file-line ratchet AT SPLIT L. Measured with the tree final, the scratch probe
 *  directory deleted, and both gates green, immediately before the commit (DRIFT-19/23's rule).
 *  Monotone chain: 6,010 → … → 2,898 → 2,772 → 2,644. */
const SHELL_FILE_LINES_AT_SPLIT_L = 2644

/** SPLIT L's move manifest. Declaration forms as always — every one of these names still appears in
 *  the shell's own prose explaining where they went, and in `PaneTree.tsx`'s header. */
const SPLIT_L_MOVED = [
  'const SEP = 6',
  'function SplitGroup(',
  'function LeafBody(',
  'const FILL: React.CSSProperties =',
  'const LEAF_PANEL_STYLE: React.CSSProperties =',
  'const SPLIT_PANEL_STYLE: React.CSSProperties =',
  'const SEP_V_STYLE: React.CSSProperties =',
  'const SEP_H_STYLE: React.CSSProperties =',
] as const

describe('grid decomposition — Split L (the split-tree render component)', () => {
  it('the component file exists', () => {
    expect(existsSync(join(here, PANE_TREE_FILE))).toBe(true)
  })

  it.each(SPLIT_L_MOVED)('`%s` is declared in the pane-tree module and not in the shell', decl => {
    expect(stripComments(read(PANE_TREE_FILE)), `${decl} must be DECLARED by ${PANE_TREE_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // `PaneTree` itself is the one EXPORT, and the shell must both IMPORT it and RENDER it. The import
  // alone would pass on a dead import; the JSX alone would pass on a shell that re-declared it.
  it('the shell imports the component and still renders it', () => {
    const shell = stripComments(read(SHELL_FILE))
    expect(shell).toContain("import { PaneTree } from './PaneTree'")
    expect(shell).toContain('<PaneTree')
    expect(shell, 'the shell must not re-declare it').not.toContain('function PaneTree(')
    expect(stripComments(read(PANE_TREE_FILE))).toContain('export function PaneTree(')
  })

  // The recursion partner and the pane body stay MODULE-PRIVATE, exactly as they were in the shell.
  // Exporting them would widen the module's API for no consumer — the dead-code class §15 bans.
  it('only `PaneTree` is exported — `SplitGroup` / `LeafBody` stay private', () => {
    const src = stripComments(read(PANE_TREE_FILE))
    expect(src).not.toContain('export function SplitGroup(')
    expect(src).not.toContain('export function LeafBody(')
    expect(src).not.toContain('export const FILL')
  })

  // INV-10 (d), in both directions, for a module that is in NEITHER list. A component the shell
  // renders is a plausible place to smuggle a layer↔layer edge, so the ban is explicit rather than
  // inherited from a matrix that does not quantify over it.
  it('the pane-tree module is a leaf: it imports no layer and no hook, and none imports it', () => {
    const offenders: string[] = []
    const src = read(PANE_TREE_FILE)
    for (const other of [...ALL_LAYERS, ...ALL_HOOKS]) {
      const mod = other.replace(/\.tsx?$/, '')
      if (new RegExp(`from '\\./${mod}'`).test(src)) offenders.push(`${PANE_TREE_FILE} imports ${other}`)
      if (new RegExp(`from '\\./PaneTree'`).test(read(other))) offenders.push(`${other} imports ${PANE_TREE_FILE}`)
    }
    expect(offenders, 'the split-tree component is a leaf of the layer graph (INV-10 (d))').toEqual([])
  })

  // …and INV-10 (a) still counts FIVE layers. A new .tsx beside the layers is the most obvious way
  // to make that assertion drift, so it is re-pinned here at the split that adds one.
  it('adding a non-layer .tsx did not change the declared layer set', () => {
    const budgets = JSON.parse(readFileSync(join(here, '../../../scripts/render-perf-budgets.json'), 'utf8'))
    expect(budgets.structural.layerFiles).toHaveLength(5)
    expect(budgets.structural.layerFiles).not.toContain(PANE_TREE_FILE)
  })

  it('the shell is at or below the LIVE file cap — the Split-L ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_L).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_K)
  })
})

// ── SPLIT M (ITEM-29) — THE DOCK / POPOUT-WINDOW PLANE ───────────────────────────────────────────
// The sixth of DEC-26's remaining ten, and the first whose row named something that could NOT come.

/** The shell's file-line ratchet AT SPLIT M. Measured with the tree final, the scratch probe
 *  directory deleted, and both gates green, immediately before the commit (DRIFT-19/23's rule).
 *  Monotone chain: 6,010 → … → 2,772 → 2,644 → 2,469. */
const SHELL_FILE_LINES_AT_SPLIT_M = 2469

/** SPLIT M's move manifest, in the same declaration-form dialect as every split before it. */
const SPLIT_M_MOVED = [
  'const paneContainer =',
  'const pendingClose =',
  'const popupContainers =',
  'const handleWindowClosed =',
  'const handleAckClose =',
  'const pendingRestore =',
  'const handleMergeRestored =',
  'const handleReopenRestored =',
  'const pendingPlacement =',
  'const dockApiRef =',
  'const openExportCell =',
  'const openExportGrid =',
  'const requestExportCell =',
] as const

describe('grid decomposition — Split M (the dock / popout-window plane)', () => {
  it.each(SPLIT_M_MOVED)('`%s` is declared in the windows plane and not in the shell', decl => {
    expect(stripComments(read(WINDOWS_FILE)), `${decl} must be DECLARED by ${WINDOWS_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // `renderPopupContainer` is NAMED in the census row this split takes, and it deliberately did not
  // come: it renders `<GridWorkspace>` itself, so a hook owning it would import the shell that
  // imports it — a module cycle, and a path from the shell back to itself through a "leaf" plane.
  // Asserted in both directions so its absence reads as a decision, not an oversight, and so a later
  // split cannot quietly move it and re-introduce the cycle.
  it('`renderPopupContainer` stayed in the shell — it IS the recursion point', () => {
    const shell = stripComments(read(SHELL_FILE))
    const plane = stripComments(read(WINDOWS_FILE))
    expect(shell).toContain('const renderPopupContainer = useCallback')
    expect(plane, 'the plane must not own the recursive mount').not.toContain('renderPopupContainer')
    expect(plane, 'and therefore must not import the shell').not.toContain("from './GridWorkspace'")
    // …and it is still WIRED, or the assertion above would pass on a dead callback.
    expect(shell).toContain('renderContainer={renderPopupContainer}')
  })

  // The three BORROWED shell values are the control. `requestExportCell` WRITES `activeCellRef` and
  // the popup resize effect READS `containerRef` / `deckRef` — a span-wholesale move would have taken
  // all three and left nine other `containerRef` readers, the seam's `activeCellRef` publication, and
  // the selection plane's draw attribution reading values the shell no longer had.
  it('`activeCellRef` / `containerRef` / `deckRef` stayed in the shell — passed, not taken', () => {
    const shell = stripComments(read(SHELL_FILE))
    const plane = stripComments(read(WINDOWS_FILE))
    for (const ref of ['activeCellRef', 'containerRef', 'deckRef']) {
      expect(shell, `${ref} must still be DECLARED by the shell`).toContain(`const ${ref} = useRef`)
      expect(plane, `${ref} must NOT be re-declared by the plane`).not.toContain(`const ${ref} = useRef`)
    }
  })

  // `openExportCell` must stay `[]`-STABLE. It is a `<CellView>` prop and `memo(CellView)` is what
  // keeps the chrome off the camera path — a dep list here is an INV-1/INV-2 regression that TEST-P1
  // would catch at 4 minutes, and this catches at 40 ms.
  it('the dock-handle wrappers are []-stable, which is why they are callbacks and not store reads', () => {
    const plane = stripComments(read(WINDOWS_FILE))
    expect(plane).toContain('const openExportCell = useCallback((cellId: string) => {')
    expect(plane).toMatch(/dockApiRef\.current\?\.openExportCell\(cellId\)\s*\n\s*\}, \[\]\)/)
    expect(plane).toContain('const openExportGrid = useCallback(() => dockApiRef.current?.openExportGrid(), [])')
  })

  // No dev window seam is installed from this plane, and the shell keeps the ones it had.
  // RELOCATED at SPLIT R: the positive control (somebody DOES own these seams, so the negative half
  // above is not vacuous) moved from the shell to the dev plane. See DRIFT-57.
  it('the windows plane installs no dev window seam', () => {
    expect(stripComments(read(WINDOWS_FILE))).not.toContain('__viz')
    expect(stripComments(read(DEV_SEAMS_FILE)), 'the dev plane owns the mask/link seams').toContain('__vizSharedMasks')
  })

  it('the shell mounts the plane and wires it to the container windows, the restore dialog and the dock', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('} = useGridWindows({')
    /** token -> required shell-site count (DEC-35). */
    const WIRED: Readonly<Record<string, number>> = {
      'containers={popupContainers}': 1,
      'onWindowClosed={handleWindowClosed}': 1,
      'onAcknowledgeClose={handleAckClose}': 1,
      'pendingClose={pendingClose}': 1,
      'onMerge={handleMergeRestored}': 1,
      'onReopen={handleReopenRestored}': 1,
      'apiRef={dockApiRef}': 1,
      'onExportCell={onRequestExportCell ? requestExportCell : openExportCell}': 1,
    }
    for (const [wire, n] of Object.entries(WIRED)) {
      expect(sites(shell, wire), `${wire} must reach ALL ${n} of its consumers from the plane`).toBe(n)
    }
  })

  it('the shell is at or below the LIVE file cap — the Split-M ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_M).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_L)
  })
})

// ── SPLIT N (ITEM-30) — THE IMAGE / RASTER PLANE ─────────────────────────────────────────────────
// The seventh of DEC-26's remaining ten.

/** The shell's file-line ratchet AT SPLIT N. Measured with the tree final, the scratch probe
 *  directory deleted, and both gates green, immediately before the commit (DRIFT-19/23's rule).
 *  Monotone chain: 6,010 → … → 2,644 → 2,469 → 2,322. */
const SHELL_FILE_LINES_AT_SPLIT_N = 2322

/** SPLIT N's move manifest, in the same declaration-form dialect as every split before it. */
const SPLIT_N_MOVED = [
  'const [imageUnderlays, setImageUnderlays] =',
  'const imageUnderlaysRef =',
  'const imageCellsKey =',
  'const imgFetchMountedRef =',
  'const [imagePyramids, setImagePyramids] =',
  'const imagePyramidsRef =',
  'const setImageChannel =',
  'const setImageColormap =',
  'const autoContrastChannel =',
] as const

describe('grid decomposition — Split N (the image / raster plane)', () => {
  it.each(SPLIT_N_MOVED)('`%s` is declared in the raster plane and not in the shell', decl => {
    expect(stripComments(read(RASTER_FILE)), `${decl} must be DECLARED by ${RASTER_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // HAZARD 7 / DRIFT-25, as a NEGATIVE control with teeth. The camera-framing effect that moved reads
  // `insetPane` — one of INV-10's seven MEASUREMENT bindings, which are pinned to the shell. A split
  // that took the effect's whole span would have taken it, and the shell's `plotInset` (which composes
  // it) plus `denseRectsInset` would then be calling a function the shell no longer had.
  it('the seven measurement bindings are ALL still in the shell, and none is in the raster plane', () => {
    const shell = stripComments(read(SHELL_FILE))
    const plane = stripComments(read(RASTER_FILE))
    for (const b of [
      'const registerPane =',
      'const measure =',
      'const [legendWidths, setLegendWidths] =',
      'const legendWidthsRef =',
      'const legendGutterFor =',
      'const plotInset =',
      'const measureLegend =',
      'const insetPane =',
    ]) {
      expect(shell, `${b} is a DRIFT-25 measurement binding and is pinned to the shell`).toContain(b)
      expect(plane, `${b} must NOT be re-declared by the raster plane`).not.toContain(b)
    }
    // …and the plane really RECEIVES the one it uses, or "pinned" would just mean "unused".
    const args = shell.match(/= useGridRaster\(\{([^}]*?)\}\)/)
    expect(args, 'the shell must call useGridRaster').not.toBeNull()
    expect(args![1].split(',').map(t => t.trim()).includes('insetPane')).toBe(true)
  })

  // `imgFetchMountedRef` CHANGED OWNER with this split (shell → this plane) and it has a reader in a
  // DIFFERENT plane. The shell must thread it from the owner to the borrower, or the mask fetch gets
  // a `undefined` guard and silently abandons in-flight results.
  it('`imgFetchMountedRef` is owned by the raster plane and threaded into the mask plane', () => {
    const shell = stripComments(read(SHELL_FILE))
    expect(stripComments(read(RASTER_FILE))).toContain('const imgFetchMountedRef = useRef(true)')
    expect(shell, 'the shell must not re-declare it').not.toContain('const imgFetchMountedRef =')
    expect(stripComments(read(MASKS_FILE)), 'the mask plane still READS it').toContain('imgFetchMountedRef')
    const args = shell.match(/= useGridMasks\(\{([^}]*?)\}\)/)
    expect(args, 'the shell must call useGridMasks').not.toBeNull()
    expect(
      args![1].split(',').map(t => t.trim()).includes('imgFetchMountedRef'),
      'the shell must hand the raster plane\'s ref to the mask plane',
    ).toBe(true)
  })

  it('the raster plane installs no dev window seam', () => {
    expect(stripComments(read(RASTER_FILE))).not.toContain('__viz')
  })

  it('the shell mounts the plane and wires it to the deck, the pane form and the annotate plane', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('} = useGridRaster({')
    /** token -> required shell-site count (DEC-35). */
    const WIRED: Readonly<Record<string, number>> = {
      'imagePyramids={imagePyramids}': 1,
      'setImageChannel={setImageChannel}': 1,
      'setImageColormap={setImageColormap}': 1,
      'autoContrastChannel={autoContrastChannel}': 1,
    }
    for (const [wire, n] of Object.entries(WIRED)) {
      expect(sites(shell, wire), `${wire} must reach ALL ${n} of its consumers from the plane`).toBe(n)
    }
    // TWO sites each — the destructure plus the annotate plane's argument block. A `toContain` form
    // here was satisfied by the destructure ALONE, i.e. by a plane that received nothing.
    for (const arg of ['imagePyramidsRef,', 'imageUnderlaysRef,']) {
      expect(
        sites(shell, arg),
        `${arg} must reach BOTH sites — the destructure and the annotate plane's argument block`,
      ).toBe(2)
    }
  })

  it('the shell is at or below the LIVE file cap — the Split-N ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_N).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_M)
  })
})

// ── SPLIT O (ITEM-31) — THE ACCESSIBILITY PLANE ──────────────────────────────────────────────────
// The eighth of DEC-26's remaining ten, and the one that forced TWO more symbols out of layer files
// into the neutral module (DRIFT-52, third and fourth occurrence).

/** The shell's file-line ratchet AT SPLIT O. Measured with the tree final, the scratch probe
 *  directory deleted, and both gates green, immediately before the commit (DRIFT-19/23's rule).
 *  Monotone chain: 6,010 → … → 2,469 → 2,322 → 2,206. */
const SHELL_FILE_LINES_AT_SPLIT_O = 2206

/** SPLIT O's move manifest, in the same declaration-form dialect as every split before it. */
const SPLIT_O_MOVED = [
  'const a11yEnabled =',
  'const [kbdFocusVisible, setKbdFocusVisible] =',
  'const markKeyboardDriven =',
  'const clearKeyboardFocusVisible =',
  'const liveRef =',
  'const onGridAnnounceRef =',
  'const say =',
  'const [focusedCellId, setFocusedCellId] =',
  'const effFocusedId =',
  'const effFocusedIdRef =',
  'const denseCellsA11yRef =',
  'const cellMapA11yRef =',
  'const announceFocus =',
  'const focusedRect =',
] as const

describe('grid decomposition — Split O (the accessibility plane)', () => {
  it.each(SPLIT_O_MOVED)('`%s` is declared in the a11y plane and not in the shell', decl => {
    expect(stripComments(read(A11Y_FILE)), `${decl} must be DECLARED by ${A11Y_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // The keyboard bindings must really be MOUNTED here, not merely mentioned. Without this the
  // manifest above is satisfied by a plane that declared the state and dropped both listeners — the
  // whole a11y surface silently inert, with every structural assertion green.
  it('both keyboard surfaces are mounted by the plane, and neither is left in the shell', () => {
    const plane = stripComments(read(A11Y_FILE))
    const shell = stripComments(read(SHELL_FILE))
    expect(plane, 'the dedicated cell-cycling listener').toContain("el.addEventListener('keydown', handler)")
    expect(plane, 'and its teardown').toContain("el.removeEventListener('keydown', handler)")
    expect(plane, 'the camera keys').toContain('useCanvasKeyboard({')
    expect(shell).not.toContain('useCanvasKeyboard({')
  })

  // `clearGridSelection` is owned by the SELECTION plane. Escape must clear the SAME selection the
  // rail's Clear button does — a plane that re-implemented it would pass every assertion above while
  // silently forking the two paths.
  it('Escape clears the SELECTION plane\'s selection, not a private copy', () => {
    const plane = stripComments(read(A11Y_FILE))
    expect(plane, 'the plane must not re-declare it').not.toContain('const clearGridSelection =')
    expect(plane).toContain('clearGridSelection()')
    const shell = stripComments(read(SHELL_FILE))
    const args = shell.match(/useGridA11y\(\{([^}]*?)\}\)/)
    expect(args, 'the shell must call useGridA11y').not.toBeNull()
    expect(
      args![1].split(',').map(t => t.trim()).includes('clearGridSelection'),
      'the shell must hand the selection plane\'s clearer to the a11y plane',
    ).toBe(true)
    expect(stripComments(read(SELECTION_FILE)), 'and the selection plane still owns it').toContain('const clearGridSelection =')
  })

  it('the a11y plane installs no dev window seam', () => {
    expect(stripComments(read(A11Y_FILE))).not.toContain('__viz')
  })

  it('the shell mounts the plane and wires it to the live region, the outline and the deck', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('useGridA11y({')
    /** token -> required shell-site count (DEC-35). */
    const WIRED: Readonly<Record<string, number>> = {
      '<A11yLiveRegion ref={liveRef} />': 1,
      'focusedRect={focusedRect}': 1,
      'onPointerDownCapture={clearKeyboardFocusVisible}': 1,
      'effFocusedId={effFocusedId}': 1,
    }
    for (const [wire, n] of Object.entries(WIRED)) {
      expect(sites(shell, wire), `${wire} must reach ALL ${n} of its consumers from the plane`).toBe(n)
    }
  })

  it('the shell is at or below the LIVE file cap — the Split-O ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_O).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_N)
  })
})

// ── SPLIT P (ITEM-32) — THE DATA-RESOLUTION PLANE ────────────────────────────────────────────────
// The ninth and tenth of DEC-26's remaining ten, taken as ONE module, plus the four module-level
// helpers those rows were the only users of.

/** The shell's file-line ratchet AT SPLIT P. Measured with the tree final, the scratch probe
 *  directory deleted, and both gates green, immediately before the commit (DRIFT-19/23's rule).
 *  Monotone chain: 6,010 → … → 2,322 → 2,206 → 2,026. */
const SHELL_FILE_LINES_AT_SPLIT_P = 2026

/** SPLIT P's move manifest, in the same declaration-form dialect as every split before it. The last
 *  three are MODULE-level, which is why they are `const`/`interface` forms without indentation.
 *
 *  `const OWNED_DEFAULT_LAYOUT =` was the fourth, and it is DELETED rather than relocated — do not
 *  restore it. It held the literal `'primary'` as the layout id the owned pull read when the
 *  catalog declared none, which is a guess at another module's vocabulary rather than a fallback:
 *  a host source addresses layouts by artifact id, so every project without an embedding artifact
 *  had the workspace ask its source for an artifact named `primary`, take the rejection, and cover
 *  a perfectly renderable canvas in "Failed to load visualization data from the source". The pull
 *  now reads nothing when nothing is declared (`useGridData.pullOwnedData`, `ownedData.test.ts`).
 *  A move manifest names declarations that must LIVE somewhere; a declaration that must no longer
 *  exist belongs to the guard below it. */
const SPLIT_P_MOVED = [
  'const needsBuffers =',
  'const needsCatalog =',
  'const [owned, setOwned] =',
  'const [ownedError, setOwnedError] =',
  'const positions = positionsProp',
  'const colors = colorsProp',
  'const catalog = catalogProp',
  'const dataReady =',
  'const selfPending =',
  'const nPoints =',
  'const idToRowCacheRef =',
  'const idToRowFor =',
  'const pointIndexCacheRef =',
  'const pointIndexFor =',
  'const datasetEntries =',
  'const effectiveCatalog =',
  'const selectionBySpace =',
  'const anySelectionActive =',
  'const acquiredDatasetsRef =',
  'const cellData =',
  'const cellSelectionSpace =',
  'const cellDataRef =',
  'const cellSelectionSpaceRef =',
  'interface OwnedData {',
  'const EMPTY_POSITIONS =',
  'const EMPTY_COLORS =',
  "const SELECTION_CANONICAL_SPACE = 'canonical'",
] as const

/** Declarations that must exist NOWHERE in the package. A move manifest cannot express this: it
 *  asserts "declared here, absent there", and a symbol deleted for being WRONG needs the absence
 *  asserted everywhere, or the next refactor reintroduces it in a third file and both halves of the
 *  move manifest stay green. Paired with a behavioural test, named, so this never becomes the only
 *  thing standing between the defect and a user. */
const DELETED_DECLARATIONS: ReadonlyArray<readonly [decl: string, why: string]> = [
  [
    'const OWNED_DEFAULT_LAYOUT =',
    'the owned pull must not invent a layout id when the catalog declares none — behaviour held by ' +
      'grid/ownedData.test.ts ("never asks the source for positions, and lands ZERO points")',
  ],
]

describe('grid decomposition — Split P (the data-resolution plane)', () => {
  it.each(SPLIT_P_MOVED)('`%s` is declared in the data plane and not in the shell', decl => {
    expect(stripComments(read(DATA_FILE)), `${decl} must be DECLARED by ${DATA_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // Package-WIDE, not the two-file pair above: a symbol deleted for being wrong comes back in a
  // third file, not in the two the move manifest watches. Sourced from `allVizFiles()` for the same
  // reason the "exactly one definition" clauses are.
  it.each(DELETED_DECLARATIONS)('`%s` exists nowhere in the package', (decl, why) => {
    const offenders = allVizFiles().filter(f => stripComments(read(f)).includes(decl))
    expect(offenders, `${decl} was deleted on purpose: ${why}`).toEqual([])
  })

  // The dataset ACQUIRE/RELEASE pair is a ref-counted resource protocol, and the release half is an
  // unmount-only effect — the easiest thing in this whole span to drop silently, and the most
  // expensive (every referenced dataset leaks a reference for the life of the process). A manifest
  // that names `acquiredDatasetsRef` does not see a missing release, so both halves are named.
  it('the dataset ref-count protocol travelled WHOLE — acquire, prune and unmount release', () => {
    const plane = stripComments(read(DATA_FILE))
    for (const half of [
      'acquired.add(id); void ds.acquire(id)',
      'acquired.delete(id); ds.release(id)',
      'for (const id of acquiredDatasetsRef.current) ds.release(id)',
      'acquiredDatasetsRef.current.clear()',
    ]) {
      expect(plane, `${half} must live in the data plane`).toContain(half)
    }
    expect(stripComments(read(SHELL_FILE))).not.toContain('ds.acquire(')
  })

  // The two SEAM refs are re-passed, never re-declared (DEC-28, fourth application). A plane that
  // hoisted them behind a subscription would replace an identity contract two modules already depend
  // on — `GridOverlayLayer` reads `cellDataRef` on every pointer commit — with a render.
  it('the two seam refs come BACK through the destructure and reach the seam unchanged', () => {
    const shell = stripComments(read(SHELL_FILE))
    for (const ref of ['cellDataRef', 'cellSelectionSpaceRef']) {
      expect(stripComments(read(DATA_FILE)), `${ref} must be declared by the plane`).toContain(`const ${ref} = useRef`)
      const destructure = shell.match(/const \{([^}]*?)\} = useGridData\(/)
      expect(destructure, 'the shell must destructure useGridData').not.toBeNull()
      expect(
        destructure![1].split(',').map(t => t.trim()).includes(ref),
        `${ref} is a seam member owned by the data plane, so it must come back through the destructure`,
      ).toBe(true)
    }
  })

  it('the data plane installs no dev window seam', () => {
    expect(stripComments(read(DATA_FILE))).not.toContain('__viz')
  })

  // The shell must MOUNT the plane and thread every output to the consumer that reads it. Asserting
  // the destructure alone would pass while the deck received nothing.
  //
  // EXACT COUNTS, not `toContain`. Written with `toContain` first, this assertion was VACUOUS for
  // every token: each one has 2+ sites in the shell (the deck props are threaded to BOTH the dense
  // deck layer and the pane layer; `cellDataRef` reaches THREE sibling planes plus the destructure),
  // so a probe that broke ONE site left the others to satisfy the substring and the guard stayed
  // green. The pasted negative probe in DEC-35 is exactly that: `positions={positions}` ->
  // `positions={EMPTY_PROBE}` at the first site, 355 tests still passing. A count pins every site,
  // and a legitimate new consumer has to move the number on purpose — the same discipline as the
  // line ratchet above.
  it('the shell mounts the plane and threads its outputs into the other planes and the deck', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('} = useGridData({')
    /** token -> the number of shell sites that must carry it (destructure included where it is one). */
    const WIRED: Readonly<Record<string, number>> = {
      // deck props: threaded to the dense deck layer AND the pane layer.
      'positions={positions}': 2,
      'colors={colors}': 2,
      'colorEpoch={colorEpoch}': 2,
      // plane arguments: the destructure, plus each sibling plane that reads them.
      'cellData,': 3,
      'cellDataRef,': 4,
      'pointIndexFor,': 2,
      'datasetEntries,': 2,
    }
    for (const [wire, n] of Object.entries(WIRED)) {
      expect(
        sites(shell, wire),
        `${wire} must reach ALL ${n} of its consumers from the plane — a substring test would pass ` +
          'with only one site intact',
      ).toBe(n)
    }
  })

  it('the shell is at or below the LIVE file cap — the Split-P ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_P).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_O)
  })
})

// ── SPLIT Q (ITEM-33) — THE TOOL-STATE PLANE ─────────────────────────────────────────────────────
// DEC-26's "tool state" row (88). Net shell reduction 44 — the census counts the GROSS span, and a
// mount block comes back while the two borrowed refs stay. See DEC-36.

/** The shell's file-line ratchet AT SPLIT Q. Measured with the tree final, the scratch probe
 *  directory deleted and both gates green, immediately before the commit (DRIFT-19/23's rule).
 *  Monotone chain: 6,010 → … → 2,206 → 2,026 → 1,983. */
const SHELL_FILE_LINES_AT_SPLIT_Q = 1983

/** SPLIT Q's move manifest, in the same DECLARATION-form dialect as every split before it. */
const SPLIT_Q_MOVED = [
  'const [activeTool, setActiveToolRaw] =',
  'const selectMode =',
  'const activeToolRef =',
  'const setActiveTool =',
  'const [selTool, setSelTool] =',
  'const chartSelectMode: ChartSelectMode =',
  'const toggleSelectMode =',
] as const

describe('grid decomposition — Split Q (the tool-state plane)', () => {
  it.each(SPLIT_Q_MOVED)('`%s` is declared in the tool plane and not in the shell', decl => {
    expect(stripComments(read(TOOLS_FILE)), `${decl} must be DECLARED by ${TOOLS_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // `activeToolRef` is the ONE piece of surface this split removes rather than relocates: three
  // sites, all inside the plane, so it must NOT come back through the destructure. A plane that
  // returned it would have moved the declaration and kept the coupling, which is the failure mode
  // this whole decomposition is written against — and the manifest above cannot see it, because
  // "declared in the plane, absent from the shell" is true either way.
  it('`activeToolRef` stays INTERNAL to the plane — not returned, not re-read by the shell', () => {
    const plane = stripComments(read(TOOLS_FILE))
    expect(plane).toContain('const activeToolRef = useRef(activeTool)')
    // the return block must not list it
    const ret = returnBlock(plane, TOOLS_FILE)
    expect(
      ret.split(/[,\s}]+/).includes('activeToolRef'),
      '`activeToolRef` must not be returned — it has no consumer outside the plane',
    ).toBe(false)
    expect(stripComments(read(SHELL_FILE))).not.toContain('activeToolRef')
  })

  // The mirror image: `overlayApiRef` / `activeCellRef` are BORROWED. Four other modules share them
  // (`useGridSelection` reads the overlay handle at four sites; `useGridWindows` / `useGridAnnotate` /
  // `useGridLinking` write the active cell), so a plane that DECLARED either would fork a ref the
  // decomposition already threads. Asserted in both directions, because "the plane uses it" is
  // satisfied by a plane that declared its own.
  it('the two shared refs are passed IN, never declared by the plane', () => {
    const plane = stripComments(read(TOOLS_FILE))
    const shell = stripComments(read(SHELL_FILE))
    for (const ref of ['overlayApiRef', 'activeCellRef']) {
      expect(plane, `${ref} must NOT be declared by the plane`).not.toContain(`const ${ref} = useRef`)
      expect(shell, `${ref} must still be declared by the shell`).toContain(`const ${ref} = useRef`)
    }
    expect(shell).toContain('useGridTools({ overlayApiRef, activeCellRef })')
  })

  // `setActiveToolRaw` must NOT be returned: every caller has to go through `setActiveTool` or the
  // leaving-Select side effect (clear the drafts, drop the active cell) is silently skipped. This is
  // a behaviour clause, not a structure clause — the manifest cannot express it.
  it('the raw setter is not exported past the wrapper', () => {
    const plane = stripComments(read(TOOLS_FILE))
    const ret = returnBlock(plane, TOOLS_FILE)
    expect(ret.split(/[,\s}]+/).includes('setActiveToolRaw')).toBe(false)
    expect(plane, 'the leaving-Select side effect must live in the wrapper').toContain(
      'overlayApiRef.current?.clearDrafts()',
    )
  })

  it('the tool plane installs no dev window seam', () => {
    expect(stripComments(read(TOOLS_FILE))).not.toContain('__viz')
  })

  // EXACT COUNTS per DEC-35 — a `toContain` here would be satisfied by one surviving site.
  it('the shell mounts the plane and wires every output to its consumer', () => {
    const shell = read(SHELL_FILE)
    const WIRED: Readonly<Record<string, number>> = {
      'activeTool={activeTool}': 1,
      'onToolChange={setActiveTool}': 1,
      'selTool={selTool}': 1,
      'setSelTool(t)': 1,
      'chartSelectMode={chartSelectMode}': 1,
      // `selectMode` reaches `drawActive` and the rail's `selectExpanded`; `toggleSelectMode` the rail.
      'selectMode && glOk': 1,
      'selectExpanded={selectMode &&': 1,
      'toggleSelectMode': 2,
    }
    for (const [wire, n] of Object.entries(WIRED)) {
      expect(sites(shell, wire), `${wire} must reach ALL ${n} of its consumers`).toBe(n)
    }
  })

  it('the shell is at or below the LIVE file cap — the Split-Q ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_Q).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_P)
  })
})

// ── SPLIT R (ITEM-34) — THE DEV-INSTRUMENTATION PLANE ────────────────────────────────────────────
// DEC-26's "DEV instrumentation seams" row (57); net shell reduction 28 (DEC-36). This is the split
// HAZARD 1 warned about specifically — the row IS the `window.__viz*` seams — so the guard checks the
// seam set in BOTH directions: every one installed here, and NONE left installed by the shell.

/** The shell's file-line ratchet AT SPLIT R. Measured with the tree final, the scratch probe
 *  directory deleted and both gates green, immediately before the commit (DRIFT-19/23's rule).
 *  Monotone chain: 6,010 → … → 2,026 → 1,983 → 1,956. */
const SHELL_FILE_LINES_AT_SPLIT_R = 1956

/** The six seams this plane owns. Named individually: a set-sized assertion would pass while one
 *  seam silently went missing, and each is the sole entry point of an e2e spec. */
const DEV_SEAM_NAMES = [
  '__vizSharedMasks',
  '__vizShareMaskAcrossGroup',
  '__vizDetachSharedMask',
  '__vizApplyDisplayToGroup',
  '__vizSeedCellDisplay',
  '__vizLinkCells',
] as const

/** SPLIT R's move manifest, in the same DECLARATION-form dialect as every split before it. */
const SPLIT_R_MOVED = ['const isPrimaryWorkspace = containerId === PRIMARY_CONTAINER'] as const

describe('grid decomposition — Split R (the dev-instrumentation plane)', () => {
  it.each(SPLIT_R_MOVED)('`%s` is declared in the dev plane and not in the shell', decl => {
    expect(stripComments(read(DEV_SEAMS_FILE)), `${decl} must be DECLARED by ${DEV_SEAMS_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // BOTH halves per seam. The install half alone passes on a plane that never tears down — which is
  // the actual bug this code exists to avoid (a torn-down workspace leaving live mutators on
  // `window`, so the NEXT test in the file drives a dead grid). The ref-count-protocol clause of
  // TEST-50 is the same shape and the same reason.
  it.each(DEV_SEAM_NAMES)('`%s` is installed AND torn down by the dev plane', name => {
    const plane = stripComments(read(DEV_SEAMS_FILE))
    expect(plane, `${name} must be installed`).toContain(`w.${name} =`)
    expect(plane, `${name} must be dropped on unmount`).toContain(`w.${name} = undefined`)
  })

  // The half the manifest cannot see, and the reason HAZARD 1 names this split: a `window` alias is
  // not a lexical binding, so `tsc` is blind to it. If the shell kept installing even ONE seam, the
  // two modules would race on the same global and the survivor would depend on effect order.
  it('the SHELL installs no window seam at all any more', () => {
    expect(
      stripComments(read(SHELL_FILE)),
      'a `window.__viz*` write left in the shell would race this plane on the same global',
    ).not.toContain('__viz')
  })

  // …but the ANNOTATE plane's two seams must NOT have been absorbed. A seam belongs with the state it
  // publishes (Split J's rule), so a "collect every seam in one dev module" refactor is the wrong
  // shape even though it would look tidier — and it would pass every assertion above.
  it("the annotate plane keeps its OWN two seams — they were not hoovered up", () => {
    const annotate = stripComments(read('useGridAnnotate.ts'))
    const dev = stripComments(read(DEV_SEAMS_FILE))
    for (const own of ['__vizAnnotateStores', '__vizProcessorPorts']) {
      expect(annotate, `${own} belongs with the maps it aliases`).toContain(own)
      expect(dev, `${own} must NOT have moved into the dev plane`).not.toContain(own)
    }
  })

  // The primary-instance gate. `GridWorkspace` renders recursively (DRIFT-5), so a popped-out
  // container mounts a SECOND workspace in the same realm; without the gate it clobbers the primary's
  // handles and every seam-driven e2e reads the child's state.
  it('the plane keeps the primary-instance gate', () => {
    expect(stripComments(read(DEV_SEAMS_FILE))).toContain(
      "if (typeof window === 'undefined' || !isPrimaryWorkspace) return",
    )
  })

  // Returns `void` — the `useGridColoring` shape. A plane that started returning values would be
  // re-brokering instrumentation through the shell for no reader.
  it('the dev plane returns nothing', () => {
    expect(read(DEV_SEAMS_FILE)).toMatch(/export function useGridDevSeams\([\s\S]*?\): void \{/)
  })

  // EXACT COUNTS per DEC-35.
  it('the shell mounts the plane and passes every input', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('useGridDevSeams({')
    // Each input appears once in the mount's argument block; `maskEpoch` / the three mask callbacks /
    // `sharedMaskSessionsRef` also appear once in the MASK plane's destructure, hence 2.
    const WIRED: Readonly<Record<string, number>> = {
      'sharedMaskSessionsRef,': 2,
      'shareMaskAcrossGroup,': 2,
      'detachSharedMask,': 2,
      'applyDisplayToGroup,': 2,
      'containerId,': 2,
      // `maskEpoch` also reaches the deck layer, hence three.
      'maskEpoch,': 3,
    }
    for (const [wire, n] of Object.entries(WIRED)) {
      expect(sites(shell, wire), `${wire} must appear at exactly ${n} sites`).toBe(n)
    }
  })

  it('the shell is at or below the LIVE file cap — the Split-R ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_R).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_Q)
  })
})

// ── SPLIT S (ITEM-35) — THE HOVER / TOOLTIP-FIELD PLANE ──────────────────────────────────────────
// DEC-26's "hover sink / tooltip fields" row (43) plus the cross-plot highlight state the sink writes;
// net shell reduction 46 (DEC-36 — above the row's own figure, because the state came too).

/** The shell's file-line ratchet AT SPLIT S. Measured with the tree final, the scratch probe
 *  directory deleted and both gates green, immediately before the commit (DRIFT-19/23's rule).
 *  Monotone chain: 6,010 → … → 1,983 → 1,956 → 1,906. */
const SHELL_FILE_LINES_AT_SPLIT_S = 1906

/** SPLIT S's move manifest, in the same DECLARATION-form dialect as every split before it. The last
 *  is MODULE-level, which is why it is a bare `function` form without indentation. */
const SPLIT_S_MOVED = [
  'const [crossHighlight, setCrossHighlight] =',
  'const effectiveHighlight =',
  'const [chartHover, setChartHover] =',
  'const publishChartHover =',
  'const deckHoverRef =',
  'const deckHoverSink =',
  'const [hoveredCellId, setHoveredCellId] =',
  'const onHoverPublish =',
  'const tooltipFields =',
  'function sameHighlight(',
] as const

describe('grid decomposition — Split S (the hover / tooltip-field plane)', () => {
  it.each(SPLIT_S_MOVED)('`%s` is declared in the hover plane and not in the shell', decl => {
    expect(stripComments(read(HOVER_FILE)), `${decl} must be DECLARED by ${HOVER_FILE}`).toContain(decl)
    expect(stripComments(read(SHELL_FILE)), `${decl} must be gone from ${SHELL_FILE}`).not.toContain(decl)
  })

  // THE CLAUSE THIS SPLIT EXISTS TO PROTECT. `hovered`, its rAF throttle and `onDeckHover` belong to
  // `GridOverlayLayer` (SPLIT B) and must STAY there: they are per-frame, and a "tidy up hover into one
  // plane" refactor that pulled them up here would re-render everything above the overlay on every
  // cursor pixel — precisely the cost TEST-P1/P5 measure, and it would pass every manifest clause
  // above. Asserted in both directions so neither half can drift.
  it('the PER-FRAME hover half stays in the overlay layer — this plane must not reunite it', () => {
    const plane = stripComments(read(HOVER_FILE))
    for (const perFrame of ['requestAnimationFrame', 'const hovered', 'onDeckHover =']) {
      expect(plane, `${perFrame} is per-frame and belongs to GridOverlayLayer (Split B)`).not.toContain(perFrame)
    }
    expect(
      stripComments(read('GridOverlayLayer.tsx')),
      'the overlay layer still owns the rAF-throttled hover',
    ).toContain('requestAnimationFrame')
  })

  // `sameHighlight` was MOVED, not copied. Two copies would be two equality semantics, and the one
  // that matters is the identity contract `hoverHighlightLayers` and the deck layer's `crossTooltips`
  // memo depend on — a duplicated helper that later drifted would desynchronise them silently. The
  // manifest's absence-half already covers the shell; this pins that there is exactly ONE definition
  // in the whole package.
  it('`sameHighlight` has exactly one definition in the package', () => {
    const defs = allGridFiles().filter(f => stripComments(read(f)).includes('function sameHighlight('))
    expect(defs, 'exactly one module may define the highlight equality').toEqual([HOVER_FILE])
  })

  // The three setters stay INTERNAL. Each has exactly one writer inside the plane, so returning any of
  // them would hand another module a way to write hover state behind the equality guard — which is the
  // guard the whole per-frame saving rests on.
  it('the three hover setters are not returned', () => {
    const plane = stripComments(read(HOVER_FILE))
    const ret = returnBlock(plane, HOVER_FILE)
    for (const setter of ['setCrossHighlight', 'setHoveredCellId', 'setChartHover']) {
      expect(ret.split(/[,\s}]+/).includes(setter), `${setter} must stay internal to the plane`).toBe(false)
    }
    // …and the equality guard is really on the setter, not merely present in the file.
    expect(plane).toContain('setCrossHighlight(prev => (sameHighlight(prev, highlight) ? prev : highlight))')
  })

  // `deckHoverRef` is a cross-LAYER ref: the OVERLAY fills it, the DECK calls it through the sink. It
  // must be declared by the plane and re-passed unchanged (DEC-28, fifth application) — a plane that
  // hoisted it behind a subscription would break an identity two sibling layers share. Asserted via
  // destructure membership, not substring (DRIFT-53's lazy-anchor vacuity).
  it('the deck hover ref is declared by the plane and re-passed to BOTH sibling layers', () => {
    const plane = stripComments(read(HOVER_FILE))
    expect(plane).toContain('const deckHoverRef = useRef<((info: DeckHoverInfo) => void) | null>(null)')
    const shell = stripComments(read(SHELL_FILE))
    const destructure = shell.match(/const \{([^}]*?)\} = useGridHover\(/)
    expect(destructure, 'the shell must destructure useGridHover').not.toBeNull()
    expect(destructure![1].split(',').map(t => t.trim()).includes('deckHoverRef')).toBe(true)
    // the overlay FILLS it; the deck CALLS it via the sink. Both, or the channel is one-ended.
    expect(shell).toContain('deckHoverRef={deckHoverRef}')
    expect(shell).toContain('onDeckHover={deckHoverSink}')
  })

  // INV-10 (d)'s recurring consequence, a FOURTH time (DRIFT-58). `DeckHoverInfo` was declared in
  // `GridOverlayLayer.tsx`, which IS a layer, and this hook types its sink with it — so the TYPE had to
  // move to the neutral `gridModel.ts`. Asserted at all three sites: declared neutrally, re-exported by
  // the layer so existing importers are unaffected, and NOT re-declared there.
  it('`DeckHoverInfo` moved to the neutral model and the layer re-exports it', () => {
    expect(stripComments(read('gridModel.ts'))).toContain('export interface DeckHoverInfo {')
    const layer = stripComments(read('GridOverlayLayer.tsx'))
    expect(layer, 'the layer must re-export, not re-declare').toContain("export type { DeckHoverInfo } from './gridModel'")
    expect(layer).not.toContain('export interface DeckHoverInfo {')
    expect(stripComments(read(HOVER_FILE)), 'the hook reads the type from the neutral model').toContain(
      "from './gridModel'",
    )
  })

  it('the hover plane installs no dev window seam', () => {
    expect(stripComments(read(HOVER_FILE))).not.toContain('__viz')
  })

  // EXACT COUNTS per DEC-35.
  it('the shell mounts the plane and wires every output to its consumers', () => {
    const shell = read(SHELL_FILE)
    expect(shell).toContain('} = useGridHover({ tooltipContext, tooltipLabels })')
    const WIRED: Readonly<Record<string, number>> = {
      'onDeckHover={deckHoverSink}': 1,
      'tooltipFields={tooltipFields}': 2,
      'effectiveHighlight={effectiveHighlight}': 2,
      'hoveredCellId={hoveredCellId}': 1,
      'publishChartHover={publishChartHover}': 2,
      'chartHover={chartHover}': 1,
      'onHoverPublish={onHoverPublish}': 1,
      'deckHoverRef={deckHoverRef}': 1,
    }
    for (const [wire, n] of Object.entries(WIRED)) {
      expect(sites(shell, wire), `${wire} must reach ALL ${n} of its consumers`).toBe(n)
    }
  })

  it('the shell is at or below the LIVE file cap — the Split-S ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_S).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_R)
  })
})

// ── SPLIT T (ITEM-36) — THE MODULE HELPERS ───────────────────────────────────────────────────────
// DEC-26's "module helpers" row named four symbols. TWO had already left (`OwnedData` with Split P,
// `withColorOverrides` with Split F) and a third (`sameHighlight`) left with Split S. What remained was
// `webglAvailable` plus `EMPTY_CONTAINER_LAYOUT`, and the `installBuiltins()` / `installCoordSystems()`
// module-load calls — which deliberately do NOT move (DEC-37). Every symbol here is MODULE-level, so
// this split moves the FILE ratchet and cannot move the body cap at all; see DEC-37's arithmetic.

/** The shell's file-line ratchet AT SPLIT T. Measured with the tree final, the scratch probe
 *  directory deleted and both gates green, immediately before the commit (DRIFT-19/23's rule).
 *  Monotone chain: 6,010 → … → 1,956 → 1,906 → 1,899. */
const SHELL_FILE_LINES_AT_SPLIT_T = 1899

describe('grid decomposition — Split T (the module helpers)', () => {
  // MOVED, not copied — asserted package-wide, because this symbol left the grid directory entirely
  // and a grid-only sweep would not see a copy left behind in `core/`.
  it('`webglAvailable` has exactly one definition in the package, in the context-lifecycle module', () => {
    const defs = allVizFiles().filter(f => stripComments(read(f)).includes('function webglAvailable('))
    expect(defs, 'exactly one module may define the WebGL capability probe').toEqual(['../../viz-core/core/contextLoss.ts'])
    expect(stripComments(read(SHELL_FILE))).not.toContain('function webglAvailable(')
    // It lives beside its one dependency — that adjacency IS the reason for the chosen home, so it is
    // asserted rather than left to the docblock.
    expect(stripComments(read('../core/contextLoss.ts')), 'the probe must sit with the release').toContain(
      'export function freeCanvasContext(',
    )
  })

  // `freeCanvasContext` was the shell's import ONLY for `webglAvailable`, so the move made it dead
  // (DRIFT-47's class). A stale import is not a type error, so `tsc` never complains.
  it('the import the move made dead is gone from the shell', () => {
    expect(stripComments(read(SHELL_FILE))).not.toContain('freeCanvasContext')
    expect(stripComments(read(SHELL_FILE)), 'and the probe is imported instead').toContain(
      "import { useCanvasRecovery, webglAvailable } from '../core/contextLoss'",
    )
  })

  // DELETED as a duplicate rather than relocated. The store already declared a byte-identical const.
  it('the duplicate empty-layout const is gone and the store owns the single definition', () => {
    expect(stripComments(read(SHELL_FILE))).not.toContain('const EMPTY_CONTAINER_LAYOUT')
    const store = stripComments(read('../../adapter/GridWorkspace.store.ts'))
    expect(store).toContain('export const EMPTY_GRID_LAYOUT: LayoutNode = { kind: \'leaf\', id: EMPTY_GRID_ID }')
    // …and the selector that needed the stable reference really uses it. Without this the deletion is
    // satisfiable by dropping the fallback entirely, which would hand `useStore` an `undefined` layout.
    expect(stripComments(read(SHELL_FILE))).toContain('s.containerLayouts[containerId] ?? EMPTY_GRID_LAYOUT')
  })

  // THE DELIBERATE NON-MOVE (DEC-37), asserted as a POSITIVE control. Both registry installs are
  // module-LOAD side effects that must run before any cell renders: `CellView.ChartBody` resolves every
  // cell against the chart registry and `cellRendersOnSharedDeck` resolves kind → descriptor → coord
  // system. "The module helpers moved" is otherwise satisfiable by DELETING these two calls, and the
  // failure would be silent at the type level and total at runtime — every cell failing to resolve.
  it('the two module-load registry installs are still CALLED by the shell at load', () => {
    const shell = stripComments(read(SHELL_FILE))
    expect(shell, 'the chart registry must be populated at module load').toContain('installBuiltins()')
    expect(shell, 'the coord-system registry must be populated at module load').toContain('installCoordSystems()')
    // At module scope, not inside the component — a call moved into the body would run per mount and
    // after the first render rather than before it.
    for (const call of ['installBuiltins()', 'installCoordSystems()']) {
      expect(shell.includes(`\n${call}`), `${call} must be at module scope, unindented`).toBe(true)
    }
  })

  it('the shell is at or below the LIVE file cap — the Split-T ratchet is a recorded measurement, not a cap', () => {
    expectShellWithinFileCap()
  })

  it('the line ratchet only ever moved DOWN', () => {
    expect(SHELL_FILE_LINES_AT_SPLIT_T).toBeLessThan(SHELL_FILE_LINES_AT_SPLIT_S)
  })
})
