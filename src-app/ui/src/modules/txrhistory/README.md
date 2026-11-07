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
