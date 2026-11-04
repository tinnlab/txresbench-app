-- execution_engine module — `txr_runs`: one row per analysis run (PROV-EE-10).
--
-- The app's run is an analysis-level aggregate the framework `jobs` row model
-- does not express (DEC-2): the full run record is this row + the per-method
-- rows (`txr_run_methods`) + the run-scoped log (`txr_run_logs`), written in
-- the SQLite dialect per `sqlite-store` PROV-sqlite-store-4's type map (uuid
-- BLOB 16 bytes, timestamps TEXT RFC3339 UTC, JSON TEXT, bool INTEGER 0/1,
-- floats REAL) — the same port conventions as `jobs`' own SQLite baseline.
--
-- The engine assigns ids (no AUTOINCREMENT — `Uuid::new_v4()` on the insert);
-- `config` / `input_summary` / `counts` / `model_ids` are TEXT JSON columns;
-- `model_ids` is NULL in train mode and carries the resolved asset ids JSON
-- array in reuse mode (reconcile GAP-HS-3). `input_summary` carries the file
-- summary INCLUDING `file_names` (the uploaded source names captured at
-- create, never derived from the dir stem — reconcile GAP-HS-1).
--
-- `dir` is the user-visible run tree under the app data root
-- (`<data_root>/analysis-<UTC yyyy-mm-dd-hhmm>-<id8>/`, DEC-5) and `seed` is
-- the fixed contract seed (DEC-12).

CREATE TABLE txr_runs (
    id BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    status TEXT NOT NULL,
    mode TEXT NOT NULL,
    config TEXT NOT NULL,
    input_summary TEXT NOT NULL,
    model_ids TEXT,
    method_count INTEGER NOT NULL,
    counts TEXT NOT NULL,
    elapsed_secs INTEGER,
    dir TEXT NOT NULL,
    memory_total_bytes INTEGER,
    cpus INTEGER,
    error TEXT,
    started_at TEXT,
    finished_at TEXT,
    predictions_ready INTEGER NOT NULL DEFAULT 0,
    seed INTEGER NOT NULL,
    CONSTRAINT txr_runs_pkey PRIMARY KEY (id)
);

-- The History (K) list is newest-first; the index serves the paged
-- `GET /api/txr/runs?limit=&offset=` ordering.
CREATE INDEX txr_runs_created_at_idx ON txr_runs(created_at DESC);
