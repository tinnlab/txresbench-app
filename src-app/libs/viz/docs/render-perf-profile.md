# `#plot-editing` zoom lag — measured attribution

**Date** 2026-07-27 · **Branch under test** `annotate-tooling-ux` @ `9b94865f`
(worktree `/data/pbya/txresbench/tmp/annotate-tooling-ux-wt`, served on my own vite `:1791`)
**Baseline** merge-base `origin/main` `c176c715` (throwaway worktree
`/data/pbya/txresbench/tmp/mainperf-wt`, served on `:1792`)

> READ-ONLY on product source. Everything below was measured through Playwright +
> CDP; the only code changes were **response rewrites via `page.route()`** of the
> vite-transformed modules (never a file on disk).
> Probe scripts: `/data/pbya/txresbench/tmp/perfprobe/{measure2,count,commits,paths,getopt,whatif}.mjs`.
> Raw output: `/data/pbya/txresbench/tmp/perfprobe/o2-*.json`, `c-*.json`, `p2-*.cpuprofile`.

---

## 0. Harness + one honest caveat

Chromium (playwright 1.61), headless, **software WebGL**
(`--use-gl=angle --use-angle=swiftshader`), viewport 1440×900, the **dev** vite
showcase with **React StrictMode on** — i.e. exactly the surface the owner is
looking at, except the GPU.

**Caveat that matters for reading the numbers:** under swiftshader, GPU/raster
cost is paid on the CPU by the compositor. That inflates the *rasterize-off*
`#data-progressive` comparison (it draws a full-canvas point cloud every frame).
So I report **main-thread scripting** as the hardware-independent metric, and
call out where a stall is GPU-side (`0 long tasks` + high frame time) vs
main-thread (`long tasks`). `#plot-editing`'s lag is entirely main-thread; it
does **not** go away on a real GPU.

Wheel drive: `page.mouse.wheel(0,-120)` over a fixed point inside a cell, N steps
at a fixed cadence. Each `mouse.wheel` awaits acknowledgement, so
**"wheel-ack p50" is a direct proxy for perceived input lag.**

---

## 1. Reproduced + quantified

### 30 wheel steps, 120 ms apart, cursor over a **scatter** cell

| surface | points drawn | **ScriptDuration** | TaskDuration | long tasks | wheel-ack p50 | frames >33 ms |
|---|---|---|---|---|---|---|
| `#plot-editing` — **branch** | 20 000 (2×2 grid) | **2254 ms** (75 ms/wheel) | 2858 ms | **27** (Σ 2074 ms, max 99 ms) | **101 ms** | 33 |
| `#plot-editing` — **main `c176c715`** | 20 000 | **2040 ms** (68 ms/wheel) | 2591 ms | 25 (Σ 1804 ms) | 90 ms | 32 |
| `#data-progressive`, rasterize **OFF** | 20 000 raw GPU points | **682 ms** (23 ms/wheel) | 1150 ms | **0** | 30 ms | 12 |
| `#scatter-basic` (control) | **200 000** raw points | **194 ms** (6.5 ms/wheel) | 655 ms | **0** | 30 ms | 7 |

The control line is the whole answer to "is it the point count":
**200 000 points cost 6.5 ms of script per wheel; 20 000 points inside the grid
cost 75 ms — 11.6× more script for 10× fewer points.**

### 40 wheel steps, 25 ms apart (a realistic continuous wheel/trackpad flick)

| surface | wall for a 1 s gesture | wheel-ack p50 / max | p95 frame | Script | long tasks |
|---|---|---|---|---|---|
| `#plot-editing` | **21.2 s** | **104 / 1645 ms** | **1300 ms** | 2558 ms | many |
| `#data-progressive` raw 20 k | 19.0 s | 562 / 1551 ms | 467 ms | 908 ms | **0** |

`#data-progressive` also stalls *in this harness* — but with **zero long tasks**,
i.e. it is blocked in the software rasterizer, not on the main thread. That stall
is a swiftshader artifact and is exactly what disappears on the owner's real GPU,
which is why they perceive it as smooth. `#plot-editing`'s stall is 2.5 s of
JavaScript and does not.

### Cell-kind control

Wheeling over the **box** or **violin** cell produces **literally nothing** —
`onViewStateChange` never fires (`vsc` counter = 0, 20 wheels delivered to the
canvas), 0 React elements created, 0 ms script. Chart cells do not wheel-zoom at
all. So the cost is not chart-kind-specific; it is triggered **only** by a
dense/scatter cell's camera change.

---

## 2. Where the time goes (attribution, with evidence)

### 2.1 React element creations per wheel (jsxDEV wrapped via route interception)

