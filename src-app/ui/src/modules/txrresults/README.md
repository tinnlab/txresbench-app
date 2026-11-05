# txrresults

The results module of the TxResBench app: the two screens of one analysis
run's predictions — screen G (the patient × method heatmap, board
`BusyResults.dc.html`) and screen H (one run's methods in detail, boards
`Results.dc.html` / `SaveOne.dc.html`). A run's identity lives in the URL
(`/analysis/<runId>/…`), so every results view is deep-linkable and
back/forward-correct; the module renders the engine's predictions and says
nothing about anything outside the run.

## Routes

| screen | board | route | what the user sees |
|---|---|---|---|
| G — predictions heatmap | `BusyResults.dc.html` | `/analysis/:runId/results` | patient × method heatmap, per-method columns growing live while the run continues, cannot-run banners, search/sort/method-group filters, per-patient Average, download-all CSV, save-the-models entry |
| H — compare methods | `Results.dc.html` | `/analysis/:runId/results/compare` | the run's methods side by side: method tablist (Compare + one tab per finished method), outcome tabs, patient × method bar table, the two-method compare card |
| H — one method | `Results.dc.html` / `SaveOne.dc.html` | `/analysis/:runId/results/methods/:methodId` | one method's patient table with its outcome tabs, the explanatory cards and the saved-in / open-folder line |

Every route is `requiresAuth: true` under the shell layout (`TxrLayoutDef`
from `txrshell/module.tsx`). The three path builders live in `routes.ts` and
are re-exported by the barrel (`index.ts`):
`resultsPath(runId)`, `compareResultsPath(runId)`,
`methodResultsPath(runId, methodId)` — the sibling flow modules navigate with
the builders, never with URL literals (`ui-run`'s screen-F "See the results" /
leave-and-continue, `ui-history`'s screen-K "reopen results"). `compare` and
`methods` are reserved path words: they are route segments, never method ids
(catalog ids are slugs such as `landmark-cox-current`).

## Events

The module declares two framework EventBus events (AppEvents declaration
merging in `events.ts`) for the save-models entry points the boards put on
the results screens; `ui-models` (the L dialog host) is the consumer:

| event | payload | emitted by |
|---|---|---|
| `txr:save-models-requested` | `{ runId, methodIds }` | G/H header "Save the models (N)" |
| `txr:save-one-model-requested` | `{ runId, methodId }` | H one-method header "Save this model" |

Until `ui-models` mounts its host, a click emits into an empty bus — a benign
no-op; the dialogs themselves belong to `ui-models`, never to this module.

## Provider contract

The module consumes only the execution engine's run surfaces through the
generated client (`ApiClient.Txr.*`: run detail, the run SSE stream, logs,
predictions, the CSV download) — the run detail's methods/logs/models/estimate
facts and the per-method predictions/coverage/task rows. The generated
`Txr*` types and the `Txr.*` operation ids are provider-owned (the engine's
OpenAPI regen). This module never regenerates OpenAPI, never edits
`src-app/ui/src/api-client/**` or `src-app/ui/openapi/**`, and never calls
any other provider's surface (no method catalogue, no file validator, no
model store from this module).

## G heatmap construction

The heatmap (`TxrHeatmapTable`) is a module-local native table on purpose
(DEC-11): the board's construction pins the patient column AND the header on
two axes (`position: sticky; left: 0` on the patient column, `top: 0` on the
header), and the kit `Table`'s virtualized grid path has no pinned-left-column
API — the heatmap is the board's own native-table idiom, not a parallel
re-implementation of the framework. The per-cell colors are the board's live
alpha formula (`rgba(29, 78, 137, 0.04 + pct/100*0.86)`, light text from 52 %),
and the fixed 36 px rows are windowed: only the viewport's row window mounts
(plus the overscan) with spacer rows padding the rest, so a 500-patient run
renders a bounded DOM. H's bar table (a handful of columns, no pinning) is the
kit `Table` twin. A future kit gain (pinned-column support) is the refactor
trigger for this component.

## Copy source

Every user-facing string in this module is the boards' wording, verbatim:
the page titles, the subtitle segments, the sort options, the legend, the
"Showing N of M … Show all M" footer, the banner sentence, the compare-card
sentences and the explanatory cards. The boards' NUMBERS — their patient
counts, method counts, ids and probabilities — are design examples, never
data and never constants in code or fixtures (FLOW.md): the module renders
only the engine's real values through the format helpers.
