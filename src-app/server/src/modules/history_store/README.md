# history_store

The run-history home of the TxResBench app: it serves the History screen (K)
as a searchable, filterable, bounded-paged view over the engine's run records
— one shaped item per run carrying everything the K row renders, so the screen
makes no per-run detail fetches — and it owns the retention policy the K
footer exposes: the keep-copies preference, the two copy-clear operations and
the disk-usage figure. The only screen K's data this module does not provide
is the actions' own calls: reopening a result and the reuse paths belong to
the engine and to `ui-results` (the capability booleans + ids + names this
module serves are the data those actions need). Everything it does is local:
no network I/O, no telemetry, no analytics — the module performs no outbound
call of any kind.

## What is read, and from where

The view is a read-side projection (INV-6 — never a parallel run store, never
a second database):

| table | owner | read here for |
|---|---|---|
| `txr_runs` | execution_engine (PROV-EE-10) | the run row (status, mode, config JSON, `input_summary` JSON incl. the recorded file names, `counts`), the stored create-time estimate, the reuse run's recorded `model_ids`, the run dir |
| `txr_run_methods` | execution_engine | the compact per-method times of a list row (id, version, seconds) and the rich per-method rows of the detail (the engine's own `TxrRunMethod` verbatim), the first terminal reason |
| `txr_run_logs` | execution_engine | the log line count only (the "Show the log" action's data is the engine's `/runs/{id}/logs` route) |
| `txr_model_sets`, `txr_models` | model_store (PROV-MS-11) | the "Made: N models (…)" names, the detail's saved-model records and the set-name search term — read-only, never a write, never an asset resolve |
| `txr_history_preferences`, `txr_run_retention` | this module | the keep-copies singleton (id = 1, seeded by the migration) and the per-run retention marks |

Provider shapes are bound, never restated: the run mode, endpoint, reason
and per-method row types are the engine's own; the estimate quality is the
method catalogue's `TimingQuality`; the SQL uses the shared SQLite port rules
(instr/lower substring, JSON1 membership — no FTS, no new crate).

## Retention semantics (INV-2)

"Copies are kept with this run so it can be repeated" is the default
(`txr_history_preferences.keep_file_copies = true`, seeded by the migration,
never inserted by code — a code insert is a test failure). The module never
silently deletes a user's uploaded file copies. Copy deletion exists only as
the two explicit, board-mandated actions, and each removes ONLY
`<run_dir>/input/` — never `bundles/`, never per-method outputs, never a model
tree, never a run record. (In the actual engine the canonical `patients.csv` /
`values.csv` / `features.csv` and `run-input.json` are written INSIDE that
same `input/` dir, so the input-removal is the dir's wholesale removal — the
per-method `bundles/` remain the durable per-method inputs.) Each clear
marks the run's retention row (`copies_kept = 0` + stamp), which flips the K
row's `can_rerun` false — a copy-less run cannot be replayed by the engine,
whose rerun clones the stored input copies; the K action falls back to
settings prefill. A run whose recorded dir fails the naming + canonical floor
checks is refused (`UNSAFE_RUN_DIR`, nothing deleted, nothing written). The
preference write itself is NOT destructive: clearing existing copies is the
explicit all-runs operation, issued by the UI after its confirmation dialog.

## The engine growth items this node depends on

Two facts the K board renders are the ENGINE's, grown at reconcile and
consumed here through the declared read seam:

- **GAP-HS-1 — recorded file names**: `txr_runs.input_summary.file_names`
  (`patients`, `measurements`, `predict_measurements`) — the list row's
  `file_names` comes from the recorded names, never from the run dir stem.
- **GAP-HS-3 — consumed model ids**: a reuse run records the model ids it
  consumed (`txr_runs.model_ids`), joined here over the model-store seam to
  render the "Predicted with a saved model" facts; `[]` in train mode and a
  model row without a set is skipped — a name is never fabricated.

## Boundaries

- **No run creation/control, no run persistence.** `POST /api/txr/runs`,
  stop/skip and the run tables are the engine's; the history routes are
  read-only over them plus the two module-owned retention tables.
- **No duplication of the engine's delete/clear routes.** `DELETE
  /api/txr/runs/{id}?delete_files=` and `DELETE /api/txr/runs?delete_files=`
  stay the engine's ("Clear all history") and are consumed by `ui-history`
  through the generated client; this module adds only the retention-specific
  surface the engine's route surface does not cover.
- **No model-store writes, no save/edit/delete of models or sets.**
- **No UI, no events.** Screen K is `ui-history` (wave 4); the six routes are
  request/response — no SSE, no WebSocket, no sync entity. K's freshness is
  the consumer's reload-on-focus choice.
- **No search machinery.** Plain SQL substring per the provider's port rules;
  the fold is ASCII-only (a documented limitation — method ids, generated
  file names and set names are ASCII in this app).
- **No disk GC beyond the two copy-clear operations.** No automatic retention
  window, no env-cache cleanup, no model-dir pruning.

## The K board as copy source

The module's vocabulary comes from the History board design: the run rows
(newest first, one row per run with the files/methods line, the
learned/predicted + endpoint/horizon subtitle, the Done/Failed/Stopped/Running
state, the reason line), the expanded block (Your files with the copies note,
Settings, per-method lines, Took versus the stored estimate, Made models) and
the footer (run count, usage figure, keep-copies preference, clear-all). The
board's display strings are the consumer's — this module delivers data, never
display text (the mode/bucket/reason vocabularies pass through verbatim).

## The routes

All gated by the reused `jobs::use` permission (no new permission, no
permission migration):

- `GET /api/txr/history` — the paged K list (`q`, `kind`, `status`, `limit`,
  `offset`).
- `GET /api/txr/history/{id}` — the expanded K block.
- `GET`/`PUT /api/txr/history/preferences` — the keep-copies default.
- `POST /api/txr/history/{id}/copies/clear` and
  `POST /api/txr/history/copies/clear` — the two copy-clear operations.
- `GET /api/txr/history/usage` — the footer's run count + grouped byte figure.

Error vocabulary: `404 RUN_NOT_FOUND` (the engine's own code for the same
entity), `400 INVALID_STATUS` (a malformed `status` filter) and `400
UNSAFE_RUN_DIR` (the copy-clear's tampered-dir refusal).
