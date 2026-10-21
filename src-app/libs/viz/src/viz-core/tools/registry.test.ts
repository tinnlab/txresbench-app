// registry.test.ts — TEST-1/2/4/6/7 + TEST-A14 (acceptance, INV-14).
//
// These are the tests that make the shipped defect class un-reintroducible. Every assertion below
// corresponds to a real bug the owner found by driving the running app:
//   #4 ✥ bound to move-selection while the pan tool wore a magnifier  → `pan` vs `moveSelection` icons
//   #5 `move` typed as a selection SHAPE                              → kind === 'action'
//   #7 same polygon gesture drawn as `Lasso` here and `PenTool` there → same-gesture-same-icon
// and the six-vocabulary sprawl that allowed all of them.

import { describe, expect, it } from 'vitest'
import {
  GripVertical, MoreHorizontal, SplitSquareHorizontal, Trash2, X,
  PanelTop, Link2, Package, Check, CircleDot, Eraser, Layers, Copy, MessageSquare,
  Undo2, Redo2, Plus, Sprout, Ban,
  // Admitted when the two icon audits below became DIRECTORY-DERIVED (FIX_ROUND-1 / C4) and first
  // saw `grid/CellView.tsx` + `grid/PlotDataTable.tsx`: pane pop-out / restore, and the data
  // table's sort + close chrome. None is a registered gesture glyph.
  ExternalLink, CornerUpLeft, ChevronUp, ChevronDown, ChevronsUpDown,
  // Admitted when the audits became VIZ-CORE-WIDE (FIX_ROUND-2) and first saw
  // `controls/PaneEditForm.tsx` — the per-series show/hide toggle in the edit form. Not registered:
  // hiding a legend entry is a form control, not a tool the user picks up.
  Eye, EyeOff,
} from 'lucide-react'

/** Every lucide glyph an icon-bearing surface is allowed to import DIRECTLY (non-tool chrome).
 *  The audit below fails on any direct import missing from here — so adding one is a deliberate
 *  act that also puts the glyph under the "does it collide with a registered tool?" check. */
const LUCIDE_DIRECT = {
  GripVertical, MoreHorizontal, SplitSquareHorizontal, Trash2, X,
  PanelTop, Link2, Package, Check, CircleDot, Eraser, Layers, Copy, MessageSquare,
  Undo2, Redo2, Plus, Sprout, Ban,
  ExternalLink, CornerUpLeft, ChevronUp, ChevronDown, ChevronsUpDown,
  Eye, EyeOff,
}
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GESTURE_ICON,
  TOOL_VOCABULARY,
  allTools,
  iconForGesture,
  labelFor,
  toolById,
  toolFor,
  toolKeysForSurface,
  toolsForSurface,
  type Gesture,
} from './registry'
import type { ToolId } from './vocabulary'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VIZ_CORE = path.resolve(HERE, '..')

/** EVERY module in `viz-core/grid/`, as a `grid/<file>` path — DERIVED FROM THE DIRECTORY, never
 *  hand-listed (FIX_ROUND-1 / C4).
 *
 *  The three source scans below used to name their grid files literally. When the 6,000-line shell
 *  was decomposed the lists were extended by FOUR — the layer components — while the split added 23
 *  modules to that directory, and the one provably-live omission was `useGridTools.ts`: the very file
 *  the `selTool` guard at the bottom of this suite had just been re-pointed at, present there and in
 *  NEITHER scan list. A guard whose file list is not extended when the code it guards moves does not
 *  fail; it silently stops guarding — which is exactly what the comment on the four-file extension
 *  said, one paragraph above the four files.
 *
 *  Directory-derivation is the form that cannot decay: a module added to `grid/` tomorrow is scanned
 *  the day it lands, with no list to remember. `gridDecomposition.test.ts` owns the meta-guard that
 *  this stays derived. */
const gridModules = (): string[] =>
  fs
    .readdirSync(path.join(VIZ_CORE, 'grid'))
    .filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .sort()
    .map(f => `grid/${f}`)

