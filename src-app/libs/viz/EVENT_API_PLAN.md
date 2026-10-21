# Plot Event / Observability API — Design Plan

Give consumers/embedders a **unified, typed way to react to plot interactions** — selection, legend
enable/disable, filter, zoom, hover — the equivalent of ECharts' `chart.on('selectchanged' |
'legendselectchanged' | 'datazoom' | 'brushselected', handler)`. Today the signals exist but are
**fragmented** and there is no single public event contract.

## Current state (what's already reachable)
- **`useCoordinationStore.subscribe(selector, cb)`** (exported from `/core` + barrel) — the de-facto
  stream: `pointSelection` (+ `selectionOrigin`), `viewStates`, `colorScales`. This is the main hook.
- **`VizController.subscribe(fn)`** — coarse (fires on `setOption`/`dispatch`, no payload).
- **Per-component callbacks** — `DeckScatterCanvas.onHover`, chart `onHover`, `SelectionController.
  onChange(mask)`, `keyboardControls.onZoom`, the `Legend` hidden-set callback. `<Viz>` has only
  lifecycle callbacks (`onMounted`/`onError`/`onController`).
- **No EventBus / emitter** (only `BroadcastChannel` for the pop-out).

## The design — one typed event surface, in BOTH forms

### Event union (domain-neutral payloads — pointIds, category codes, column names)
- **`select`** — `{ ids: Uint32Array /* canonical point ids */, origin: string | null }` (points
  selected/cleared). Uses the canonical point-ID seam, NOT array indices.
- **`legend`** — `{ column: string, hidden: readonly number[] /* category codes */ }`.
- **`dataZoom`** — `{ id: string, axis: 'x'|'y', window }` (a per-plot zoom window changed).
- **`filter`** — `{ id: string, column?: string, range: [number, number] | null }` (visualMap/gate).
- **`hover`** — `{ id?: number, value?: number, ... } | null` (rAF-throttled).
- (optional) **`gridViewState`** — `{ spaceKey, viewState }`; **`colorScale`** — `{ key, domain }`.

### API — two forms (matches our imperative/declarative split)
1. **Imperative** — a typed emitter on `VizController`: `controller.on(type, handler): () => void`
   (returns unsubscribe) + internal `emit(type, payload)`. Lets a non-React consumer listen.
2. **Declarative** — `<Viz>` callback props: `onSelect(ids, origin)`, `onLegendChange(column, hidden)`,
   `onDataZoom(id, window)`, `onFilter(id, range)`, `onHover(info)` — wired to the emitter.

### Wiring (bridge the EXISTING signals — mostly plumbing, not new mechanism)
- **select** — subscribe the coordination store `pointSelection`+`selectionOrigin` → emit. (Already
  flows through the store.) Carry `origin` so a consumer can skip its own echo.
- **hover** — unify the per-component `onHover` → emit (rAF-throttled).
- **dataZoom** — the DataZoom component's window is a render-prop today; add a thin `onWindowChange`
  bridge → emit. (`dispatch({type:'dataZoom'})` already stashes a window — make it a real signal.)
- **legend** — the `Legend` hidden-set → the cell's `ColorBy.hidden`; route the Legend change through
  a store field / callback → emit.
- **filter** — the visualMap/gate range is component-local; surface it via a callback → emit.

## Key rules
- **Notify + PAYLOAD** (unlike the app-level notify-and-refetch sync — this is a client API, not a
  security boundary, so it carries the actual data).
- Every `on(...)` returns an unsubscribe; hover is rAF-throttled; selection is id-based.
- Domain-neutral names + payloads throughout.

## Files
- `adapter/VizController.ts` — the typed emitter (`on`/`emit` + the event-union types), or a sibling
  `adapter/events.ts` for the bridge.
- `adapter/coordinationHandle.ts` / a new bridge — subscribe the coordination store → emit `select`.
- `react/Viz.tsx` — the callback props → wire to the emitter.
- Component-local sources (`controls/Legend.tsx` hidden, the DataZoom component window, chart
  visualMap `filter`, `onHover`) — add a thin bridge so they reach the emitter.
- NOT `option/types` (events are runtime callbacks, not declarative option config).
- Tests + a story/e2e (make a selection → `onSelect` fires with the ids; toggle legend →
  `onLegendChange`; zoom → `onDataZoom`; hover → `onHover`).

## Phasing + sequence
- **Phase 1:** `select` + `dataZoom` + `hover` (already in the store / with component callbacks — the
  highest value, least plumbing).
- **Phase 2:** `legend` + `filter` (surface the component-local state into the emitter).

Sequence **after the color wave** (it overlaps `controls/Legend.tsx` and the coordination layer).
Build directly in the tree — NOT `isolation:worktree` (it can't nest in this worktree).
