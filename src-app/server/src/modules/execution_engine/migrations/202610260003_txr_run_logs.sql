-- execution_engine module — `txr_run_logs`: the run-scoped log (PROV-EE-10,
-- DEC-13). One global sequence per run (UNIQUE(run_id, seq)) keeps the
-- ordering of the F screen's log panel and "Copy the log" deterministic; a
-- row's `method_id` is NULL for engine-authored state lines (starting,
-- downloading N of M MB, cannot-run reason, done in X, stopped by the user)
-- and set for a method's wrapper stdout/stderr lines.
--
-- The engine trims oldest rows past `MAX_LOG_LINES_PER_RUN = 20_000` (DEC-21);
-- consumers page with `after_seq` + `limit` (the `(run_id, seq)` index below
-- serves both the append's seq-uniqueness and the ordered page).

CREATE TABLE txr_run_logs (
    id BLOB NOT NULL,
    run_id BLOB NOT NULL,
    seq INTEGER NOT NULL,
    method_id TEXT,
    stream TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT txr_run_logs_pkey PRIMARY KEY (id),
    CONSTRAINT txr_run_logs_run_id_fkey FOREIGN KEY (run_id) REFERENCES txr_runs(id) ON DELETE CASCADE,
    CONSTRAINT txr_run_logs_run_id_seq_key UNIQUE (run_id, seq)
);

CREATE INDEX txr_run_logs_run_id_seq_idx ON txr_run_logs(run_id, seq);