/** EVERY module under `viz-core/`, recursively — what the three scans below actually iterate
 *  (FIX_ROUND-2).
 *
 *  `gridModules()` closed the hand-list for ONE directory. The scans still named four files outside
 *  it by hand, and a hand-list of SURFACES is the same defect generator as a hand-list of grid files;
 *  it just hides one directory over. Measured when this was written: the hand-list named
 *  `annotate/MaskReviewControls.tsx` and `annotate/HierarchyTreePanel.tsx`, NEITHER of which imports
 *  lucide any more, and MISSED `controls/PaneEditForm.tsx` and `export/ExportDialog.tsx`, which BOTH
 *  do — it was auditing two files that could not fail while skipping two that could. That is also
 *  the shape of FIX_ROUND-1's second new finding (`PlotDataTable.tsx` importing the REGISTERED
 *  `exportPane` glyph directly, invisible because the list did not name it).
 *
 *  `tools/` is excluded: the registry is the thing being enforced, not a surface subject to it.
 *  Everything else under `viz-core` is a surface. A file with no lucide import contributes nothing
 *  (the scans `continue`), so over-inclusion costs a `readFileSync` and can never be a false red. */
const vizCoreModules = (): string[] => {
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(r)
    }
  }
  walk(VIZ_CORE, '')
  return out.filter(f => !f.startsWith('tools/')).sort()
}

// ── The CURATED gesture pinning (INV-14, second half) ───────────────────────────────────────────
//
// `Record<Gesture, Icon>` proves "two DIFFERENT gestures never share a glyph". It cannot prove the
// converse — that two different user-facing ACTIONS are different GESTURES — and that is exactly
// where findings #12/#13 lived: `view.select` and `annotate.select` both carried `pick`,
// `annotate.brush` and `mask.brush` both carried `brush`, so the injectivity test passed green while
// the user saw ONE glyph standing for TWO verbs. The guard had been built one level above the error.
//
// So every `(surface, key)` pair is pinned to its expected gesture HERE. Adding an entry fails
// (missing key), silently retargeting one fails (wrong value), and `SHARED_GESTURES` below forces a
// WRITTEN justification for any gesture carried by more than one entry.
const EXPECTED_GESTURE: Record<ToolId, Gesture> = {
  'view.pan': 'pan',
  'view.select': 'pickData',
  'select.rect': 'rect',
  'select.polygon': 'polygon',
  'select.move': 'moveSelection',
  'annotate.select': 'pickAnnotation',
  'annotate.point': 'point',
  'annotate.polygon': 'polygon',
  'annotate.brush': 'brushRegion',
  'mask.relabel': 'relabel',
  'mask.split': 'split',
  'mask.merge': 'merge',
  'mask.brush': 'brushMask',
  // Per-pane toolbar actions. `annotateMode`/`segmentMode` moved here from the deleted
  // `view.annotate`/`view.segment` rail modes (finding #14) — the surfaces are per-pane, so their
  // entry point is the pane's toolbar, a sibling of Edit.
  'pane.link': 'linkFilter',
  'pane.edit': 'editPlot',
  'pane.annotate': 'annotateMode',
  'pane.segment': 'segmentMode',
  'pane.export': 'exportPane',
  'pane.data': 'dataTable',
  // The PINNED left-group pickers — registered because their COLLAPSED form is icon-only.
  'pane.kind': 'plotKind',
  'pane.colorby': 'colorBy',
}

/**
 * The ONLY gestures allowed to be carried by more than one entry, each with the justification for
 * why those entries are genuinely the SAME verb on the same class of target — i.e. why ONE glyph is
 * correct rather than a collapse of two actions. A gesture used twice and absent here FAILS.
 */
const SHARED_GESTURES: Partial<Record<Gesture, readonly ToolId[]>> = {
  // Identical verb, identical target class: click vertices until the ring closes, producing a
  // polygon. What that polygon subsequently MEANS (a data selection vs an annotation) is the
  // surface's business, not the gesture's — the user's hand does exactly the same thing.
  polygon: ['select.polygon', 'annotate.polygon'],
}

