-- #56 (a #54 follow-up slice), jobs module — promote the hardcoded SCHEDULER timing
-- tunables onto the existing `job_settings` singleton so an admin can VIEW + CHANGE them
-- without a code release — SQLite dialect port (ITEM-8) of
-- `src/modules/jobs/migrations/202608290070_jobs_scheduler_reaper_knobs.sql`.
--
-- These were the `ReaperLimits` struct fields + two inline tick literals in
-- scheduler.rs, with no admin surface:
--   heartbeat_secs        ← scheduler.rs ReaperLimits.heartbeat        (10s worker HB cadence)
--   reaper_tick_secs      ← scheduler.rs ReaperLimits.reaper_tick      (15s reaper sweep cadence)
--   stale_threshold_secs  ← scheduler.rs ReaperLimits.stale_threshold  (45s reclaim threshold)
--   max_reclaims          ← scheduler.rs ReaperLimits.max_reclaims     (5; poison-job discard)
--   reclaim_batch         ← scheduler.rs ReaperLimits.reclaim_batch    (100; bounded sweep batch)
--   dispatch_tick_ms      ← scheduler.rs interval(from_millis(500))    (500ms dispatch cadence)
--   metric_tick_secs      ← scheduler.rs interval(from_secs(1))        (1s CPU/RSS sampling)
--
-- Defaults EXACTLY equal the compiled constants so a deployment that never PUTs is
-- byte-identical to today (read-at-use falls back to the same numbers on any DB error, INV-5).
-- Bounds are enforced twice — a DB CHECK here AND the Rust `validate_scheduler_limits` (a typed
-- 422 before the write) — mirroring the #54 `job_settings_*_bounds` idiom. The bounds are
-- guardrails: an admin must not be able to make the dispatch loop busy-spin the DB
-- (dispatch_tick floor), run an unbounded reclaim UPDATE (reclaim_batch ceiling), or — the one
-- CORRECTNESS hazard — set the stale threshold low enough to RECLAIM A STILL-LIVE WORKER'S JOBS.
-- That last is bounded by the cross-field CHECK `stale_threshold_secs >= 3 * heartbeat_secs`
-- (a still-live worker heartbeats every heartbeat_secs, so ≥3 missed beats cannot elapse while
-- it is alive) — see DECISIONS.md DEC-3 / INV-4.
--
-- SQLite port notes (ITEM-8, DEC-8 type map): `bigint`/`integer` -> INTEGER,
-- no `public.` prefix. Construct deltas (same rationale as the sibling
-- 202608290030 port): seven plain ADD COLUMNs; the `DROP CONSTRAINT IF
-- EXISTS` re-ADD idiom dropped (nothing to replace on SQLite); single-column
-- bounds INLINE on their ADD COLUMN (Postgres constraint names recorded in
-- the comments); the ONE cross-field predicate
-- (`stale_threshold_secs >= 3 * heartbeat_secs`) enforced as a row-level
-- trigger pair raising with the Postgres constraint name.
ALTER TABLE job_settings
    ADD COLUMN heartbeat_secs INTEGER NOT NULL DEFAULT 10
        CHECK (heartbeat_secs BETWEEN 1 AND 60);
ALTER TABLE job_settings
    ADD COLUMN reaper_tick_secs INTEGER NOT NULL DEFAULT 15
        CHECK (reaper_tick_secs BETWEEN 1 AND 300);
ALTER TABLE job_settings
    ADD COLUMN stale_threshold_secs INTEGER NOT NULL DEFAULT 45;
ALTER TABLE job_settings
    ADD COLUMN max_reclaims INTEGER NOT NULL DEFAULT 5
        CHECK (max_reclaims BETWEEN 1 AND 100);
ALTER TABLE job_settings
    ADD COLUMN reclaim_batch INTEGER NOT NULL DEFAULT 100
        CHECK (reclaim_batch BETWEEN 1 AND 10000);
ALTER TABLE job_settings
    ADD COLUMN dispatch_tick_ms INTEGER NOT NULL DEFAULT 500
        CHECK (dispatch_tick_ms BETWEEN 50 AND 60000);
ALTER TABLE job_settings
    ADD COLUMN metric_tick_secs INTEGER NOT NULL DEFAULT 1
        CHECK (metric_tick_secs BETWEEN 1 AND 60);

-- Postgres constraint name: `job_settings_stale_threshold_bounds`.
-- The cross-field correctness guardrail: a still-live worker heartbeats every
-- `heartbeat_secs`, so a stale threshold below 3× that can reclaim its live
-- rows. The `3` multiple MUST stay in sync with
-- `settings::STALE_HEARTBEAT_MULTIPLE` (the Rust validator + read-path clamp
-- use that const; these triggers are the DB twin of it). Row-level (checks
-- every INSERT and any UPDATE, so a heartbeating change cannot invalidate
-- the relationship).
CREATE TRIGGER job_settings_stale_threshold_bounds_insert
BEFORE INSERT ON job_settings
WHEN NOT (NEW.stale_threshold_secs BETWEEN 5 AND 3600
          AND NEW.stale_threshold_secs >= 3 * NEW.heartbeat_secs)
BEGIN
    SELECT RAISE(ABORT, 'CHECK constraint failed: job_settings_stale_threshold_bounds');
END;

CREATE TRIGGER job_settings_stale_threshold_bounds_update
BEFORE UPDATE ON job_settings
WHEN NOT (NEW.stale_threshold_secs BETWEEN 5 AND 3600
          AND NEW.stale_threshold_secs >= 3 * NEW.heartbeat_secs)
BEGIN
    SELECT RAISE(ABORT, 'CHECK constraint failed: job_settings_stale_threshold_bounds');
END;
