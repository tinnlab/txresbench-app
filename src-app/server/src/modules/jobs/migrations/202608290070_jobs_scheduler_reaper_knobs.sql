-- #56 (a #54 follow-up slice), jobs module — promote the hardcoded SCHEDULER timing
-- tunables onto the existing `job_settings` singleton so an admin can VIEW + CHANGE them
-- without a code release. These were the `ReaperLimits` struct fields + two inline tick
-- literals in scheduler.rs, with no admin surface:
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
-- jobs is a NON-saas module compiled in both profiles; a migration cannot be cfg-gated, so this
-- plain .sql applies in both builds (as 202608290030 does).

ALTER TABLE public.job_settings
    ADD COLUMN IF NOT EXISTS heartbeat_secs       bigint  NOT NULL DEFAULT 10,
    ADD COLUMN IF NOT EXISTS reaper_tick_secs     bigint  NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS stale_threshold_secs bigint  NOT NULL DEFAULT 45,
    ADD COLUMN IF NOT EXISTS max_reclaims         integer NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS reclaim_batch        bigint  NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS dispatch_tick_ms     bigint  NOT NULL DEFAULT 500,
    ADD COLUMN IF NOT EXISTS metric_tick_secs     bigint  NOT NULL DEFAULT 1;

ALTER TABLE public.job_settings
    -- Worker heartbeat cadence: 1..=60 s.
    DROP CONSTRAINT IF EXISTS job_settings_heartbeat_bounds,
    ADD  CONSTRAINT job_settings_heartbeat_bounds
         CHECK (heartbeat_secs BETWEEN 1 AND 60),
    -- Reaper sweep cadence: 1..=300 s (kept responsive).
    DROP CONSTRAINT IF EXISTS job_settings_reaper_tick_bounds,
    ADD  CONSTRAINT job_settings_reaper_tick_bounds
         CHECK (reaper_tick_secs BETWEEN 1 AND 300),
    -- Stale-reclaim threshold: 5..=3600 s AND a generous multiple of the heartbeat, so the
    -- reaper never reclaims a still-live worker's rows (the one correctness guardrail, INV-4).
    -- The `3` multiple below MUST stay in sync with `settings::STALE_HEARTBEAT_MULTIPLE`
    -- (the Rust validator + read-path clamp use that const; this is the DB twin of it).
    DROP CONSTRAINT IF EXISTS job_settings_stale_threshold_bounds,
    ADD  CONSTRAINT job_settings_stale_threshold_bounds
         CHECK (stale_threshold_secs BETWEEN 5 AND 3600
                AND stale_threshold_secs >= 3 * heartbeat_secs),
    -- Poison-job discard-at-max: 1..=100 reclaims before a row is failed, not re-queued.
    DROP CONSTRAINT IF EXISTS job_settings_max_reclaims_bounds,
    ADD  CONSTRAINT job_settings_max_reclaims_bounds
         CHECK (max_reclaims BETWEEN 1 AND 100),
    -- Bounded reclaim/discard batch per sweep: 1..=10000 (never an unbounded UPDATE, §4).
    DROP CONSTRAINT IF EXISTS job_settings_reclaim_batch_bounds,
    ADD  CONSTRAINT job_settings_reclaim_batch_bounds
         CHECK (reclaim_batch BETWEEN 1 AND 10000),
    -- Dispatch (claim) loop cadence: 50..=60000 ms; the 50 ms floor stops a busy-spin on the DB.
    DROP CONSTRAINT IF EXISTS job_settings_dispatch_tick_bounds,
    ADD  CONSTRAINT job_settings_dispatch_tick_bounds
         CHECK (dispatch_tick_ms BETWEEN 50 AND 60000),
    -- CPU/RSS metric sampling cadence: 1..=60 s.
    DROP CONSTRAINT IF EXISTS job_settings_metric_tick_bounds,
    ADD  CONSTRAINT job_settings_metric_tick_bounds
         CHECK (metric_tick_secs BETWEEN 1 AND 60);
