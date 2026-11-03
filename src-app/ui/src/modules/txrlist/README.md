# txrlist

The shared model/method selection list module of the TxResBench app.

The three list screens are ONE component with different rows (FLOW.md):
screen E (methods to run, `Busy.dc.html`), screen D (pretrained models,
`Pretrained.dc.html`) and screen I (saved models, grouped by the training
run, `Saved.dc.html`). The module owns the rendering contract — row layout,
count chips, selection semantics, the bottom bar — and nothing else: no
route, no store, no data fetching of its own, no per-screen chrome.

## What the module provides

| surface | provides |
|---|---|
| `types.ts` (barrel `index.ts`) | the normalized row/section/selection contract — `TxrListRow`, `TxrListSection`, `TxrFilterChip`, `TxrSortControl`, `TxrSearchControl`, `TxrRunStatus`, `TxrListChipTone` |
| `components/TxrSelectList.tsx` | the list: windowed rows inside a `ScrollArea`, built-in "All N" / "Can run N" count chips, "Select all that can run", per-row checkbox (disabled for `cannot` rows), the bottom bar (selected count, total time, at-a-time, save-models, research notice, Run), empty/loading/error states |
| `components/TxrListRow.tsx`, `TxrListSectionHeader.tsx`, `TxrListFilterBar.tsx`, `TxrListBottomBar.tsx` | the row, the screen-I run-group header (title, run facts, select-all, host actions), the filter/search/sort bar, the bottom bar |
| `data/methodRows.ts`, `data/useMethodRows.ts`, `data/useListEstimate.ts` | the method-catalogue adapter: catalogue × eligibility join into rows (screen E), the list + eligibility fetch keyed on a stable inventory hash, the debounced bottom-bar estimate |
| `lib/format.ts`, `lib/selection.ts` | the board copy formatters (duration, coverage, reason lines, totals, plurals) and the pure selection helpers |

The three screens differ only in data and host chrome: `itemLabel`
(method/model), the chips, the research notice, the at-a-time control, the
save-models toggle, the run grouping.

## The row contract

`TxrListRow` is the single normalized row shape (methods on E, models on
D/I; hosts build rows from their own providers):

| field | meaning |
|---|---|
| `key` | stable row identity; the selection-set member and the `txr-list-row-<key>` test-id |
| `name`, `tag` | the display name and the secondary line ("Paper 2021, R" for methods) |
| `chip` | the group/model-kind chip (`{ label, tone }`) or `null` |
| `performanceText` | "other cohorts: AUC 0.64", or `null` for no performance column |
| `run.status` | `'can'` / `'some'` / `'cannot'` — the eligibility verdict on the uploaded file |
| `run.headline`, `run.detail` | the board string ("Can run for some patients") and the "what is missing / coverage" line — produced from the structured eligibility fields by `lib/format.ts` |
| `run.disabled` | derived by the builder (`status === 'cannot'`); disabled rows are never selectable or counted |
| `timeText` | "about 2 min", or `null` for no time cell |
| `action` | the row action slot (`{ label }`) — the host wires the click; the dialogs are the hosts' |

`TxrListSection` carries the screen-I run group (title, run-facts subtitle,
the section's `rowKeys`, host `actions` with `'default'`/`'danger'` tones);
the section select-all toggles exactly the section's non-disabled rows.

## Wiring a host screen (three steps)

1. **Build the rows.** The host maps its provider data to `TxrListRow[]`
   (the method adapter's `buildMethodRows` does this join for screen E) and
   passes the rows pre-filtered for the host-controlled chips/search/sort.
2. **Hold the selection.** Selection is host state (`useState` +
   `lib/selection.ts`, or the hook hosts use); the list is controlled via
   `selected` + `onSelectionChange` — single source of truth for the
   estimate and the run hand-off.
3. **Render the list.**

```tsx
import { TxrSelectList } from '@/modules/txrlist'

<TxrSelectList
  rows={rows}
  sections={sections}                 // screen I only
  itemLabel="method"                  // 'model' on D/I
  selected={selected}
  onSelectionChange={setSelected}
  filterChips={chips}                 // D/I host chips
  search={search}                     // screen I
  sort={sort}                         // D/I
  bottomBar={{
    selectedCount: selected.size,
    totalTimeText: formatTotalTime(estimate?.scheduleSeconds ?? null),
    atATime: { value: 3, onChange: setAtATime },   // E only
    saveModels: { checked: saveModels, onChange: setSaveModels }, // E only
    notice: 'For research. Not for deciding a patient\'s treatment.', // D/I
    onRun: (keys, opts) => host.run(keys, opts),
  }}
  onRowAction={row => host.openDialog(row)}   // About / Model card / Details
  onSectionAction={(key, actionId) => host.runAction(key, actionId)} // I rename/delete
/>
```

## The screen-E adapter

Screen E (the methods picker) gets its rows and its bottom-bar total from
the module's two fetch hooks, which drive the generated `@/api-client` only
(no `fetch()`, no host literal — INV-4):

```tsx
const { rows, loading, error, refetch } = useMethodRows(inventory)
const estimate = useListEstimate(selectedKeys, {
  patients: inventory.patients,
  atATime,
})
```

`useMethodRows` fetches the catalogue and the eligibility verdicts and joins
them (`data/methodRows.ts`), keyed on a stable inventory hash: the inventory
object a host rebuilds on every render does not refetch, an inventory
content change does, and `refetch()` retries. `useListEstimate` debounces
the selection 250 ms, keys on the selected set (the per-set estimate cache
survives an empty selection), and discards out-of-order responses — only the
newest selection's request may write the totals.

## Method-catalogue binding

The E-row facts and the per-row eligibility + time come from
`method-catalogue`'s three endpoints (`/api/methods`, `/api/methods/eligibility`,
`/api/methods/estimate`) through the generated `@/api-client` —
`ApiClient.MethodCatalogue.list/.eligibility/.estimate` — against the app's
own loopback origin. The wire types (`MethodSummary`, `EligibilityResponse`,
`InventoryEligibilityRequest`, `EstimateResponse`) are the provider's
generated output: `method-catalogue` owns the OpenAPI regen, this module
never regenerates and never commits the generated files. A provider regen
that renames an operation or a type moves this module's adapter mechanically
with it (the adapter tests fail loudly until the names match).
