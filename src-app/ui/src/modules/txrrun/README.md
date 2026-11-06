# txrrun

The run screens of the TxResBench app: screen E (board `Busy.dc.html` —
"Choose the methods and settings") and screen F (board
`BusyRunning.dc.html` — a run as it executes). E turns the uploaded
patients/measurements/predict files and the run settings into a method
selection and creates the run through the execution engine; F shows that
run live: per-method state, download/progress, per-method action (skip /
stop / show log / view result), Stop all, the leave-and-continue note, and
the results readable while the other methods still run.

## Routes

| screen | board | route | what the user sees |
|---|---|---|---|
| E — choose methods and settings | `Busy.dc.html` | `/choose-methods` | the file slots (Patients / Measurements / Predict) with "Change files", the four setting rows (Predict, Decision day, Look ahead to, Extra inputs + More settings), the shared `TxrSelectList` with its group chips, and the bottom bar (selected count, total time, run at-a-time, save-the-trained-models, research notice, Run) |
| F — running | `BusyRunning.dc.html` | `/analysis/:runId/running` | the header (methods count, time left, elapsed, concurrency line, "See the results"), the five-count strip, the All / Working / Finished / Failed tabs, the method table (state, detail, progress, time, per-state action), Stop all, the leave-and-continue note and the log panel |

Every route is `requiresAuth: true` under the shell layout (`TxrLayoutDef`
from `txrshell/module.tsx`). The path builders live in `routes.ts` and are
re-exported by the barrel (`index.ts`): `chooseMethodsPath()` and
`runningPath(runId)` — the flow modules navigate with the builders, never
with URL literals. The E path is the convention `ui-intake` already
declared (`ROUTE_CONVENTIONS.methods`) and this module registers it; the F
path keeps the `/analysis/:runId/` prefix `txrresults` uses, and screen K
(`ui-history`) binds `runningPath` to reopen a running run. `compare` /
`methods` are `txrresults`' reserved path words, never used here.

## Provider seams

The module consumes three provider surfaces, all through the generated
client (`@/api-client`); the generated ids and types are provider-owned
(one shared OpenAPI regen by method-catalogue + file-validator +
execution-engine) — this module never regenerates OpenAPI and never edits
`src-app/ui/src/api-client/**` or `src-app/ui/openapi/**`:

| surface | generated operation | used by |
|---|---|---|
| method catalogue (list + one method) | `ApiClient.MethodCatalogue.list` / `.detail` | E's group chips + the About dialog |
| method eligibility + estimate | `ApiClient.MethodCatalogue.eligibility` / `.estimate` (inside `txrlist`'s `useMethodRows` / `useListEstimate` — the host never calls them directly) | the E list + the bottom-bar total |
| run create / detail / stream / logs / stop / skip / at-a-time / sticky config / list | `ApiClient.Txr.createRun` / `.getRun` / `.streamRun` / `.listRunLogs` / `.stopRun` / `.stopMethod` / `.skipMethod` / `.setAtATime` / `.getAnalysisConfig` / `.updateAnalysisConfig` / `.listRuns` | the E create path + the whole F screen |
| history preferences | `ApiClient.History.getPreferences` | E's keep-copies: the preference is read once at setup, the intake builder's default wins on a failed read (read-elsewhere — the node stores nothing itself) |

All calls are loopback to the app's own origin; the module adds no network
host. The liveness of F is the engine's run SSE (`Txr.streamRun`) — the
run store never subscribes to a sync bus or a global notification.

## Cross-module handoffs

- `txrintake` — the E route convention; the intake store's snapshot,
  `buildTxrRunInput` and the `TxrFileCard` (the change-files dialog hosts
  it). Both nodes' plans declare the other as the seam (PROV-UI-INTAKE-1/5,
  PROV-UI-RUN-1) — the proposed edges DEC-17 records; RECONCILE added
  `ui-intake -> ui-run` to the graph (OWNER-5/D74 confirmed).
- `txrresults` — the path builders `resultsPath(runId)` /
  `methodResultsPath(runId, methodId)` for F's "See the results" and the
  finished row's "View result" (the second proposed edge, DEC-17). This
  module binds them from the barrel and never spells those URLs.
- `txrlist` — the shared selection list + its hooks, the ONE list for the
  E/D/I screens (INV-3); E hosts it as-is.

## Copy source

Every user-facing string is the boards' wording, verbatim: the E setting
labels and option sets, the F state labels, the per-state actions, the
Stop-all confirm and the leave-and-continue note ("Finished methods keep
their results. You can leave this screen: the run continues, and it stays
in History."). The boards' NUMBERS — patient counts, method counts, times,
downloaded bytes — are design examples, never data and never constants in code
or fixtures (FLOW.md): the module renders only the engine's real values
through its format helpers. All fixtures of the module are synthetic
(made-up method ids, `P`-style patient keys, counts constructed in-test);
no real data of any kind enters the tree (the repo rule).

The research notice ("For research. Not for deciding a patient's
treatment.") is one constant in the module and renders on both run screens.