| surface | elements created **per wheel step** |
|---|---|
| `#plot-editing` — branch | **2 352** |
| `#plot-editing` — main `c176c715` | 1 690 |
| `#data-progressive` raw 20 k | 336 (all plain `dom:*` from the story's own control bar) |
| `#scatter-basic` 200 k | **0** |

Branch breakdown, per single wheel tick:

```
386  dom:span        252  Button          176  dom:div
136  TooltipTrigger  136  TooltipProvider  96  MenuRowButton
 68  TooltipContent / Tooltip / TooltipRoot / TooltipPopup / TooltipPositioner / TooltipPortal (each)
 60  SelectItem       24  SelectTrigger / SelectValue   12  Select{Content,Popup,Portal,…}
  8  PaneToolbar       8  CellView       12  dom:canvas
```

`PaneToolbar` = **8 per wheel** = **4 panes × 2**. `CellView` likewise 8.
The **2×** is React StrictMode's dev double-invoke; the underlying commit count
was measured independently (fake `__REACT_DEVTOOLS_GLOBAL_HOOK__`,
`onCommitFiberRoot`): **exactly 2 commits per wheel event** (40 commits / 20
wheels).

**So one wheel tick re-renders the entire grid — all four panes' toolbars, their
kit `Select`s, every `Button` wrapped in a `Tooltip`+`TooltipProvider`+portal,
plus every `CellView` — twice, and in dev each of those twice again.**

### 2.2 CPU-profile attribution (30 wheels, busy = 2853 ms)

Nearest-app-frame / outermost-app-frame attribution of the sampled profile:

```
outermost app frame            ms (of 2853 busy)
GridWorkspace.tsx:185           261.6
PaneToolbar.tsx:69              256.5
kit/button.tsx                  128.5 + shadcn/button.tsx 35.4
shadcn/tooltip.tsx               75.5 + 19.4 + 17.4 + 13.5
kit/select.tsx                   44.5 + shadcn/select.tsx 20.5 + 9.6 + 4.0
VizToolRail.tsx                  25.1
CellView.tsx                     24.9
ColormapScatterLayer.draw        21.6   ← the actual scatter GPU submit
ChartCanvas / ViolinView / BoxView  3.5 / 3.8 / 0.8
```
Top self-time is React itself: `jsxDEV` **749.6 ms**, `createElement` 151 ms,
`jsxDEVImpl` 98 ms, `createTask` 68 ms, `jsx` 54 ms — i.e. > 1.1 s of the 2.85 s
busy window is pure React element construction/reconciliation.

### 2.3 Causal A/B (route-interception what-if, same harness back-to-back)

Wrapping the exported `PaneToolbar` so it returns `null` (hooks intact, no file
edit):

| | ScriptDuration, 30 wheels |
|---|---|
| baseline | **2174 ms** |
| `PaneToolbar → null` | **1029 ms** |

**The per-pane toolbar chrome alone is 53 % of the per-wheel scripting cost.**

### 2.4 The mechanism

Measured with counters injected into the transformed `GridWorkspace.tsx`:

- one wheel → `onViewStateChange` fires **exactly once** (`vsc` 20/20 wheels,
  `viewId: "cat"`), from deck's controller (wheel target = `CANVAS`). The
  workspace's own non-passive `onDrawWheel` never fires here.
- in the measured session `linked === true`, so the camera is written to the
  **shared coordination zustand store**; `GridWorkspace` reads it back with
  `useStore(stores.coordination, s => s.viewStates)` (`useSyncExternalStore`).
  (In the unlinked branch it is `setLocalStates` — React state on the *same*
  component. Either way the whole component re-renders.)
- `GridWorkspace` is a **5 759-line single component** that renders the deck,
  every overlay, every `CellView` and (through it) every `PaneToolbar` inline.
- **Nothing on that path is memoized**: `grep -n "memo(" PaneToolbar.tsx
  CellView.tsx CellChrome.tsx` → *no matches*.

That is the whole bug: a camera value lives in the same component as all the
pane chrome, so a camera change rebuilds the chrome.

### 2.5 Hypotheses explicitly RULED OUT (with the numbers)

| hypothesis from the brief | verdict | evidence |
|---|---|---|
| camera round-trips through `getOption()` | **true but irrelevant** | patched counter: `getOption` fires **20× for 20 wheels** (the 150 ms debounce doesn't coalesce at a 150 ms tick cadence) — but `getOption` inclusive time is **7.0 ms over 30 wheels**. Real mechanism, negligible cost. |
| `option.controls` UI (legend/colormap/marks/titles) re-render | **not the driver** | the in-cell control components do not appear in the top-25 attribution; the chrome cost is `PaneToolbar` + kit `Button`/`Tooltip`/`Select`. |
| box + violin cells re-aggregating per frame | **ruled out** | `ChartCanvas` 3.5 ms, `ViolinView` 3.8 ms, `BoxView` 0.8 ms inclusive **over 30 wheels**. |
| chart/scatter **layer builders** rebuilding | **ruled out** | `_updateLayers` 2.1 ms inclusive / 30 wheels; `_drawLayers` 180 ms (6 ms per wheel — real, small); `ColormapScatterLayer.draw` 21.6 ms. |
| all 4 cells rebuild when one camera moved | **CONFIRMED** | `CellView` 8 elements/wheel and `PaneToolbar` 8 elements/wheel with 4 panes (4 × StrictMode 2). |
| React re-render storms | **CONFIRMED, dominant** | 2 352 elements/wheel; 2 commits/wheel; `jsxDEV` 750 ms self. |
| dataZoom / camera-bound sliders | **minor** | `AxisDataZoom` 4.8 ms, `ValueDataZoom` 3.1 ms over 30 wheels. |
| point count | **ruled out** | 200 k bare scatter = 6.5 ms/wheel vs 20 k in-grid = 75 ms/wheel. |

---

## 3. Pre-existing or a regression?

**Pre-existing, and made ~10 % worse by this branch.**

| | main `c176c715` | branch `9b94865f` | delta |
|---|---|---|---|
| ScriptDuration / 30 wheels | 2040 ms | 2254 ms | **+10.5 %** |
| long tasks | 25 (Σ 1804 ms) | 27 (Σ 2074 ms) | +15 % |
| React elements / wheel | 1 690 | **2 352** | **+39 %** |
| `PaneToolbar` renders/wheel | 8 | 8 | unchanged |
| `CellView` renders/wheel | 8 | 8 | unchanged |

The **structure** of the bug (whole-grid re-render on camera change, no memo) is
identical on `c176c715`. What the branch added is per-render *volume*, from the
priority+ overflow toolbar: `PaneToolbar`'s `action()` helper eagerly builds
**both** forms of every item on every render — the inline `Button`+`Tooltip`
**and** the overflow `MenuRowButton` row — even when nothing is folded, plus a
`data-item-key` `<span>` wrapper per item.

Per-wheel deltas vs main: `MenuRowButton` **+96**, `dom:span` **+320**,
`Button` +48, `Trash2/Waypoints/Pencil/Table2/SquareSplitHorizontal/Download`
+24…+32 each (each icon now rendered twice — inline and as a menu row).

---

## 4. Recommended fix (not implemented — another agent owns this tree)

Tiered, cheapest first. Expected impacts are from the measured A/B above.

1. **`React.memo` the pane chrome — `PaneToolbar` and `CellView` — and stabilize
   their props at the call site.** *(moderate, not one line)*
   Bounded by the measured what-if: **−53 % script per wheel** (75 → 35 ms).
   Honest sizing: `memo` only pays if **every** prop is referentially stable.
   `GridWorkspace`'s `<CellView>` call site (`GridWorkspace.tsx:4930`) already
   passes mostly `useCallback`ed handlers, but also `rect={r}`,
   `linkColor={linkColorFor(cell.id)}`, `cellColors={perCellColors[…]}` and
   several `Set.has(...)` booleans — each needs to be either memoized or proven
   stable, and `showToolbar`/`containerId` are fine. Budget it as a focused
   pass over that one call site + a `memo` on each of the two components, not a
   rewrite.

2. **Build the overflow `menu` JSX lazily.** *(small — recovers the branch's
   regression)* In `PaneToolbar`'s `action()`, make `menu` a thunk (or construct
   the menu rows only inside the `Popover content` callback / only for
   `rank < hiddenRank`). Removes ~96 `MenuRowButton` + ~320 `span` +
   ~24 duplicate icon elements per wheel: **the +39 % element / +10 % script
   branch delta.**

3. **Keep the camera out of the component that renders the chrome.**
   *(architectural — the real fix)* `GridWorkspace` is 5 759 lines in one
   component and subscribes to `viewStates`. Split the deck + views into a child
   that subscribes to the camera, and let the pane-chrome subtree render from
   props that don't include camera state (or read the camera through a ref /
   context only the deck subtree consumes). This makes 1 and 2 unnecessary rather
   than merely cheaper, and it is what stops the next feature from re-introducing
   the same cost.

