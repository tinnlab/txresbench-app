-- 202608040009 — a virtual dataset owns EXACTLY ONE mask, and it is hidden —
-- SQLite dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608040009_artifact_mask_role.sql`.
--
-- What a mask is, and why the UNIQUE index (not a SELECT-then-INSERT) is
-- the exactly-one guard: see the Postgres file — the finalize sink inserts
-- optimistically and treats a unique violation as "already created"
-- (TOCTOU-safe), and the index is PARTIAL on `role = 'mask'` so the many
-- `role='artifact'` gathered columns of the same dataset are untouched
-- (the mirror of `datasets_one_per_alignment_run`).
--
-- SQLite port note (ITEM-9): direct port — partial unique indexes are
-- supported natively; `role = 'mask'` needs no rewrite and the index name
-- is kept verbatim. The `COMMENT ON INDEX` becomes the comment below.

CREATE UNIQUE INDEX artifacts_one_mask_per_dataset
    ON artifacts (dataset_id)
    WHERE role = 'mask';

-- Exactly ONE mask per virtual dataset (ITEM-1 / DEC-3). Partial on
-- role='mask' so only masks are constrained; the many role='artifact'
-- gathered columns of the same dataset are untouched. The finalize sink
-- inserts a mask optimistically and treats a violation here as "already
-- created", the same idempotency shape as datasets_one_per_alignment_run.
