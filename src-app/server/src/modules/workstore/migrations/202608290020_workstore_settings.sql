-- Workstore admin settings singleton (issue #54): GC policy + ingest size caps.
--
-- Mirrors `sandbox_settings` / `billing_settings`: ONE row, `id boolean` PK with a
-- CHECK(id = true) so a second row is impossible, per-column bounds CHECKs (the
-- safety bound — DEC-3: an ingest OOM ceiling / GC orphan-grace floor is NEVER
-- admin-raisable unbounded), and an `updated_by` audit column.
--
-- Defaults EQUAL the compiled constants (INV-1: a deployment that never PUTs the
-- settings behaves byte-identically to today):
--   gc_enabled                = true               (WorkstoreLimits::default)
--   gc_interval_hours         = 6                   (WorkstoreLimits::default)
--   gc_grace_secs             = 3600                (gc.rs FULL_SWEEP_GRACE_SECS)
--   max_output_file_bytes     = 8 GiB  = 8589934592 (ingest.rs MAX_OUTPUT_FILE_BYTES)
--   max_multifile_total_bytes = 32 GiB = 34359738368 (ingest.rs MAX_MULTIFILE_TOTAL_BYTES)
CREATE TABLE IF NOT EXISTS public.workstore_settings (
    id                        boolean     PRIMARY KEY DEFAULT true,
    gc_enabled                boolean     NOT NULL DEFAULT true,
    gc_interval_hours         bigint      NOT NULL DEFAULT 6,
    gc_grace_secs             bigint      NOT NULL DEFAULT 3600,
    max_output_file_bytes     bigint      NOT NULL DEFAULT 8589934592,
    max_multifile_total_bytes bigint      NOT NULL DEFAULT 34359738368,
    updated_at                timestamptz NOT NULL DEFAULT now(),
    updated_by                uuid,
    CONSTRAINT workstore_settings_singleton_check   CHECK (id = true),
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

INSERT INTO public.workstore_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
