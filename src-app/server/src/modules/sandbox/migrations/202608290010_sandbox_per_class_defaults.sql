-- #54 (per-module admin-settings coverage) — promote the sandbox per-class resource
-- DEFAULTS and the deployment default env-id onto the existing `sandbox_settings`
-- singleton so an admin can VIEW + CHANGE them without a code release — SQLite
-- dialect port (ITEM-8) of
-- `src/modules/sandbox/migrations/202608290010_sandbox_per_class_defaults.sql`.
--
-- These were hardcoded:
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
--
-- SQLite port notes (ITEM-8, DEC-8 type map): `bigint` -> INTEGER, `text`
-- -> TEXT, `uuid` -> BLOB, no `public.` prefix. Construct deltas:
--   * seven plain ADD COLUMNs (the `ADD COLUMN IF NOT EXISTS` batch is
--     unnecessary — the transaction runner never leaves a half-applied
--     migration, and a re-run fails loudly on the duplicate column);
--   * the `DROP CONSTRAINT IF EXISTS` re-ADD idiom is dropped;
--   * the bounds CHECKs are declared INLINE on their ADD COLUMN, enforced
--     identically for these single-column predicates (the Postgres
--     constraint names are recorded in the comments — SQLite's inline form
--     is anonymous);
--   * the `default_env_id` grammar CHECK (`~ '^[a-z0-9._-]{1,255}$'`) has
--     NO SQLite equivalent: the bundled engine has no ICU and no regexp
--     function, so the port is `length() BETWEEN 1 AND 255` + a GLOB
--     character-class test (`[a-z0-9._-]` — ASCII only, exactly the same
--     set; `GLOB '*[^a-z0-9._-]*'` is false iff every character is in the
--     set). This is the DEC-11 "ASCII-only folding" convention in
--     constraint form. Note (202609020020): this file's checks are
--     re-declared INLINE and NAMED when 202609020020 rebuilds the table.
ALTER TABLE sandbox_settings
    ADD COLUMN interactive_cpu_cores INTEGER NOT NULL DEFAULT 2
        CHECK (interactive_cpu_cores BETWEEN 1 AND 256);
ALTER TABLE sandbox_settings
    ADD COLUMN interactive_mem_bytes INTEGER NOT NULL DEFAULT 4294967296
        CHECK (interactive_mem_bytes BETWEEN 67108864 AND 274877906944);
ALTER TABLE sandbox_settings
    ADD COLUMN normal_cpu_cores INTEGER NOT NULL DEFAULT 2
        CHECK (normal_cpu_cores BETWEEN 1 AND 256);
ALTER TABLE sandbox_settings
    ADD COLUMN normal_mem_bytes INTEGER NOT NULL DEFAULT 4294967296
        CHECK (normal_mem_bytes BETWEEN 67108864 AND 274877906944);
ALTER TABLE sandbox_settings
    ADD COLUMN batch_cpu_cores INTEGER NOT NULL DEFAULT 4
        CHECK (batch_cpu_cores BETWEEN 1 AND 256);
ALTER TABLE sandbox_settings
    ADD COLUMN batch_mem_bytes INTEGER NOT NULL DEFAULT 8589934592
        CHECK (batch_mem_bytes BETWEEN 67108864 AND 274877906944);
ALTER TABLE sandbox_settings
    ADD COLUMN default_env_id TEXT
        CHECK (default_env_id IS NULL
               OR (length(default_env_id) BETWEEN 1 AND 255
                   AND default_env_id NOT GLOB '*[^a-z0-9._-]*'));
ALTER TABLE sandbox_settings
    ADD COLUMN updated_by BLOB;
