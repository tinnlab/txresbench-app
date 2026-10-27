-- #54 (per-module admin-settings coverage) — promote the provenance ROOTFS-CACHE GC knobs
-- onto the existing `provenance_settings` singleton so an admin can VIEW + CHANGE them
-- without a code release — SQLite dialect port (ITEM-11, sqlite-store) of
-- `src/modules/provenance/migrations/202608290050_provenance_gc_settings.sql`.
--
-- Flagged by #41's audit: these were hardcoded and NOT editable.
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
--
-- SQLite port notes (ITEM-11):
--   * SQLite cannot DROP/ALTER a constraint and adds ONE column per
--     `ALTER TABLE` — the port is three `ADD COLUMN` statements with the
--     bounds as INLINE single-column CHECKs (the ITEM-9 `202609020010`
--     convention; the fresh-file chain has an empty singleton at this
--     position, so the ADD-COLUMN CHECK validates nothing — the same
--     empty-table justification the account 013 port records). The
--     Postgres constraint names
--     `provenance_settings_rootfs_gc_interval_secs_check` /
--     `provenance_settings_rootfs_cache_max_digests_check` are recorded
--     here (SQLite generates its own names for a column CHECK).
--   * `ADD COLUMN IF NOT EXISTS` has no SQLite spelling — the columns
--     cannot exist before this file in a fresh-chain boot (each migration
--     file is applied once and recorded), so the defensive IF is dropped
--     (recorded).

ALTER TABLE provenance_settings
    ADD COLUMN rootfs_gc_interval_secs INTEGER NOT NULL DEFAULT 21600
        CHECK (rootfs_gc_interval_secs BETWEEN 60 AND 604800);

ALTER TABLE provenance_settings
    ADD COLUMN rootfs_cache_max_digests INTEGER NOT NULL DEFAULT 4
        CHECK (rootfs_cache_max_digests BETWEEN 1 AND 1000);

ALTER TABLE provenance_settings
    ADD COLUMN updated_by BLOB;