describe('TEST-1 — the registry is the exact, complete tool vocabulary', () => {
  it('exposes exactly the namespaced id set, with no duplicates', () => {
    // Exact-contents assertion (not a superset check): adding or renaming a tool must be a
    // deliberate edit here, which is what stops a seventh vocabulary quietly appearing.
    expect(TOOL_VOCABULARY.map(e => e.id)).toEqual([
      // NOTE the absent `view.annotate` / `view.segment`: annotate + segment are PER-PANE surfaces
      // (finding #14), entered from `pane.annotate` / `pane.segment` below, never from the global rail.
      'view.pan', 'view.select',
      'select.rect', 'select.polygon', 'select.move',
      'annotate.select', 'annotate.point', 'annotate.polygon', 'annotate.brush',
      'mask.relabel', 'mask.split', 'mask.merge', 'mask.brush',
      'pane.link', 'pane.edit', 'pane.annotate', 'pane.segment', 'pane.export', 'pane.data',
      'pane.kind', 'pane.colorby',
    ])
    expect(new Set(TOOL_VOCABULARY.map(e => e.id)).size).toBe(TOOL_VOCABULARY.length)
  })

  it('resolves every entry through toolById / toolFor / labelFor', () => {
    for (const entry of TOOL_VOCABULARY) {
      expect(toolById(entry.id).id).toBe(entry.id)
      expect(toolFor(entry.surface, entry.key).id).toBe(entry.id)
      expect(labelFor(entry.surface, entry.key)).toBe(entry.label)
    }
  })

  it('throws on an unknown id rather than silently returning undefined', () => {
    // A typo must fail loudly at the call site; a silent undefined is how an icon goes missing.
    expect(() => toolById('annotate.reshape' as never)).toThrow(/unknown tool id/)
    expect(() => toolFor('annotate', 'reshape')).toThrow(/unknown tool/)
  })

  it('partitions cleanly by surface', () => {
    expect(toolKeysForSurface('view')).toEqual(['pan', 'select'])
    expect(toolKeysForSurface('select')).toEqual(['rect', 'polygon', 'move'])
    expect(toolKeysForSurface('annotate')).toEqual(['select', 'point', 'polygon', 'brush'])
    expect(toolKeysForSurface('mask')).toEqual(['relabel', 'split', 'merge', 'brush'])
    // The pane surface's order IS the toolbar's LEFT-to-RIGHT order: the two PINNED config pickers
    // first (negative `order` — they render beside the drag grip and never fold), then the fixed
    // right-group action order.
    expect(toolKeysForSurface('pane')).toEqual(
      ['kind', 'colorby', 'link', 'edit', 'annotate', 'segment', 'export', 'data'])
  })
})

describe('TEST-2 — `order` is the single ordering source', () => {
  it('orders annotate tools select → point (0-D) → polygon (2-D) → brush (raster)', () => {
    // The owner asked for "Drop point should be on top of draw polygon"; the generalised rule is
    // ascending primitive complexity. Living on the registry is what stops it drifting per surface.
    expect(toolsForSurface('annotate').map(t => t.key)).toEqual(['select', 'point', 'polygon', 'brush'])
  })

  it('puts operations on existing geometry last within their surface', () => {
    const select = toolsForSurface('select')
    expect(select.map(t => t.key)).toEqual(['rect', 'polygon', 'move'])
    expect(select[select.length - 1]!.kind).toBe('action')
  })

  it('returns strictly ascending order values per surface', () => {
    for (const surface of ['view', 'select', 'annotate', 'mask', 'pane'] as const) {
      const orders = toolsForSurface(surface).map(t => t.order)
      expect(orders).toEqual([...orders].sort((a, b) => a - b))
      expect(new Set(orders).size).toBe(orders.length)
    }
  })
})

