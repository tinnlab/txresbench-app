# txrhistory

The history screen of the TxResBench app: screen K (board `History.dc.html` —
"Everything you ran on this computer, newest first. Open a result again, or
run it again with the same settings."). It is the newest-first run list: the
search field + the four-option filter, the collapsible per-run cards (header
row + expanded detail block with your files, settings, methods, the took
line and the made-models line), the run actions (open the results, run again
with the same settings, download predictions, open the folder, show the log)
and the footer (run count, disk usage, the two retention controls).

The module is a plain reader of the providers' frozen contracts: the run
records, the retention preference and the usage figure come from
`history-store`; the rerun/clear/logs/predictions/analysis-config actions
are `execution-engine`'s; the route targets of the run actions are the
sibling modules' path builders. Nothing is re-derived and no data leaves the
machine (INV-4) — every call goes through `@/api-client` against the app's
own loopback server.

## Routes

| screen | board | route | what the user sees |
|---|---|---|---|
| K — history | `History.dc.html` | `/history` | the newest-first run list (search + filter), the collapsible per-run cards, the run actions and the footer |

The route is `requiresAuth: true` under the shell layout (`TxrLayoutDef` from
`txrshell/module.tsx`). The builder lives in `routes.ts` and is re-exported
by the barrel (`index.ts`): `historyPath()`. The module also OWNS `/history`
in the router: the same route the `txrshell` scaffold used to render (its
comment records the handoff — the scaffold route block is removed; the `/`
handoff is `txrintake`'s and the `/models` handoff is `txrmodels`'s, same
file, their own blocks). A second `/history` registration would collide, so
the takeover is the route's only owner.

## Filter and display vocabulary

The K filter select's four options and the display words are the module's
own host-state vocabulary (`types.ts`, barrel-exported): `TxrHistoryFilter`
('all' / 'learned' / 'saved-model' / 'stopped-failed' — the board's four
labels in `FILTER_OPTIONS`), `TxrBucketLabel` (the consumer's display map
for the provider's `TxrHistoryBucket` — history-store DEC-4), `TxrModeLabel`
(the chip words for the provider's `TxrRunMode`), `TxrHistoryView` (the
paged list the store owns) and `TxrHistoryActions` (a row's resolved
capabilities). The DATA vocabulary is the provider's, from the generated
client: `TxrHistoryItem` / `TxrHistoryDetail` / `TxrHistoryKind` /
`TxrHistoryUsage` / `TxrHistoryPreferences` / `TxrRunLogLine` etc. The page
size is the provider default (`PAGE_SIZE = 20`); the list is server-paged
(limit/offset), server-side search and filter — never a client-side sieve
over a full dump (INV-1).

## Provider bindings

The module consumes the providers through the generated client
(`@/api-client`), plus the sibling modules' path builders and helpers
through their barrels:

| surface | source | used by |
|---|---|---|
| history list/detail/preferences/copies/usage | `ApiClient.History.*` (history-store routes) | the K list + detail + footer |
| rerun/clear/logs/predictions/analysis-config | `ApiClient.Txr.*` (execution-engine routes) | the K row actions + the log dialog |
| `resultsPath` | `txrresults` (PROV-UR-1, barrel) | "Open the results" |
| `downloadPredictionsCsv`, `revealRunDir` | `txrresults` (PROV-UR-6/7, barrel) | "Download predictions" / "Open the folder" |
| `runningPath`, `chooseMethodsPath` | `txrrun` (PROV-UI-RUN-1, barrel) | the running-row action + the settings-again destination |
| `modelsPath(setId)` | `txrmodels` (PROV-UI-MODELS-1, barrel) | the detail's model-set links |

The generated types and operation ids are provider-owned (the providers run
the shared OpenAPI regen once); this module never regenerates OpenAPI and
never edits `src-app/ui/src/api-client/**` or `src-app/ui/openapi/**`.

The GAP records this node's consumer-driven growth requests against the
providers: `GAP-HIST-1` (`TxrHistoryUsage.data_dir` — grown; the footer's
path segment renders it when present), `GAP-HIST-2` (`models_used` — grown;
the reuse-row titles and the model links), `GAP-HIST-3` (the multi-value
`status=stopped,failed` — grown; the fourth filter option is ONE call),
`GAP-HIST-4` (the `txrresults` barrel re-export of `downloadPredictionsCsv`
+ `revealRunDir` — consumed through the barrel, no seam mirror) and
`GAP-HIST-5` (`modelsPath(setId)` — grown; the model-set links open the set).

## Retention controls

The footer's two controls are the K board's retention surface, and both are
destructive-gated (INV-2): no destructive call happens without the confirmed
dialog. With `keep_file_copies: true` the footer offers "Do not keep copies
of my files" — confirming PUTs `keep_file_copies: false` then POSTs the
all-runs copy clear (the provider's future-default + immediate-clear
semantics, the owner's D25 decision), then reloads the list + usage. With
`false` it offers "Keep copies of my files" — confirming PUTs only (removed
copies are never restored, stated in the dialog). The red "Clear all
history" opens the owner's two-choice dialog — "Clear history and remove
files" (the default) or "Clear history, keep files" — whose choice is the
engine DELETE's `delete_files`. The per-run state is displayed honestly both
ways: a kept-copies run reads the board's "Copies are kept with this run so
it can be repeated.", a copy-cleared run reads "Copies are not kept with
this run." (never a silent absence), and a copy-cleared row offers the
settings-prefill path ("Use these settings again" — the owner's D26
fallback) instead of a rerun call that would 400.

## Tests

The module's two Playwright specs sit in the repo's two e2e tiers, each under
its own runner (no extra config, no testIgnore): `tests/gallery-e2e/
txr-history.spec.ts` (backend-free — the module's cassette stories over the
synthetic fixture family, driven by `playwright.gallery.config.ts`) and
`tests/e2e/txrhistory/txr-history-full.spec.ts` (the real backend against
the merged providers, driven by `playwright.config.ts`). The unit suite
lives beside the module (`module.test.ts`, the store/lib/component/fixture
tests). The specs assert through the pages' own test-ids and the story
seams, never by probing the components.

## Copy source

Every user-facing string is the board's wording, verbatim: the title and
subtitle, the filter labels, the card words ("Learned and predicted",
"Saved model", "Done", "Failed", "Stopped", "Show details"), the re-run
buttons ("Run again with the same settings", "Use these settings again"),
the footer words ("Your data never leaves it.") and the retention links.
The boards' NUMBERS — run counts, patient counts, sizes in MB, durations —
are design examples, never data and never constants in code or fixtures
(FLOW.md): the module renders only the providers' real values through its
format helpers.

The module's own files are shipped copy: no work-status wording and no
unfinished-work markers appear in the module's source, fixtures or this
README (the repo's published-file rule); the node's design choices and
drift records live in the node's lifecycle docs next to the plan, never in
the module.
