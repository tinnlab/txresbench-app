# txrmodels

The model screens of the TxResBench app: screen D (board `Pretrained.dc.html`
— "Choose the models to run"), screen I (board `Saved.dc.html` — "Choose the
saved models to run", the saved models grouped by the training run) and
screen J (board `Models.dc.html` — "Your models", the inventory of every
model kept on this computer), plus the save dialogs L / L2 / L3 (boards
`SaveModels.dc.html`, `SaveOne.dc.html`, `SaveDone.dc.html`) that open over
the results screen of a finished run.

The two choice screens (D and I) mount the ONE shared selection list
(`TxrSelectList` from `txrlist`, per the FLOW.md design: "D, I and E are ONE
list component with different rows") — this module builds the model rows,
hosts the chips/sort/search, and owns the Run handoff into the engine. The
save dialogs are this module's: `txrresults`' "Save the models" button only
emits the event; the dialog host subscribes and owns the save flow.

## Routes

| screen | board | route | what the user sees |
|---|---|---|---|
| D — choose pretrained models | `Pretrained.dc.html` | `/pretrained-models` | the real model catalogue, checked against the uploaded predict file: the card rows (tag, performance on other cohorts, can-run status with what is missing, time, Model card), the download state for non-bundled models, the chips + sort, the bottom bar (selected count, total time, run-at-a-time, research notice, Run) |
| I — choose saved models | `Saved.dc.html` | `/saved-models` | one section per saved set (facts line, select-all, Rename / Delete the run's models), the model rows with their own-data performance, search + "Same outcome as my file" + sort, the same bottom bar, Run (reuse mode) |
| J — your models | `Models.dc.html` | `/models` | the inventory table (Model + subline, Method, Predicts, Decision day, Trained on, Made, Use / Export / Rename / Delete), search, "Open a model file", the models-folder footnotes + desktop-gated "Open the folder" |

Every route is `requiresAuth: true` under the shell layout (`TxrLayoutDef`
from `txrshell/module.tsx`). The path builders live in `routes.ts` and are
re-exported by the barrel (`index.ts`): `pretrainedModelsPath()`,
`savedModelsPath()` and `modelsPath(setId?)`. The module also OWNS `/models`
in the router: the same route the `txrshell` scaffold rendered (its comment
records the handoff — the scaffold route block is removed) — a second
`/models` registration would collide, so the takeover is the route's only
owner. `modelsPath(setId)` targets `?set=<set_id>`: screen J restricts the
table to that set and shows a "Showing the set … · Show all" affordance
(screen K binds the same convention).

## Events

The module's one cross-screen seam is the EventBus dialog entry (PROV-UR-3),
subscribed by the `routerEffects` dialog host (`TxrModelsDialogHost`):

| event | direction | payload | entry |
|---|---|---|---|
| `txr:save-models-requested` | in (from `txrresults`) | `{type, runId, methodIds}` | the G/H "Save the models (N)" button — opens dialog L |
| `txr:save-one-model-requested` | in (from `txrresults`, after its growth) | `{type, runId, methodId}` | the H one-method view "Save this model" — opens dialog L2 |

Until the second event's growth lands, L2 renders from the module's own
gallery story only — never a dead button without a handler.

## Provider bindings

The module consumes model-store, pretrained-catalogue and execution-engine
surfaces through the generated client (`@/api-client`), plus the shared
selection list and the intake/run/results seams:

| surface | source | used by |
|---|---|---|
| models list/detail/sets/eligibility/save/import/export/rename/delete/resolve | `ApiClient.Models.*` + `ApiClient.ModelSets.*` (model-store routes) | the J table + I rows + the L/L2/L3 dialogs + the D/I Run resolve |
| pretrained list/card/eligibility/downloads/download/install | `ApiClient.Pretrained.*` (pretrained-catalogue routes) | the D list + the download-state column + install-then-run |
| run create/detail/predictions/methods | `ApiClient.Txr.*` (execution-engine routes) | the L checklist + the D/I Run creation |
| the shared list + its formatters | `txrlist` (PROV-UI-LIST-1/2/4) | the D/I host wiring — its README's three-step host contract is the binding prose |
| the intake store + `buildTxrRunInput` | `txrintake` (PROV-UI-INTAKE-2) | the D/I Run `input` — always through the builder, never re-mapped |
| `runningPath`, `resultsPath`/`revealRunDir` | `txrrun`, `txrresults` | the Run handoff + the J open-folder |

The generated types and operation ids are provider-owned (the providers run
the shared OpenAPI regen once); this module never regenerates OpenAPI and
never edits `src-app/ui/src/api-client/**` or `src-app/ui/openapi/**`.

The one inventory object (`InventoryEligibilityRequest`) the D and I
eligibility calls carry is the intake's — the ONE builder pinned at
reconcile (ui-list DEC-15; the same pin ui-run's plan records), never
re-implemented here.

## Copy source

Every user-facing string is the boards' wording, verbatim: the D/I titles
and step lines, the bottom-bar notice ("For research. Not for deciding a
patient's treatment."), the J header line and footnotes, the dialog copy.
The boards' NUMBERS — patient counts, model counts, percents, sizes, AUCs,
times — are design examples, never data and never constants in code or
fixtures (FLOW.md): the module renders only the engine's / catalogue's real
values through its format helpers.

The module's own files are shipped copy: no work-status wording and no
unfinished-work markers appear in the module's source, fixtures or this
README (the repo's published-file rule); the node's design choices and
drift records live in the node's lifecycle docs next to the plan, never in
the module. The gallery stories' models and sets
(`gallery.tsx` + `fixtures.ts`) are synthetic — made-up ids, patients and
counts constructed in-test — and the real-backend spec creates its own
inputs; no real data of any kind enters the tree (the repo rule). Model
files are never read here: this module carries ids and metadata only —
models load inside the method's sandbox, the provider's download/install/
verify owns the bytes (INV-7).