describe('TEST-4 — icon semantics: pan is not move-selection (finding #4/#5)', () => {
  it('gives view.pan and select.move DIFFERENT icons', () => {
    // The shipped bug: ✥ (`Move`) was on "Move selection" while "Pan + zoom" wore `ZoomIn`, so a
    // user reaching for the universal pan glyph dragged their selection instead.
    expect(toolById('view.pan').Icon).not.toBe(toolById('select.move').Icon)
  })

  it('binds ✥ to panning the VIEW, per every mainstream imaging tool', () => {
    expect(toolById('view.pan').Icon).toBe(iconForGesture('pan'))
    expect(toolById('view.pan').gesture).toBe('pan')
    expect(toolById('select.move').gesture).toBe('moveSelection')
  })

  it('types `move` as a selection ACTION, absent from the shape vocabulary', () => {
    // `SelShape = 'rect' | 'polygon' | 'move'` typed an operation as a shape. rect/polygon describe
    // HOW a region is drawn; move acts on a region that already exists.
    expect(toolById('select.move').kind).toBe('action')
    const shapes = TOOL_VOCABULARY.filter(e => e.surface === 'select' && e.kind === 'shape')
    expect(shapes.map(e => e.key)).toEqual(['rect', 'polygon'])
    expect(shapes.map(e => e.key)).not.toContain('move')
  })
})

describe('TEST-A14 — INV-14: one vocabulary, and same gesture ⇒ same icon', () => {
  it('gives every entry sharing a gesture an IDENTICAL icon reference', () => {
    // Structural (the icon map is keyed by gesture) — asserted anyway so the property is pinned
    // even if the map is ever re-keyed.
    const byGesture = new Map<Gesture, Set<unknown>>()
    for (const t of allTools()) {
      if (!byGesture.has(t.gesture)) byGesture.set(t.gesture, new Set())
      byGesture.get(t.gesture)!.add(t.Icon)
    }
    for (const [gesture, icons] of byGesture) {
      expect(icons.size, `gesture "${gesture}" resolves to ${icons.size} different icons`).toBe(1)
    }
    // The one pair that IS genuinely the same verb on the same target class (see SHARED_GESTURES).
    expect(toolById('select.polygon').Icon).toBe(toolById('annotate.polygon').Icon)
  })

  it('never lets two DIFFERENT gestures share an icon (injective)', () => {
    const seen = new Map<unknown, Gesture>()
    for (const [gesture, Icon] of Object.entries(GESTURE_ICON) as [Gesture, unknown][]) {
      const prior = seen.get(Icon)
      expect(prior, `gestures "${prior}" and "${gesture}" share one glyph`).toBeUndefined()
      seen.set(Icon, gesture)
    }
    expect(seen.size).toBe(Object.keys(GESTURE_ICON).length)
  })

  it('covers every gesture the vocabulary uses', () => {
    for (const entry of TOOL_VOCABULARY) expect(GESTURE_ICON[entry.gesture]).toBeTruthy()
  })
})

