-- Upload limit knobs on the workstore settings singleton (#185 §1).
--
-- Promotes the two compiled upload constants to admin settings rows, closing the
-- half of #182's option (c) that DEC-7 deferred:
--   dataset/routes.rs  UPLOAD_BODY_LIMIT  = 64 GiB  -> max_upload_body_bytes
--   file/stream.rs     MAX_UPLOAD_PARTS   = 1024    -> max_upload_parts
--
-- They live on `workstore_settings` rather than on a new `dataset_settings` table
-- (DEC-1): that row is already the deployment's "GC policy + ingest size caps"
-- singleton, already carries two bounds-validated byte ceilings of exactly this
-- shape (max_output_file_bytes, max_multifile_total_bytes), and already has the
-- `workstore::settings::{read,manage}` permission, the settings cache, the REST
-- GET/PUT, the sync emit and the admin card. A parallel dataset_settings copy
-- would be the second, divergent settings idiom the ruling forbids.
--
-- Defaults EQUAL the retired compiled constants, so a deployment that never PUTs
-- these knobs behaves byte-identically to before on the SaaS path, and the
-- migration is NOT cfg-gated: the columns exist in every build, and only the CODE
-- that reads the body ceiling is `#[cfg(feature = "saas")]` (DEC-5). That mirrors
-- 202608290090_infra_config.sql, whose row likewise exists in both builds.
--
-- Bounds mirror `WorkstoreSettings::validate()` exactly (DEC-4 of #54: a SAFETY
-- ceiling is bounded and NEVER admin-raisable unbounded):
--   max_upload_body_bytes  1 MiB .. 256 GiB   (64 GiB default = 68719476736)
--   max_upload_parts       1     .. 65536     (1024 default)

ALTER TABLE public.workstore_settings
    ADD COLUMN IF NOT EXISTS max_upload_body_bytes bigint NOT NULL DEFAULT 68719476736,
    ADD COLUMN IF NOT EXISTS max_upload_parts      bigint NOT NULL DEFAULT 1024;

-- The upload body ceiling is a SaaS capacity knob, not a security boundary: the
-- floor keeps a degenerate 0 from refusing every upload, and the ceiling keeps an
-- admin from making it effectively unbounded. Same envelope as
-- max_multifile_total_bytes (1 MiB .. 256 GiB).
-- DROP-then-ADD rather than a bare ADD: Postgres has no `ADD CONSTRAINT IF NOT
-- EXISTS`, so a bare ADD makes this file fail on a re-apply while the column adds
-- above succeed -- a half-idempotent migration. This is the repo idiom for exactly
-- that (202608290010_sandbox_per_class_defaults.sql), and it is what the sibling
-- sandbox migration in this same change already does.
ALTER TABLE public.workstore_settings
    DROP CONSTRAINT IF EXISTS workstore_settings_max_upload_body_bounds,
    ADD CONSTRAINT workstore_settings_max_upload_body_bounds
    CHECK (max_upload_body_bytes BETWEEN 1048576 AND 274877906944);

-- The part cap bounds resident per-part state + temp inodes, NOT file size, so the
-- owner's file-size ruling does not touch its value (DEC-5). 65536 parts is ~13 MiB
-- of part state at the observed ~200 bytes/part -- generous, still bounded.
ALTER TABLE public.workstore_settings
    DROP CONSTRAINT IF EXISTS workstore_settings_max_upload_parts_bounds,
    ADD CONSTRAINT workstore_settings_max_upload_parts_bounds
    CHECK (max_upload_parts BETWEEN 1 AND 65536);
