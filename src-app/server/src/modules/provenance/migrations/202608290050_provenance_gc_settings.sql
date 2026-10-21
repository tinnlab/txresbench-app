-- #54 (per-module admin-settings coverage) — promote the provenance ROOTFS-CACHE GC knobs
-- onto the existing `provenance_settings` singleton so an admin can VIEW + CHANGE them
-- without a code release. Flagged by #41's audit: these were hardcoded and NOT editable.
--   rootfs_gc_interval_secs  ← rootfs_gc.rs GC_INTERVAL_SECS (6h = 21600s) — sweep cadence
--   rootfs_cache_max_digests ← rootfs/cache.rs MAX_CACHED_DIGESTS_DEFAULT (4 dirs) —
--                              the rootfs image-cache retention cap (count of digest dirs kept)
-- Plus `updated_by` — the audit column stamped from the acting admin on every PUT (the
-- established `*_by` idiom; #41 INV-4, e.g. billing_settings.updated_by).
--
-- Defaults EXACTLY equal the compiled constants so a deployment that never PUTs is
-- byte-identical to today (read-at-use falls back to the same numbers on any DB error).
-- Bounds are enforced twice — a DB CHECK here AND the Rust validate() (a typed 422 before
-- the write) — mirroring the existing provenance_settings_*_check idiom.
--
-- Audit-integrity: the GC evicts only the local, RE-OBTAINABLE rootfs image cache; it never
-- deletes provenance records (provenance_run_repro / runs / blobs / verifications), and the
-- live/mounted/last-resolved digest is `protected` and exempt from the cap. So even the floor
-- values below cannot harm the audit trail. The interval floor (60s) stops a runaway sweep;
-- the digest floor (1) keeps the mechanism sane.
--
-- NON-saas (provenance is desktop-present): a plain .sql applied in BOTH builds.

ALTER TABLE public.provenance_settings
    ADD COLUMN IF NOT EXISTS rootfs_gc_interval_secs  bigint NOT NULL DEFAULT 21600,  -- 6 hours
    ADD COLUMN IF NOT EXISTS rootfs_cache_max_digests bigint NOT NULL DEFAULT 4,
    ADD COLUMN IF NOT EXISTS updated_by               uuid;

ALTER TABLE public.provenance_settings
    -- sweep cadence: 60s .. 7 days. Floor stops a runaway sweep hammering the DB+filesystem;
    -- ceiling bounds cache growth between sweeps.
    DROP CONSTRAINT IF EXISTS provenance_settings_rootfs_gc_interval_secs_check,
    ADD  CONSTRAINT provenance_settings_rootfs_gc_interval_secs_check
         CHECK (rootfs_gc_interval_secs BETWEEN 60 AND 604800),
    -- retention cap: 1 .. 1000 digest dirs. Floor of 1 keeps the mechanism sane (the live
    -- digest is protected and exempt regardless).
    DROP CONSTRAINT IF EXISTS provenance_settings_rootfs_cache_max_digests_check,
    ADD  CONSTRAINT provenance_settings_rootfs_cache_max_digests_check
         CHECK (rootfs_cache_max_digests BETWEEN 1 AND 1000);