describe('TEST-A14b — INV-14 second half: distinct ACTIONS are distinct GESTURES (findings #12/#13)', () => {
  it('pins every (surface, key) to its expected gesture', () => {
    // Exact-map equality, not a subset: ADDING a tool fails here until its gesture is stated, which
    // is the moment the author has to ask "is this really the same verb as an existing one?".
    const actual = Object.fromEntries(TOOL_VOCABULARY.map(e => [e.id, e.gesture]))
    expect(actual).toEqual(EXPECTED_GESTURE)
  })

  it('forces a written justification for any gesture used by MORE THAN ONE entry', () => {
    // This is the assertion that fails on the shipped taxonomy: `pick` was on view.select AND
    // annotate.select, `brush` on annotate.brush AND mask.brush, neither declared shared.
    const byGesture = new Map<Gesture, ToolId[]>()
    for (const e of TOOL_VOCABULARY) {
      const list = byGesture.get(e.gesture) ?? []
      list.push(e.id)
      byGesture.set(e.gesture, list)
    }
    const undeclared: string[] = []
    for (const [gesture, ids] of byGesture) {
      if (ids.length < 2) continue
      const declared = SHARED_GESTURES[gesture]
      if (!declared) {
        undeclared.push(
          `gesture "${gesture}" is carried by ${ids.length} entries (${ids.join(', ')}) but is not ` +
            `declared in SHARED_GESTURES — if these really are the same verb on the same kind of ` +
            `target, say so there; otherwise SPLIT the gesture and give each a distinct glyph`,
        )
        continue
      }
      expect([...declared].sort(), `SHARED_GESTURES["${gesture}"] is stale`).toEqual([...ids].sort())
    }
    expect(undeclared).toEqual([])
  })

  it('does not declare a gesture shared that only one entry uses', () => {
    // Keeps the justification table honest after a split: a leftover entry here would silently
    // re-permit a future collapse onto that gesture.
    for (const gesture of Object.keys(SHARED_GESTURES) as Gesture[]) {
      const users = TOOL_VOCABULARY.filter(e => e.gesture === gesture)
      expect(users.length, `SHARED_GESTURES["${gesture}"] is declared but used by ${users.length} entry`).toBeGreaterThan(1)
    }
  })

  it('keeps the four split gestures — and their glyphs — genuinely distinct (finding #13)', () => {
    // Selecting DATA (marquee over points) vs selecting an ANNOTATION OBJECT.
    expect(toolById('view.select').gesture).toBe('pickData')
    expect(toolById('annotate.select').gesture).toBe('pickAnnotation')
    expect(toolById('view.select').Icon).not.toBe(toolById('annotate.select').Icon)
    // Painting a VECTOR region vs painting RASTER mask pixels. With per-pane docks (INV-12) both
    // panels are open at once, so "the surface supplies context" is not available to the user's eye.
    expect(toolById('annotate.brush').gesture).toBe('brushRegion')
    expect(toolById('mask.brush').gesture).toBe('brushMask')
    expect(toolById('annotate.brush').Icon).not.toBe(toolById('mask.brush').Icon)
  })

  it('gives `point` a centre-anchored crosshair, not a geographic pin (finding #12)', () => {
    // The tool marks CELLS/NUCLEI and its job is COUNTING them. A teardrop map pin is a geographic
    // metaphor and is bottom-anchored, so its visual anchor is ambiguous exactly where precision
    // matters, and it reads as heavy chrome at 16px in a dense nuclei field.
    const Icon = iconForGesture('point') as unknown as { displayName?: string }
    expect(Icon.displayName).toBe('Crosshair')
    expect(toolById('annotate.point').Icon).toBe(iconForGesture('point'))
  })
})

