-- #54 (per-module admin-settings coverage) — promote the sandbox per-class resource
-- DEFAULTS and the deployment default env-id onto the existing `sandbox_settings`
-- singleton so an admin can VIEW + CHANGE them without a code release. These were
-- hardcoded:
--   {interactive,normal,batch}_{cpu_cores,mem_bytes} ← settings.rs class_defaults()
--       Interactive (2 cpu / 4 GiB), Normal (2 cpu / 4 GiB), Batch (4 cpu / 8 GiB)
--   default_env_id                                    ← env_image.rs default_env_id()
--       (deployment-wide default env; NULL = auto-detect from installed processors)
-- Plus `updated_by` — the audit column stamped from the acting admin on every PUT
-- (the established `*_by` idiom; #41 INV-4, e.g. billing_settings.updated_by).
--
-- Defaults EXACTLY equal the compiled constants so a deployment that never PUTs is
-- byte-identical to today (read-at-use falls back to the same numbers on any DB error).
-- Bounds are enforced twice — a DB CHECK here AND the Rust validate() (a typed 422
-- before the write) — mirroring the existing sandbox_settings_*_check idiom.
--
-- Per-class defaults are a per-job REQUEST that resolve_caps() clamps DOWN to the
-- box-wide ceiling (memory_max_bytes / cpu_max / timeout_secs already on this row), so
-- an admin can only lower what a class asks for by default, never exceed the ceiling.
-- The registry BASE + cosign identity are deliberately NOT here: they are a release-time
-- security boundary (env_image.rs), surfaced read-only, never operator-writable.
--
-- NON-saas (the sandbox is desktop-present): a plain .sql applied in BOTH builds.

ALTER TABLE public.sandbox_settings
    ADD COLUMN IF NOT EXISTS interactive_cpu_cores bigint NOT NULL DEFAULT 2,
    ADD COLUMN IF NOT EXISTS interactive_mem_bytes bigint NOT NULL DEFAULT 4294967296,   -- 4 GiB
    ADD COLUMN IF NOT EXISTS normal_cpu_cores      bigint NOT NULL DEFAULT 2,
    ADD COLUMN IF NOT EXISTS normal_mem_bytes      bigint NOT NULL DEFAULT 4294967296,   -- 4 GiB
    ADD COLUMN IF NOT EXISTS batch_cpu_cores       bigint NOT NULL DEFAULT 4,
    ADD COLUMN IF NOT EXISTS batch_mem_bytes       bigint NOT NULL DEFAULT 8589934592,   -- 8 GiB
    ADD COLUMN IF NOT EXISTS default_env_id        text,
    ADD COLUMN IF NOT EXISTS updated_by            uuid;

ALTER TABLE public.sandbox_settings
    -- cpu cores per class: 1..=256 (starvation guard floors quota at 1% of a core, the
    -- ceiling's own cpu_max is the hard cap; this bounds the DEFAULT REQUEST).
    DROP CONSTRAINT IF EXISTS sandbox_settings_interactive_cpu_bounds,
    ADD  CONSTRAINT sandbox_settings_interactive_cpu_bounds
         CHECK (interactive_cpu_cores BETWEEN 1 AND 256),
    DROP CONSTRAINT IF EXISTS sandbox_settings_normal_cpu_bounds,
    ADD  CONSTRAINT sandbox_settings_normal_cpu_bounds
         CHECK (normal_cpu_cores BETWEEN 1 AND 256),
    DROP CONSTRAINT IF EXISTS sandbox_settings_batch_cpu_bounds,
    ADD  CONSTRAINT sandbox_settings_batch_cpu_bounds
         CHECK (batch_cpu_cores BETWEEN 1 AND 256),
    -- mem per class: 64 MiB..256 GiB (same envelope as memory_max_bytes).
    DROP CONSTRAINT IF EXISTS sandbox_settings_interactive_mem_bounds,
    ADD  CONSTRAINT sandbox_settings_interactive_mem_bounds
         CHECK (interactive_mem_bytes BETWEEN 67108864 AND 274877906944),
    DROP CONSTRAINT IF EXISTS sandbox_settings_normal_mem_bounds,
    ADD  CONSTRAINT sandbox_settings_normal_mem_bounds
         CHECK (normal_mem_bytes BETWEEN 67108864 AND 274877906944),
    DROP CONSTRAINT IF EXISTS sandbox_settings_batch_mem_bounds,
    ADD  CONSTRAINT sandbox_settings_batch_mem_bounds
         CHECK (batch_mem_bytes BETWEEN 67108864 AND 274877906944),
    -- default_env_id: guarded twice like the numeric columns (Rust validate() + here).
    -- NULL = auto-detect (allowed); a non-null value must be a valid OCI path component
    -- (lowercase alphanumerics + . _ -), 1..255 chars — the grammar `is_valid_env_id`
    -- enforces, so a malformed id can never be persisted even by a caller that skips the
    -- route's validate(). Empty is never stored (the update normalizes "" → NULL).
    DROP CONSTRAINT IF EXISTS sandbox_settings_default_env_id_grammar,
    ADD  CONSTRAINT sandbox_settings_default_env_id_grammar
         CHECK (default_env_id IS NULL OR default_env_id ~ '^[a-z0-9._-]{1,255}$');
