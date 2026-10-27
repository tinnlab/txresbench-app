-- account module — A2 index the new `account_id` FK columns — SQLite
-- dialect port (ITEM-10, sqlite-store) of
-- `src/modules/account/migrations/202608040014_account_id_indexes.sql`.
--
-- Composite `(account_id, created_at DESC)` indexes on the ownership key
-- every downstream concern scopes/lists on (coding-guideline §4; the tenant
-- analog of the existing `idx_projects_owner_created` /
-- `idx_datasets_owner`). PROV-A2-3 requires these to exist.
--
-- SQLite port note (ITEM-10): the Postgres file records DEC-5's
-- CREATE-INDEX-CONCURRENTLY fallback — a plain in-transaction `CREATE
-- INDEX`, because the MERGED_MIGRATOR wraps every migration in one
-- transaction and CONCURRENTLY cannot run there. SQLite has no
-- CONCURRENTLY at all (it never needed it), so the port is exactly the
-- in-transaction form the Postgres file landed on; `USING btree` dropped
-- (SQLite indexes are B-trees), `DESC` kept verbatim (the ITEM-8/9
-- convention).

CREATE INDEX idx_projects_account_created ON projects (account_id, created_at DESC);
CREATE INDEX idx_datasets_account_created ON datasets (account_id, created_at DESC);