describe('TEST-6 / TEST-7 — no surface re-declares a vocabulary; namespacing disambiguates', () => {
  it('keeps the collided bare strings as distinct entries', () => {
    // `'polygon'` used to mean three different things and `'brush'` two. Namespacing is what makes
    // them addressable; sharing a GESTURE is what keeps them looking alike.
    expect(toolById('select.polygon').id).not.toBe(toolById('annotate.polygon').id)
    expect(toolById('select.polygon').surface).toBe('select')
    expect(toolById('annotate.polygon').surface).toBe('annotate')
    expect(toolById('annotate.brush').id).not.toBe(toolById('mask.brush').id)
    expect(toolById('annotate.brush').surface).toBe('annotate')
    expect(toolById('mask.brush').surface).toBe('mask')
  })

  it('leaves no surface module declaring a local tool union, label table or icon map', () => {
    // The six shipped declarations must be gone or registry-derived. Reading the real sources keeps
    // this honest: a future surface that hand-rolls `type XTool = 'a' | 'b'` fails here.
    const offenders: string[] = []
    // EVERY module under `viz-core/` (FIX_ROUND-2), derived — not the five hand-named surfaces plus
    // `gridModules()`. A surface that hand-rolls a tool union in a directory nobody listed is
    // exactly the escape this scan exists to close.
    const files = vizCoreModules()
    // A literal union of >=2 quoted members assigned to a tool-ish type alias, or a lucide import in
    // a surface that should be getting its glyphs from the registry.
    const LOCAL_UNION = /export\s+type\s+(\w*(?:Tool|Shape)\w*)\s*=\s*'[^']+'\s*\|\s*'/g
    // The ONE vocabulary the `…Shape` half of that pattern matches which is not a TOOL vocabulary,
    // declared with its justification in the `SHARED_GESTURES` idiom of this file rather than left
    // to a silently-narrowed regex. Widening the scan to all of `viz-core` (FIX_ROUND-2) is what
    // first reached it.
    const NOT_A_TOOL_VOCABULARY: Record<string, string> = {
      // A data-viz MARK vocabulary (which glyph a scatter series plots its points with), not a tool
      // the user picks up. It has no rail, no cursor and no gesture — nothing for the registry to own.
      MarkerShape: 'charts/labels.ts — the plotted point mark, not a tool',
    }
    for (const rel of files) {
      const src = fs.readFileSync(path.join(VIZ_CORE, rel), 'utf8')
      for (const m of src.matchAll(LOCAL_UNION)) {
        if (!NOT_A_TOOL_VOCABULARY[m[1]]) offenders.push(`${rel}: declares a local tool/shape union (${m[1]})`)
      }
      if (/^const TOOLS(:|\s*=)/m.test(src)) offenders.push(`${rel}: declares a local TOOLS table`)
      if (/SELECTION_TOOL_LABEL\s*:\s*Record<[^>]+>\s*=\s*\{/.test(src)) {
        offenders.push(`${rel}: declares a local label table`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('AUDITS EVERY ICON-BEARING SURFACE for glyphs that collide with a registered tool (M12)', () => {
    // BLIND-AUDIT M12 — the shipped guard checked ONLY `PaneToolbar.tsx`, so it was structurally
    // blind to the two surfaces that still imported lucide directly: `VizToolRail.tsx` and
    // `AnnotateControls.tsx`. Result: THREE verbs wore `Download` on one screen (rail "Export whole
    // grid", pane "Export this pane" (registered), dock "Use N points as seeds" — not an export at
    // all). A guard that inspects one file cannot see a collision that spans two.
    //
    // Rule: a surface may import a lucide glyph directly ONLY if that glyph is not the registered
    // icon of some gesture. Anything that IS registered must come through the registry, so the
    // gesture→glyph map stays the single source of truth for what a mark means.
    // EVERY module under `viz-core/` (FIX_ROUND-2) — see `vizCoreModules`. Any file importing a
    // lucide glyph directly is audited on the day it lands, in any directory.
    const ICON_SURFACES = vizCoreModules()
    // name → component, for every glyph any of these files may import directly.
    const byName = new Map<string, unknown>(Object.entries(LUCIDE_DIRECT))
    const registered = new Set<unknown>(Object.values(GESTURE_ICON))
    const offenders: string[] = []
    for (const rel of ICON_SURFACES) {
      const src = fs.readFileSync(path.join(VIZ_CORE, rel), 'utf8')
      const m = /import\s*\{([^}]*)\}\s*from\s*'lucide-react'/.exec(src)
      if (!m) continue
      for (const raw of m[1].split(',')) {
        const name = raw.trim()
        if (!name) continue
        const comp = byName.get(name)
        if (comp === undefined) {
          offenders.push(`${rel}: imports '${name}' directly — add it to LUCIDE_DIRECT in this test so its glyph is checked`)
          continue
        }
        if (registered.has(comp)) {
          offenders.push(`${rel}: imports '${name}' directly, but that glyph is REGISTERED to a gesture — route it through the registry`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('AUDITS UNREGISTERED glyphs for CROSS-SURFACE collisions (convergence low)', () => {
    // The M12 guard above closed only HALF the hole it was written for. Its rule is "a direct lucide
    // import must not be a REGISTERED glyph" — which says nothing about two surfaces importing the
    // same UNREGISTERED glyph for DIFFERENT verbs. That is exactly how `Download` came to sit on
    // three verbs (only one of them registered), and the previous fix round promptly opened a fresh
    // instance: `Eraser` for "Clear selection" in the rail AND "Cancel polygon" in the dock, both
    // reachable on one screen.
    //
    // Rule: an unregistered glyph may appear on more than one surface ONLY if it means the SAME verb
    // everywhere (declared below). Anything else is two marks that look identical and do different
    // things — the collision INV-14 exists to prevent, regardless of which side of the registry the
    // glyph sits on.
    const SHARED_CHROME: Record<string, string> = {
      // glyph → the ONE verb it is allowed to mean wherever it appears.
      X: 'close this panel',
      Check: 'commit the in-progress thing',
      Undo2: 'undo', Redo2: 'redo',
    }
    // EVERY module under `viz-core/` (FIX_ROUND-2) — see `vizCoreModules`. Any file importing a
    // lucide glyph directly is audited on the day it lands, in any directory.
    const ICON_SURFACES = vizCoreModules()
    const registered = new Set<unknown>(Object.values(GESTURE_ICON))
    const byName = new Map<string, unknown>(Object.entries(LUCIDE_DIRECT))
    /** glyph name → the surfaces importing it directly. */
    const usage = new Map<string, string[]>()
    for (const rel of ICON_SURFACES) {
      const src = fs.readFileSync(path.join(VIZ_CORE, rel), 'utf8')
      const m = /import\s*\{([^}]*)\}\s*from\s*'lucide-react'/.exec(src)
      if (!m) continue
      for (const raw of m[1].split(',')) {
        const name = raw.trim()
        if (!name) continue
        const comp = byName.get(name)
        if (comp === undefined || registered.has(comp)) continue // covered by the M12 guard above
        usage.set(name, [...(usage.get(name) ?? []), rel])
      }
    }
    const offenders = [...usage.entries()]
      .filter(([name, surfaces]) => surfaces.length > 1 && !SHARED_CHROME[name])
      .map(([name, surfaces]) => `'${name}' is imported by ${surfaces.length} surfaces (${surfaces.join(', ')}) ` +
        `but is not declared in SHARED_CHROME — either it means ONE verb everywhere (declare it) or ` +
        `two verbs wear one glyph (give one of them its own)`)
    expect(offenders).toEqual([])
  })

  it('routes the PANE TOOLBAR through the registry, leaving only non-tool chrome on lucide', () => {
    // Finding #14: `PaneToolbar.tsx` was the SEVENTH unregistered vocabulary — it imported `Pencil`
    // straight from lucide while the rail imported `Pencil` for annotate-mode, i.e. two pencils
    // meaning different things, which is exactly what INV-14 exists to prevent. Its tool-ish buttons
    // (Link / Edit / Annotate / Segment / Export / Data) now resolve through `toolFor('pane', …)`.
    const src = fs.readFileSync(path.join(VIZ_CORE, 'grid/PaneToolbar.tsx'), 'utf8')
    const lucide = /import\s*\{([^}]*)\}\s*from\s*'lucide-react'/.exec(src)
    const imported = (lucide?.[1] ?? '').split(',').map(x => x.trim()).filter(Boolean)
    // ONLY non-tool chrome may be imported directly: the drag grip, Split, and the DESTRUCTIVE
    // pane-remove. BLIND-AUDIT M13 — remove used to wear `X`, the same glyph as a dock's own close
    // button sitting right beside it: one closes a panel, the other destroys the pane and every dock
    // on it. The destructive one now reads as destructive.
    expect(imported.sort()).toEqual(['GripVertical', 'MoreHorizontal', 'SplitSquareHorizontal', 'Trash2'])
    expect(src).toMatch(/toolFor\('pane', 'annotate'\)/)
    expect(src).toMatch(/toolFor\('pane', 'segment'\)/)
    // …and the toolbar renders them, so the buttons genuinely exist. Testids are now BUILT from the
    // item key (`viz-cell-${key}-${testId}`) by the priority+ `action()` helper, so the literal
    // `viz-cell-annotate-` no longer appears in source — assert the item construction instead, which
    // is what actually produces the button. (The e2e proves the rendered result: see
    // `annotate-tooling-ux.e2e.mjs` FINDING-14, which reads the real buttons off each pane.)
    //
    // The second half is `testId`, NOT `cell.id`: on a composed grid the latter is the host's fold
    // key, and a pane's DOM identity is the id its author wrote (`cellTestId`). Pinning the exact
    // source form is what makes this guard notice a revert to the fold key — a change that renders
    // identically on every un-composed grid, which is every grid this file's own fixtures build.
    expect(src).toMatch(/data-testid=\{`viz-cell-\$\{key\}-\$\{testId\}`\}/)
    expect(src).toMatch(/action\('annotate',/)
    expect(src).toMatch(/action\('segment',/)
    // Both remain capability-gated — no button on a pane that cannot host that dock.
    expect(src).toMatch(/onAnnotate \? \[action\('annotate',/)
    expect(src).toMatch(/onSegment \? \[action\('segment',/)
  })

  it('keeps the pane toolbar\'s NON-registered chrome glyphs clear of every registered one', () => {
    // Close / Split / the drag grip are not TOOLS, so they stay out of the vocabulary — but "no two
    // visible glyphs mean different things" still has to hold across the whole toolbar.
    const chrome = { GripVertical, SplitSquareHorizontal, Trash2 }
    const registered = new Set<unknown>(Object.values(GESTURE_ICON))
    for (const [name, Icon] of Object.entries(chrome)) {
      expect(registered.has(Icon), `chrome glyph ${name} collides with a registered tool glyph`).toBe(false)
    }
  })

  it('gives the pane toolbar\'s Edit and Annotate DIFFERENT glyphs (finding #14)', () => {
    // They are now SIBLINGS in the same toolbar, so the shipped two-pencils collision would be side
    // by side rather than one surface apart.
    expect(toolById('pane.edit').Icon).not.toBe(toolById('pane.annotate').Icon)
    expect(toolById('pane.annotate').Icon).not.toBe(toolById('pane.segment').Icon)
    // Every pane-toolbar glyph is distinct from every other one in that toolbar.
    const icons = toolsForSurface('pane').map(t => t.Icon)
    expect(new Set(icons).size).toBe(icons.length)
  })

  it('removes annotate/segment from the GLOBAL rail entirely (finding #14)', () => {
    // No bulk toggle, no "open on all panes" secondary action, no compatibility shim.
    expect(() => toolFor('view', 'annotate')).toThrow(/unknown tool/)
    expect(() => toolFor('view', 'segment')).toThrow(/unknown tool/)
    const rail = fs.readFileSync(path.join(VIZ_CORE, 'controls/VizToolRail.tsx'), 'utf8')
    expect(rail).not.toMatch(/tool\('annotate'\)/)
    expect(rail).not.toMatch(/tool\('segment'\)/)
    expect(rail).not.toMatch(/annotateAvailable|segmentAvailable/)
  })

  it('routes the previously-inline GridWorkspace selection union through the registry', () => {
    // RE-POINTED, exactly as the note below always said it must be. `selTool` left
    // `GridWorkspace.tsx` at viz-render-perf SPLIT Q (ITEM-33) for the tool-state plane
    // `grid/useGridTools.ts`, so BOTH lines now read that file. The test is NOT deleted and the
    // precondition is NOT dropped — only the path changed. (DRIFT-57 records that this is the sixth
    // inherited control this decomposition has had to relocate, and the second guard FILE it reached:
    // iterating on `gridDecomposition.test.ts` alone did not surface it, the full unit run did.)
    const src = fs.readFileSync(path.join(VIZ_CORE, 'grid/useGridTools.ts'), 'utf8')
    // PRECONDITION, asserted rather than assumed (viz-render-perf INV-10). This is a NEGATIVE source
    // assertion, so it passes VACUOUSLY the moment `selTool` moves to another file — a guard that
    // silently stops guarding. If the state moves AGAIN, re-point BOTH lines at its new home rather
    // than deleting this test.
    expect(src, 'the selection-shape state must still live in useGridTools.ts, or this guard is vacuous').toMatch(
      /const \[selTool, setSelTool\] = useState<SelTool>/,
    )
    // The inline `useState<'rect' | 'polygon' | 'move'>` that did not even reference `SelShape`.
    expect(src).not.toMatch(/useState<\s*'rect'\s*\|\s*'polygon'\s*\|\s*'move'\s*>/)
    // …and it really is GONE from the shell, so the two files cannot both hold a copy.
    const shell = fs.readFileSync(path.join(VIZ_CORE, 'grid/GridWorkspace.tsx'), 'utf8')
    expect(shell).not.toMatch(/const \[selTool, setSelTool\] = useState<SelTool>/)
  })
})
