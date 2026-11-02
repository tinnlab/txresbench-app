-- Workstore admin settings singleton (issue #54): GC policy + ingest size
-- caps — SQLite dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608290020_workstore_settings.sql`.
--
-- Mirrors `sandbox_settings` / `mcp_settings` / `billing_settings`: ONE row,
-- `id` PK with a CHECK so a second row is impossible, per-column bounds
-- CHECKs (the safety bound — DEC-3: an ingest OOM ceiling / GC orphan-grace
-- floor is NEVER admin-raisable unbounded), and an `updated_by` audit
-- column. Defaults EQUAL the compiled constants (INV-1: a deployment that
-- never PUTs the settings behaves byte-identically to today):
--   gc_enabled                = true               (WorkstoreLimits::default)
--   gc_interval_hours         = 6                   (WorkstoreLimits::default)
--   gc_grace_secs             = 3600                (gc.rs FULL_SWEEP_GRACE_SECS)
--   max_output_file_bytes     = 8 GiB  = 8589934592 (ingest.rs MAX_OUTPUT_FILE_BYTES)
--   max_multifile_total_bytes = 32 GiB = 34359738368 (ingest.rs MAX_MULTIFILE_TOTAL_BYTES)
--
-- SQLite port notes (ITEM-9, DEC-8 type map): `boolean` -> INTEGER 0/1
-- (the singleton `id` keeps `DEFAULT 1`; `gc_enabled` `DEFAULT 1`), `bigint`
-- -> INTEGER, `timestamptz DEFAULT now()` -> TEXT RFC3339 UTC
-- (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), `uuid` -> BLOB, no `public.`
-- prefix, no `::` casts. The Postgres table was created with all
-- constraints INLINE (a `CREATE TABLE IF NOT EXISTS` file), so the port is a
-- dialect change only — constraint names preserved verbatim (this file's
-- additions by `202609020010` are inline single-column CHECKs there).
CREATE TABLE workstore_settings (
    id                        INTEGER     PRIMARY KEY DEFAULT 1,
    gc_enabled                INTEGER     NOT NULL DEFAULT 1,
    gc_interval_hours         INTEGER     NOT NULL DEFAULT 6,
    gc_grace_secs             INTEGER     NOT NULL DEFAULT 3600,
    max_output_file_bytes     INTEGER     NOT NULL DEFAULT 8589934592,
    max_multifile_total_bytes INTEGER     NOT NULL DEFAULT 34359738368,
    updated_at                TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_by                BLOB,
    CONSTRAINT workstore_settings_singleton_check   CHECK (id = 1),
    -- GC cadence: 1h .. 30d (mirrors the existing env clamp 1..=24*30).
    CONSTRAINT workstore_settings_gc_interval_bounds CHECK (gc_interval_hours BETWEEN 1 AND 720),
    -- GC orphan-grace FLOOR (DEC-3): 5 min .. 7 days. The floor protects a
    -- live-but-uncommitted ingest write from being swept.
    CONSTRAINT workstore_settings_gc_grace_bounds     CHECK (gc_grace_secs BETWEEN 300 AND 604800),
    -- Ingest OOM CEILINGS (DEC-3): 1 MiB .. 64 GiB per file, 1 MiB .. 256 GiB total.
    CONSTRAINT workstore_settings_max_file_bounds     CHECK (max_output_file_bytes BETWEEN 1048576 AND 68719476736),
    CONSTRAINT workstore_settings_max_total_bounds    CHECK (max_multifile_total_bytes BETWEEN 1048576 AND 274877906944),
    -- A total smaller than a single-member cap is degenerate.
    CONSTRAINT workstore_settings_total_ge_file       CHECK (max_multifile_total_bytes >= max_output_file_bytes)
);

INSERT INTO workstore_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
