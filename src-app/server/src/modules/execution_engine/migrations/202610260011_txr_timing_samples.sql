-- execution_engine module — `txr_timing_samples`: one row per measured
-- method run (qa-fixes2 ITEM-6, R2-3: the estimate was 2-7 times too high
-- against the seconds the app records after real runs, so the estimate
-- engine calibrates its per-method base with THIS app's own measured
-- durations).
--
-- A row is written at a method's `finished` patch (train-mode runs only —
-- a reuse run measures the predict half alone and would skew the per-fold
-- base), with the run's own facts: the wall duration (`measured_ms`,
-- `duration_ms` on the method row), the training cohort size (`patients`)
-- and the run's CPU count (`cpus`), all three needed to normalize the
-- measured seconds into the DEC-7 reference shape (150 patients / 4 CPUs).
--
-- The table is the estimate's MEMORY, deliberately distinct from the runs
-- themselves: clearing history deletes runs but the calibration one or two
-- runs provided is exactly the evidence the next run's estimate is
-- calibrated against (and `recorded_at` keeps the record honest).
--
-- `run_id` BLOB 16 bytes (the SQLite uuid convention of the other txr
-- tables), `method_id` TEXT the catalogue id; one row per completed method
-- run — the engine writes it once per finalize, no dedup needed (the
-- primary key is the row id; a rerun of the same method is a NEW sample).

CREATE TABLE txr_timing_samples (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    method_id TEXT NOT NULL,
    run_id BLOB NOT NULL,
    measured_ms INTEGER NOT NULL,
    patients INTEGER NOT NULL,
    cpus INTEGER NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX txr_timing_samples_method_idx ON txr_timing_samples(method_id);
