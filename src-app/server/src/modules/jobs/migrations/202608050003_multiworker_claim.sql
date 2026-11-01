-- T4 (epic compute-storage): multi-worker-safe claim — design §6 schema deltas
-- + the per-tenant concurrency cap the fold-into-the-claim needs (ITEM-1) —
-- SQLite dialect port (ITEM-8) of
-- `src/modules/jobs/migrations/202608050003_multiworker_claim.sql`.
--
-- Additive + defaulted, so every existing `jobs` row stays valid and the
-- single-box `serve`/desktop path is unregressed (DE-INV-1):
--   * `claimed_by`      — the worker id that holds a `running` row (DEC-4).
--   * `claim_heartbeat`  — apalis-shaped liveness the stale-claim reaper reads (INV-3).
--   * `reclaim_count`    — poison-job / reap-loop guard, discard-at-max (DEC-9).
-- Two PARTIAL indexes make the per-owner running `count(*)` in the claim and the
-- reaper's stale scan cheap.
--
-- Postgres-only rationale, not ported: the design specified `CREATE INDEX
-- CONCURRENTLY`, which cannot run inside the migration transaction; the
-- fallback plain `CREATE INDEX` is what ships. SQLite indexes are always
-- non-concurrent (they are B-trees in the same file) — nothing to translate.
--
-- SQLite port notes (DEC-8 type map): `timestamp with time zone` -> TEXT
-- RFC3339 UTC, `text` -> TEXT, `integer` -> INTEGER, `boolean`/`true` ->
-- INTEGER 0/1, no `public.` prefix, no `::` casts. The partial index
-- predicates drop the `::text` cast, and — the one deliberate construct
-- change — SQLite has no `ALTER TABLE … ADD CONSTRAINT`, so the
-- `job_settings_per_tenant_check` CHECK is declared INLINE on the ADD COLUMN
-- (enforced exactly like the Postgres CHECK for this single-column
-- predicate; the constraint name is recorded here because the inline form
-- has no SQL-level name).
ALTER TABLE jobs ADD COLUMN claimed_by text;

ALTER TABLE jobs ADD COLUMN claim_heartbeat TEXT;

ALTER TABLE jobs ADD COLUMN reclaim_count INTEGER NOT NULL DEFAULT 0;

-- Per-tenant running `count(*)` in the cap-folded claim → an index-only scan (§6).
CREATE INDEX idx_jobs_status_owner ON jobs (owner_id) WHERE status = 'running';
-- The reaper's stale-heartbeat scan.
CREATE INDEX idx_jobs_running_heartbeat ON jobs (claim_heartbeat) WHERE status = 'running';

-- The §6 `$per_tenant_cap`: a new column on the EXISTING singleton `job_settings`
-- row, reusing its admin GET/PUT surface (no new permission — DEC-1/DEC-3).
-- Constraint name from the Postgres chain: `job_settings_per_tenant_check`.
ALTER TABLE job_settings
    ADD COLUMN per_tenant_max_concurrent INTEGER NOT NULL DEFAULT 2
        CHECK (per_tenant_max_concurrent BETWEEN 1 AND 64);
