-- compute_meter — append-only per-job compute-usage raw signal (epic compute-storage, T3 / PROV-T3-3 / G3).
--
-- T3 EMITS the raw teardown signal (a final cgroup read at the run's child-exit finalize);
-- the deferred T5 aggregates it into per-account cpu/gpu-seconds and maps project_id ->
-- account (§9 / DEC-7). Each row is ONE finished run's compute footprint:
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
-- Prefix 202608050002: above the current server max (202608050001 = T2 storage_meter) and
-- the MIDDLE of the three compute-epic migrations assigned bottom-up (T2 storage_meter <
-- T3 compute_meter < T4 multiworker_claim) — SEAMS build-time carry-forward / DEC-7.
CREATE TABLE compute_meter (
    -- the finished run's id; the exactly-once natural key (INV-5).
    job_id         UUID        NOT NULL PRIMARY KEY,
    -- nullable: a dataset-scoped or scope-less run has no owning project. T5 maps this
    -- (not the account) so T3 carries no cross-epic accounts dependency (DEC-2).
    project_id     UUID,
    -- cumulative CPU seconds the run's cgroup subtree consumed (cpu.stat usage_usec / 1e6).
    cpu_secs       DOUBLE PRECISION NOT NULL DEFAULT 0,
    -- wall-clock run duration in seconds.
    wall_secs      DOUBLE PRECISION NOT NULL DEFAULT 0,
    -- GPU seconds; 0 for a cpu-sandbox run (the only class the pool runs today).
    gpu_secs       DOUBLE PRECISION NOT NULL DEFAULT 0,
    -- peak memory of the run's cgroup subtree (memory.peak), bytes; nullable when unread.
    ram_peak_bytes BIGINT,
    -- the run's terminal exit code (0 = success; a non-zero run still consumed compute).
    exit_code      INTEGER,
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-project time-ordered rollup index (the column T5's rollup filters on; §4 index-every-WHERE).
CREATE INDEX idx_compute_meter_project ON compute_meter (project_id, recorded_at DESC);
