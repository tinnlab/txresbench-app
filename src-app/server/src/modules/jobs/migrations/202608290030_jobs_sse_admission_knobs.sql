-- #54 (per-module admin-settings coverage), jobs module — promote the hardcoded SSE +
-- admission-control operational knobs onto the existing `job_settings` singleton so an
-- admin can VIEW + CHANGE them without a code release — SQLite dialect port (ITEM-8) of
-- `src/modules/jobs/migrations/202608290030_jobs_sse_admission_knobs.sql`.
--
-- These were bare `const`s / an implicit axum default with no admin surface:
--   sse_keep_alive_secs  ← routes.rs   KeepAlive::default()  (axum implicit 15s heartbeat)
--   sse_max_clients      ← runtime.rs  MAX_SSE_CLIENTS       (256; per-job SSE OOM guard)
--   admission_wait_secs  ← admission.rs ADMISSION_WAIT        (15s detached-admit budget)
--   admission_poll_ms    ← admission.rs ADMISSION_POLL        (250ms admit poll interval)
-- Plus `updated_by` — the audit column stamped from the acting admin on every PUT (mirrors
-- #41 billing INV-4; the established `*_by` audit idiom).
--
-- Defaults EXACTLY equal the compiled constants so a deployment that never PUTs is
-- byte-identical to today (read-at-use falls back to the same numbers on any DB error).
-- Bounds are enforced twice — a DB CHECK here AND the Rust `validate_*` (a typed 422 before
-- the write) — mirroring the existing `job_settings_*_check` + `billing_settings_*_bounds`
-- idioms. The bounds are guardrails: an admin must not be able to set a HANG
-- (admission_wait) or an OOM (sse_max_clients) — see DECISIONS.md DEC-3.
--
-- jobs is a NON-saas module compiled in both profiles; a migration cannot be cfg-gated, so
-- this plain .sql applies in both builds (as 202608280020 does for billing).
--
-- SQLite port notes (DEC-8 type map): `bigint`/`integer` -> INTEGER, `uuid`
-- -> BLOB, no `public.` prefix, no `::` casts. Construct deltas:
--   * the `ADD COLUMN IF NOT EXISTS` batch becomes five plain ADD COLUMNs
--     (the table is unchanged here; a re-run retries the whole file and
--     errors on the duplicate column — the same fail-loud contract the
--     Postgres `IF NOT EXISTS` softens only for partial re-runs, which the
--     transaction runner never leaves half-applied);
--   * the Postgres `DROP CONSTRAINT IF EXISTS` re-ADD idiom is dropped —
--     SQLite has no prior constraint to replace, and no `ALTER TABLE … ADD
--     CONSTRAINT`;
--   * every single-column bound is declared INLINE on its ADD COLUMN
--     (enforced identically for this predicate; SQLite's anonymous inline
--     CHECK has no name — the Postgres constraint names are recorded in the
--     comments below);
--   * the `admission_poll_ms` bound is a CROSS-column predicate
--     (`poll_ms < wait_secs * 1000`), which SQLite can only enforce as a
--     row-level trigger pair (a column-level CHECK would skip the check when
--     only `admission_wait_secs` is written). The triggers raise
--     `RAISE(ABORT, …)` with the Postgres constraint name.
ALTER TABLE job_settings
    ADD COLUMN sse_keep_alive_secs INTEGER NOT NULL DEFAULT 15
        CHECK (sse_keep_alive_secs BETWEEN 1 AND 300);
ALTER TABLE job_settings
    ADD COLUMN sse_max_clients INTEGER NOT NULL DEFAULT 256
        CHECK (sse_max_clients BETWEEN 1 AND 4096);
ALTER TABLE job_settings
    ADD COLUMN admission_wait_secs INTEGER NOT NULL DEFAULT 15
        CHECK (admission_wait_secs BETWEEN 1 AND 60);
ALTER TABLE job_settings
    ADD COLUMN admission_poll_ms INTEGER NOT NULL DEFAULT 250;
ALTER TABLE job_settings
    ADD COLUMN updated_by BLOB;

-- Postgres constraint name: `job_settings_admission_poll_bounds`.
-- Row-level twin of the poll-bound CHECK above: verified on every row write
-- (INSERT and any UPDATE), so shortening `admission_wait_secs` cannot leave a
-- poll interval that no longer fits the budget.
CREATE TRIGGER job_settings_admission_poll_bounds_insert
BEFORE INSERT ON job_settings
WHEN NOT (NEW.admission_poll_ms BETWEEN 10 AND 10000
          AND NEW.admission_poll_ms < NEW.admission_wait_secs * 1000)
BEGIN
    SELECT RAISE(ABORT, 'CHECK constraint failed: job_settings_admission_poll_bounds');
END;

CREATE TRIGGER job_settings_admission_poll_bounds_update
BEFORE UPDATE ON job_settings
WHEN NOT (NEW.admission_poll_ms BETWEEN 10 AND 10000
          AND NEW.admission_poll_ms < NEW.admission_wait_secs * 1000)
BEGIN
    SELECT RAISE(ABORT, 'CHECK constraint failed: job_settings_admission_poll_bounds');
END;
