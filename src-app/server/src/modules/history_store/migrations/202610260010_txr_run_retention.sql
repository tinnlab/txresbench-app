-- history_store module — `txr_run_retention`: the per-run half of the K
-- retention policy (PROV-HS-5, DEC-5 / D25). A row is written LAZILY, only
-- by a copy-clear operation (first clear of a run), and a run WITHOUT a row
-- reads as `copies_kept = true` — the INV-2 conservative direction: file
-- copies are considered kept until the explicit action says otherwise (the
-- per-run "clear copies" or the all-runs "Do not keep copies of my files").
-- `copies_cleared_at` is the RFC3339 UTC stamp of the last clear for the
-- run (NULL until one ran).
--
-- `run_id` is the engine's run id (PROV-EE-10's `txr_runs`, BLOB 16-byte
-- uuid — one entity, one id). The FK carries the engine's own ON DELETE
-- CASCADE rule: the engine's run delete (`DELETE /api/txr/runs`, clear-all,
-- CONS-HS-8) removes the retention bookkeeping with the row, so this node
-- never leaves a retention row for a deleted run and never prunes a dead
-- one. (WITHOUT the cascade the engine's clear-all would fail with an FK
-- violation from the moment one retention row exists — the engine must not
-- know this node's table.)
--
-- SQLite dialect per PROV-sqlite-store-4's type map: uuid BLOB 16 bytes,
-- timestamps TEXT RFC3339 UTC, bool INTEGER 0/1 (the `.txr_runs` precedent;
-- ids are assigned app-side, never a SQL default).

CREATE TABLE txr_run_retention (
    run_id BLOB NOT NULL,
    copies_kept INTEGER NOT NULL DEFAULT 1,
    copies_cleared_at TEXT,
    CONSTRAINT txr_run_retention_pkey PRIMARY KEY (run_id),
    CONSTRAINT txr_run_retention_run_id_fkey FOREIGN KEY (run_id) REFERENCES txr_runs(id) ON DELETE CASCADE
);
