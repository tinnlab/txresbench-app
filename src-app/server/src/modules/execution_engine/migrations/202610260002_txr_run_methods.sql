-- execution_engine module — `txr_run_methods`: one row per selected method of
-- a run (PROV-EE-10). The row carries the method's identity + catalogue facts
-- (`label`/`version`/`group`, PROV-EE-3), its state in the per-method state
-- machine (INV-2: waiting → downloading → running → finished/failed/stopped/
-- skipped/cannot_run), the env download counters versus the manifest
-- `size_bytes` (CONS-EE-7), the admitted `jobs` row id (DEC-4), the sandbox
-- result facts (exit code, duration, digests), the contract fulfilment facts
-- (`prob_source`, coverage, `task` — the enumerated outcome vocabulary,
-- CONS-UR-8) and the run's own reason (`reason_code`/`reason_detail`) when the
-- row did not reach `finished`.
--
-- UNIQUE(run_id, method_id): a method never runs twice in the same stack and
-- the engine keys env state / serialized rows / F-screen rows on one id
-- (CONS-EE-8c).
--
-- `"group"` is deliberately double-quoted: GROUP is a SQLite keyword and the
-- column name is the plan's wire `group` (PROV-EE-10) — the repository quotes
-- it the same way in every query.

CREATE TABLE txr_run_methods (
    id BLOB NOT NULL,
    run_id BLOB NOT NULL,
    method_id TEXT NOT NULL,
    label TEXT NOT NULL,
    version TEXT NOT NULL,
    "group" TEXT NOT NULL,
    state TEXT NOT NULL,
    reason_code TEXT,
    reason_detail TEXT,
    phase TEXT,
    bytes_downloaded INTEGER NOT NULL DEFAULT 0,
    bytes_total INTEGER,
    job_id BLOB,
    env_base_digest TEXT,
    env_layer_digest TEXT,
    model_out_digest TEXT,
    model_dir TEXT,
    exit_code INTEGER,
    duration_ms INTEGER,
    elapsed_secs INTEGER,
    prob_source TEXT,
    coverage_scored INTEGER,
    coverage_eligible INTEGER,
    task TEXT,
    started_at TEXT,
    finished_at TEXT,
    CONSTRAINT txr_run_methods_pkey PRIMARY KEY (id),
    CONSTRAINT txr_run_methods_run_id_fkey FOREIGN KEY (run_id) REFERENCES txr_runs(id) ON DELETE CASCADE,
    CONSTRAINT txr_run_methods_run_id_method_id_key UNIQUE (run_id, method_id)
);

-- The coverage fraction a run detail carries is derived from the two coverage
-- counters; both are NULL together (no coverage recorded).
CREATE INDEX txr_run_methods_run_id_idx ON txr_run_methods(run_id);
