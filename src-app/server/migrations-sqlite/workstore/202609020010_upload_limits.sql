-- Upload limit knobs on the workstore settings singleton (#185 §1) —
-- SQLite dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202609020010_upload_limits.sql`.
--
-- Promotes the two compiled upload constants to admin settings rows,
-- closing the half of #182's option (c) that DEC-7 deferred:
--   dataset/routes.rs  UPLOAD_BODY_LIMIT  = 64 GiB  -> max_upload_body_bytes
--   file/stream.rs     MAX_UPLOAD_PARTS   = 1024    -> max_upload_parts
--
-- They live on `workstore_settings` (already the "GC policy + ingest size
-- caps" singleton, already the settings cache / REST GET-PUT / sync emit /
-- admin card host — DEC-1; a parallel dataset_settings copy would be the
-- second, divergent settings idiom). Defaults EQUAL the retired compiled
-- constants (byte-identical for a deployment that never PUTs them);
-- migration NOT cfg-gated (only the code reading the body ceiling is
-- `#[cfg(feature = "saas")]`, DEC-5). Bounds mirror
-- `WorkstoreSettings::validate()` exactly (a SAFETY ceiling is bounded and
-- NEVER admin-raisable unbounded):
--   max_upload_body_bytes  1 MiB .. 256 GiB   (64 GiB default = 68719476736)
--   max_upload_parts       1     .. 65536     (1024 default)
--
-- SQLite port notes (ITEM-9, DEC-8 type map): `bigint` -> INTEGER, no
-- `public.` prefix. Construct deltas:
--   * the `ADD COLUMN IF NOT EXISTS … , ADD COLUMN IF NOT EXISTS …` batch
--     is TWO plain ADD COLUMNs (SQLite's ALTER takes one column; partial
--     re-runs cannot exist — the ITEM-8 convention);
--   * the Postgres file's `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`
--     re-add idiom (PG has no `ADD CONSTRAINT IF NOT EXISTS`) is dropped:
--     the bounds are SINGLE-column predicates, so each is declared INLINE
--     on its ADD COLUMN (the ITEM-8 idiom), enforced identically. The
--     Postgres constraint names are recorded in the comments below;
--     SQLite's column-level form is anonymous.
-- The body ceiling is a SaaS capacity knob, not a security boundary: the
-- floor keeps a degenerate 0 from refusing every upload, the ceiling keeps
-- an admin from making it unbounded (same envelope as
-- max_multifile_total_bytes). The part cap bounds resident per-part state +
-- temp inodes, NOT file size (DEC-5).

ALTER TABLE workstore_settings
    ADD COLUMN max_upload_body_bytes INTEGER NOT NULL DEFAULT 68719476736
        CHECK (max_upload_body_bytes BETWEEN 1048576 AND 274877906944);
        -- Postgres constraint name: workstore_settings_max_upload_body_bounds

ALTER TABLE workstore_settings
    ADD COLUMN max_upload_parts INTEGER NOT NULL DEFAULT 1024
        CHECK (max_upload_parts BETWEEN 1 AND 65536);
        -- Postgres constraint name: workstore_settings_max_upload_parts_bounds