4. **Investigate the 2 commits per wheel.** Measured, not yet explained: one
   `onViewStateChange` produces two React commits. Halving that halves everything
   above. (`setLocalStates` is *not* the second one — no `useState` setter inside
   `GridWorkspace.tsx` fires during a wheel; the camera takes the linked/zustand
   branch.)

**Immediate mitigation available to the owner today, no code change:** the grid
already has a `showToolbar` / `cellToolbarsOn` switch. Turning per-pane toolbars
off is precisely the `PaneToolbar → null` configuration I A/B'd — **−53 % script
per wheel**.

---

## 5. Reproduce

```bash
cd /data/pbya/txresbench/tmp/annotate-tooling-ux-wt/src-app/libs/viz
npx vite --port 1791 --strictPort --host 127.0.0.1
cd /data/pbya/txresbench/tmp/perfprobe
node measure2.mjs A '#plot-editing' 580 280                     # timings + profile
node measure2.mjs B '?points=20000#data-progressive' 850 500 rasterOff
node measure2.mjs D '#scatter-basic' 800 500                    # 200k control
node count.mjs    A '#plot-editing' 580 280                     # elements/wheel
node commits.mjs  A '#plot-editing' 580 280                     # React commits/wheel
node whatif_base.mjs X '#plot-editing' 580 280                  # A/B: toolbar on
node whatif.mjs      Y '#plot-editing' 580 280                  # A/B: toolbar null
node analyze.mjs p2-A-plotedit-scatter.cpuprofile               # attribution
```
