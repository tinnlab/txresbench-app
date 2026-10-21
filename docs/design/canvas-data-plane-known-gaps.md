# Canvas data plane — known gaps (not fixed)

**Status.** Found while fixing the criteria before/after panes (the "editing a
criterion's min/max does not update the plot" defect); none of the three was in
scope for that fix. Each entry states the claim, the evidence that established it,
and what it cost. Where an entry has since been closed, the claim + evidence are
kept as the record of *why* the fix has the shape it does.

| | state |
|---|---|
| G1 | **closed** — `rev` implemented in `5005ffbf`; the app moved off the content-addressed-id workaround onto it |
| G2 | **closed** — `VizController.dispose()` (`5005ffbf`) is now wired to the app's teardown: `teardownCanvas` releases after removing the panes, so every controller `CanvasView` abandons gives its refs back |
| G3 | **closed** — `aa51384c`: both readings now go through one `columnKind` classifier instead of two copies of the rule |

---

## G1 — `VizDataset.rev` is documented but implemented nowhere — **CLOSED**

**Closed in two steps.** `5005ffbf` implemented the contract in `libs/viz`:
`DatasetStore.acquire(id, source?, rev?)` re-resolves an entry IN PLACE when the rev
it recorded differs, `VizController.applyOption` forwards `d.rev`, and a same-or-absent
rev keeps the cheap identity reuse. The app then moved off the workaround: `canvasFeed`
publishes the id the declaration wrote and carries the same content digest as `rev`,
and the reverse map that existed only to translate the decorated ids back is gone with
it. The two properties are pinned separately in
`extensions/canvas/canvasLiveMask.test.ts` — that the pane still reshapes, and that it
reshapes under the SAME dataset id — because a test of either alone passes on an
implementation that gets the other backwards. The record below is what was true before
that, kept because it is the argument for the shape of the fix.

**Claim.** The declarative option type advertises a per-dataset content-invalidation
token. Nothing in the package reads it, so there is no way for a host to tell viz
that a dataset's *content* changed while its id stayed the same.

**Evidence.** `src-app/libs/viz/src/viz-core/option/types.ts` declares
`VizDataset.rev` with the contract "same `id` + new `rev` ⇒ re-acquire/re-stream;
same `id` + same `rev` ⇒ no-op reuse". `adapter/VizController.ts::applyOption`
then reduces the option's datasets with `normalizeDatasets(option).map(d => d.id)`
— the `rev` is dropped at that line and never reaches the store.
`adapter/DatasetStore.ts::acquire(id, source?)` takes no `rev` parameter at all
and returns early on `if (existing)` after a ref-count bump, so the resolver is
never re-invoked for an id it has already resolved. `grep -rE '\brev\b'` over
`libs/viz/src` returns the type declaration plus one unrelated local (a
reverse index in `viz-core/coordination/selectionSync.ts`).

**Cost then.** A host whose dataset content changes under a stable id keeps the
first source forever. That is exactly what froze the "after" pane of the criteria
before/after pair: the keep-mask re-derived correctly on every keystroke, the feed
republished a correct new source, and viz handed back the one it built first. The
app compensated in
`ui/src/modules/workbench/extensions/canvas/canvasFeed.ts` by putting a
*content-addressed* id on the wire (`<logical>#<sliceDigest>[.<maskDigest>]`) and
keeping a reverse map so the resolver still spoke the declaration's vocabulary.
That worked, but it bought invalidation by minting a new dataset **identity** — and
because a resolved dataset is also an identity space, a content change silently
reset that space's selection. Implementing `rev` let the host go back to stable
logical ids and keep the space, which is what it now does. The digest itself was
kept verbatim: it is what makes "changed content" detectable at all, and the memo
on it (by slice object identity) is what keeps the O(rows × columns) walk off the
typing path. Only where it is *carried* changed.

---

## G2 — dataset ref-counts are never released when a canvas is torn down — **CLOSED**

**Closed in two steps, and the second one is where it actually took effect.** `5005ffbf` added
`VizController.dispose()` — it releases every ref the controller holds, RELEASES rather than evicts
(a second live controller may hold the same slice), is idempotent, and bumps the option sequence so
a `setOption` still in flight bails at the existing staleness guard instead of re-pinning after
teardown. But it wired that only to `<Viz>`'s unmount, and the declarative canvas does not go
through `<Viz>`: `CanvasView` drives a raw `VizController` and abandons it via `teardownCanvas`,
which dispatched `removePane` per grid entry and nothing else. `dispose()` therefore had no caller
anywhere in `src-app/ui/src`, and the leak below was unchanged for the one controller that a real
session actually accumulates. `teardownCanvas` now removes the panes and then disposes.

**Which call site, and why not the other one.** Since `aa51384c` the canvas has two distinct
shrinking events, and only one of them abandons a controller:

- **one view's contribution is retired** (`declarativeMount.destroy` → `canvasHost.clear` →
  `declarativeCanvasFeed.clear`) — the remaining contributions recompose and the SAME controller is
  re-driven with the smaller option. `applyOption` acquires the new set before releasing the
  previous one, so the retired view's slice drops out and every surviving view's is carried through
  under the identity it already had. Nothing is abandoned, so nothing here may dispose; doing so
  would take the canvas down while other panes are still plotting on it.
