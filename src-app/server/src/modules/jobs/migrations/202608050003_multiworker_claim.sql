-- T4 (epic compute-storage): multi-worker-safe claim — design §6 schema deltas
-- + the per-tenant concurrency cap the fold-into-the-claim needs (ITEM-1).
--
-- Additive + defaulted, so every existing `jobs` row stays valid and the
-- single-box `serve`/desktop path is unregressed (DE-INV-1):
--   * `claimed_by`      — the worker id that holds a `running` row (DEC-4).
--   * `claim_heartbeat`  — apalis-shaped liveness the stale-claim reaper reads (INV-3).
--   * `reclaim_count`    — poison-job / reap-loop guard, discard-at-max (DEC-9).
-- Two PARTIAL indexes make the per-owner running `count(*)` in the claim and the
-- reaper's stale scan cheap.
--
-- DEC-7: the design specifies `CREATE INDEX CONCURRENTLY`, but this repo's
-- migration runner (`sqlx::migrate!`) sends each migration file as ONE
-- simple-query string, which Postgres wraps in an implicit transaction — and
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. The plan's
-- sanctioned fallback is a plain `CREATE INDEX`, taking a brief `ACCESS
-- EXCLUSIVE` lock; the `jobs` table on every environment this runner targets
-- (embedded dev PG, the per-worktree build DB, the test template, the kind
-- cloud-sim) is small, so the lock is negligible. Promotable to CONCURRENTLY if
-- the runner ever grows a per-statement / no-transaction path.

ALTER TABLE public.jobs ADD COLUMN claimed_by text;
ALTER TABLE public.jobs ADD COLUMN claim_heartbeat timestamp with time zone;
ALTER TABLE public.jobs ADD COLUMN reclaim_count integer DEFAULT 0 NOT NULL;

-- Per-tenant running `count(*)` in the cap-folded claim → an index-only scan (§6).
CREATE INDEX idx_jobs_status_owner ON public.jobs USING btree (owner_id) WHERE (status = 'running'::text);
-- The reaper's stale-heartbeat scan.
CREATE INDEX idx_jobs_running_heartbeat ON public.jobs USING btree (claim_heartbeat) WHERE (status = 'running'::text);

-- The §6 `$per_tenant_cap`: a new column on the EXISTING singleton `job_settings`
-- row, reusing its admin GET/PUT surface (no new permission — DEC-1/DEC-3).
ALTER TABLE public.job_settings
    ADD COLUMN per_tenant_max_concurrent integer DEFAULT 2 NOT NULL;
ALTER TABLE public.job_settings
    ADD CONSTRAINT job_settings_per_tenant_check
    CHECK (((per_tenant_max_concurrent >= 1) AND (per_tenant_max_concurrent <= 64)));
