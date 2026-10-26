-- compute_meter — append-only per-job compute-usage raw signal (epic
-- compute-storage, T3 / PROV-T3-3 / G3) — SQLite dialect port (ITEM-8) of
-- `src/modules/jobs/migrations/202608050002_compute_meter.sql`.
--
-- T3 EMITS the raw teardown signal (a final cgroup read at the run's
-- child-exit finalize); the deferred T5 aggregates it into per-account
-- cpu/gpu-seconds and maps project_id -> account (§9 / DEC-7). Each row is
-- ONE finished run's compute footprint:
--   cpu_secs   — cumulative CPU time (cpu.stat usage_usec / 1e6) at child-exit,
--   wall_secs  — wall-clock run duration,
--   gpu_secs   — GPU-seconds (0 for a cpu-sandbox run; a Gpu-class run fills it later),
--   ram_peak_bytes — memory.peak of the run's cgroup subtree.
--
-- EXACTLY-ONCE per job (INV-5): job_id is UNIQUE and the emit is INSERT ... ON CONFLICT
-- (job_id) DO NOTHING, so the LIVE finalize and a BOOT re-finalize of the same job never
-- double-emit — the first writer wins, a replay is a no-op. The plan keys idempotency on
-- job_id (natural key) rather than a surrogate so the runner can emit without coordination.
--
-- Deliberately NO foreign key on job_id / project_id: this is a metering LEDGER that must
-- OUTLIVE the job (and project) it accounts for — an ON DELETE cascade would erase the very
-- rows T5's rollup needs. Retention is T5's rollup concern (consume + compact), mirroring
-- storage_meter's audit-log lifecycle rather than a child table.
--
-- SQLite port notes (DEC-8 type map): UUID -> BLOB, DOUBLE PRECISION -> REAL,
-- BIGINT -> INTEGER, TIMESTAMPTZ -> TEXT RFC3339 UTC
-- (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), no `public.` prefix, no `::`
-- casts, no `USING btree`. The `PRIMARY KEY` stays inline (the Postgres file
-- declares it on the column; SQLite accepts the same spelling).
CREATE TABLE compute_meter (
    -- the finished run's id; the exactly-once natural key (INV-5).
    job_id         BLOB        NOT NULL PRIMARY KEY,
    -- nullable: a dataset-scoped or scope-less run has no owning project. T5 maps this
    -- (not the account) so T3 carries no cross-epic accounts dependency (DEC-2).
    project_id     BLOB,
    -- cumulative CPU seconds the run's cgroup subtree consumed (cpu.stat usage_usec / 1e6).
    cpu_secs       REAL        NOT NULL DEFAULT 0,
    -- wall-clock run duration in seconds.
    wall_secs      REAL        NOT NULL DEFAULT 0,
    -- GPU seconds; 0 for a cpu-sandbox run (the only class the pool runs today).
    gpu_secs       REAL        NOT NULL DEFAULT 0,
    -- peak memory of the run's cgroup subtree (memory.peak), bytes; nullable when unread.
    ram_peak_bytes INTEGER,
    -- the run's terminal exit code (0 = success; a non-zero run still consumed compute).
    exit_code      INTEGER,
    recorded_at    TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Per-project time-ordered rollup index (the column T5's rollup filters on; §4 index-every-WHERE).
CREATE INDEX idx_compute_meter_project ON compute_meter (project_id, recorded_at DESC);