- **the canvas is torn down** — the last contribution retires (the composed feed goes inactive), an
  explicit-prop controller is replaced, or `CanvasView` unmounts. All three call `teardownCanvas`
  and null the reference immediately after, so that controller will never be driven again. Those are
  its only three call sites, which is why the release belongs inside it rather than at each of them.

**Tests.** `extensions/canvas/canvasTeardown.test.ts` (a torn-down canvas leaves zero retained
entries; a slice a second live canvas holds survives the same teardown) and
`extensions/canvas/canvasContributionRetire.test.tsx` (closing one pane leaves the other plotted;
the retired view's own slice does not linger; the shared controller carries the survivor across the
recompose under the same generation). The last of those drives the feed + `driveCanvas` with no
mounted grid on purpose: `GridWorkspace` takes a reference of its own, which is enough to hold an
entry up through a controller that was disposed and immediately rebuilt, so the controller's own
ref-keeping is only observable when it is the one holder.

**Claim.** Tearing a canvas down removes its panes but releases none of its
dataset references, so those entries stay resident in the module-singleton store
for the life of the page.

**Evidence.** `ui/src/modules/workbench/extensions/canvas/canvasBinding.ts::teardownCanvas`
dispatches one `{ type: 'removePane' }` per grid entry. `VizController.dispatch`'s
`removePane` arm calls `gridWorkspace.removeCell` + `pruneResolvedForCell` and
touches no dataset ref-count. The **only** release site in the controller is
`applyOption` (`for (const id of prevIds) this.stores.datasetStore.getState().release(id)`),
which runs on the *next* `setOption` — and `CanvasView`'s declarative effect nulls
`declControllerRef.current` immediately after `teardownCanvas`, so for a torn-down
canvas that next `setOption` never comes. `DatasetStore.release` evicts only at
refCount 0, and `defaultVizStores.datasetStore` is a module singleton shared by
every controller the page constructs.

**Cost then.** Each abandoned controller left its last option's dataset entries
(resolved source, catalog, per-layout positions, colour buffer) pinned. It was
bounded per teardown rather than per edit — a re-drive released the previous ids
normally, because `applyOption` does sweep them — but the total never returned to
zero across a session that opens and closes analyses repeatedly. A
`release`-on-teardown (or a controller `dispose`) was what would close it, and is
what did.

---

## G3 — `unresolvableBinding` does not mirror `CanvasObsSource.catalog()`, though it says it does

**Claim.** The predicate the canvas host uses to pre-filter series it knows viz
cannot serve is documented as an exact mirror of the catalog it is checked
against, and is not: it omits the identifier-column exclusion.

**Evidence.** Both live in
`ui/src/modules/workbench/extensions/canvas/canvasBinding.ts`.
`CanvasObsSource.catalog()` builds its categorical channel as
`!isNumericCol(col) && !isIdentifierColumn(col)` — a column holding a distinct
value in every row is deliberately **not** advertised as a grouping.
`unresolvableBinding`'s categorical test is `!isNumericCol(col)` alone, under a
doc comment reading "The kind test mirrors `CanvasObsSource.catalog()` exactly
(numeric ⇒ value + continuous, everything else ⇒ categorical), so this predicate
agrees with what viz's validator will see for the same slice."

**Cost today.** A series whose categorical channel binds a per-row-identifier
string column passes the host's pre-filter, reaches viz, and is rejected by
`viz-core/option/parse.ts::validateBindings` — which throws for the **whole**
option. One such binding therefore blanks the entire canvas and console-errors on
every render, which is precisely the outcome the pre-filter exists to prevent
(its own comment says so). It is latent rather than live: the criteria builder
applies the same `isIdentifierColumn` predicate when deciding which columns to
offer, so no shipped surface can currently reach it. Any future declaration that
binds a grouping without going through that builder can.
