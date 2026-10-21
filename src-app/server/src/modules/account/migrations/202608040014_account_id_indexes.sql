-- account module — A2 index the new `account_id` FK columns.
--
-- Composite `(account_id, created_at DESC)` indexes on the ownership key every
-- downstream concern scopes/lists on (coding-guideline §4; the tenant analog of
-- the existing `idx_projects_owner_created` / `idx_datasets_owner`). PROV-A2-3
-- requires these to exist.
--
-- DEC-5: the design + guideline reach for `CREATE INDEX CONCURRENTLY` in a
-- SEPARATE post-deploy migration to avoid the write-lock a plain build takes.
-- CONCURRENTLY cannot run inside a transaction block, and this repo's
-- `MERGED_MIGRATOR` (`sqlx::migrate!`) wraps every migration in one with no
-- verified `-- no-transaction` escape — a CONCURRENTLY statement here would abort
-- the migration ("CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block"). So we take DEC-5's recorded FALLBACK: a plain, in-transaction
-- `CREATE INDEX`. At CytoAnalyst's scale (a handful of users) the brief
-- build-time lock is negligible; CONCURRENTLY is the scale-up path to switch to
-- if a target table ever grows large. Kept as its own migration file (not folded
-- into 013) so the swap to CONCURRENTLY later is a localized change.

CREATE INDEX idx_projects_account_created ON public.projects USING btree (account_id, created_at DESC);
CREATE INDEX idx_datasets_account_created ON public.datasets USING btree (account_id, created_at DESC);
