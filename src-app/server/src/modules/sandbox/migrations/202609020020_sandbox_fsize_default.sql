-- Raise the sandbox RLIMIT_FSIZE default 2 GiB -> 64 GiB (#185 §4, owner
-- ruling 2) — SQLite dialect port (ITEM-8) of
-- `src/modules/sandbox/migrations/202609020020_sandbox_fsize_default.sql`.
--
-- `fsize_bytes` caps every file written INSIDE a sandbox, including the archive
-- extraction the importer uses to expand a vendor bundle. At 2 GiB it is what
-- blocks Xenium IMPORT: upload itself already works since ac7c6b50 (#182), but a
-- Xenium morphology OME-TIFF exceeds 2 GiB on its own, so `extractall` died on the
-- write.
--
-- The number is derived from measured file sizes, not taste (DEC-6 /
-- docs/design/upload-limits-policy.md).
--
-- SQLite port note — the one construct change: SQLite has no
-- `ALTER TABLE … ALTER COLUMN … SET DEFAULT`, so this file follows the
-- SQLite-documented rebuild procedure (create the new table with the full
-- column list — the same order the chain produces — copy, drop, rename).
-- The rebuild is safe here: nothing references `sandbox_settings` (it is a
-- settings singleton with no inbound FKs, verified over the whole PG chain),
-- the table carries no triggers in this chain, and the copy is positional
-- (column ORDER preserved). The rebuild also folds ALL eighteen bounds
-- CHECKs (the eleven baseline + the seven per-class + the env-id grammar
-- from 202608290010) INLINE with their Postgres constraint names — the
-- final schema is fully declarative, where the incremental port used the
-- anonymous inline forms.
--
-- The conditional UPDATE below is the Postgres file's rule verbatim
-- (only rows still holding the OLD SHIPPED DEFAULT are raised; an operator
-- who deliberately chose another value keeps it — `fsize_bytes =
-- 2147483648` alone is not the discriminator, `updated_by IS NULL` is:
-- the settings idiom stamps it on every admin PUT, so NULL means no human
-- has ever written this row and the value present is the seed). `updated_at`
-- is stamped so the change is visible in the audit column; `updated_by`
-- stays NULL because no admin did this — the migration did.

CREATE TABLE sandbox_settings_new (
    id INTEGER NOT NULL DEFAULT 1,
    memory_max_bytes INTEGER NOT NULL DEFAULT 8589934592,
    memory_swap_max_bytes INTEGER NOT NULL DEFAULT 8589934592,
    pids_max INTEGER NOT NULL DEFAULT 512,
    cpu_max TEXT NOT NULL DEFAULT '200000 100000',
    address_space_bytes INTEGER NOT NULL DEFAULT 68719476736,
    fsize_bytes INTEGER NOT NULL DEFAULT 68719476736,
    nproc_max INTEGER NOT NULL DEFAULT 512,
    nofile_max INTEGER NOT NULL DEFAULT 4096,
    cpu_secs_max INTEGER NOT NULL DEFAULT 600,
    timeout_secs INTEGER NOT NULL DEFAULT 600,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    staging_timeout_secs INTEGER NOT NULL DEFAULT 900,
    interactive_cpu_cores INTEGER NOT NULL DEFAULT 2,
    interactive_mem_bytes INTEGER NOT NULL DEFAULT 4294967296,
    normal_cpu_cores INTEGER NOT NULL DEFAULT 2,
    normal_mem_bytes INTEGER NOT NULL DEFAULT 4294967296,
    batch_cpu_cores INTEGER NOT NULL DEFAULT 4,
    batch_mem_bytes INTEGER NOT NULL DEFAULT 8589934592,
    default_env_id TEXT,
    updated_by BLOB,
    CONSTRAINT sandbox_settings_address_space_bytes_check CHECK (address_space_bytes BETWEEN 134217728 AND 549755813888),
    CONSTRAINT sandbox_settings_batch_cpu_bounds CHECK (batch_cpu_cores BETWEEN 1 AND 256),
    CONSTRAINT sandbox_settings_batch_mem_bounds CHECK (batch_mem_bytes BETWEEN 67108864 AND 274877906944),
    CONSTRAINT sandbox_settings_cpu_secs_max_check CHECK (cpu_secs_max BETWEEN 1 AND 86400),
    CONSTRAINT sandbox_settings_default_env_id_grammar CHECK (default_env_id IS NULL
        OR (length(default_env_id) BETWEEN 1 AND 255
            AND default_env_id NOT GLOB '*[^a-z0-9._-]*')),
    CONSTRAINT sandbox_settings_fsize_bytes_check CHECK (fsize_bytes BETWEEN 1048576 AND 274877906944),
    CONSTRAINT sandbox_settings_id_check CHECK (id = 1),
    CONSTRAINT sandbox_settings_interactive_cpu_bounds CHECK (interactive_cpu_cores BETWEEN 1 AND 256),
    CONSTRAINT sandbox_settings_interactive_mem_bounds CHECK (interactive_mem_bytes BETWEEN 67108864 AND 274877906944),
    CONSTRAINT sandbox_settings_memory_max_bytes_check CHECK (memory_max_bytes BETWEEN 67108864 AND 274877906944),
    CONSTRAINT sandbox_settings_memory_swap_max_bytes_check CHECK (memory_swap_max_bytes BETWEEN 0 AND 274877906944),
    CONSTRAINT sandbox_settings_nofile_max_check CHECK (nofile_max BETWEEN 64 AND 1048576),
    CONSTRAINT sandbox_settings_normal_cpu_bounds CHECK (normal_cpu_cores BETWEEN 1 AND 256),
    CONSTRAINT sandbox_settings_normal_mem_bounds CHECK (normal_mem_bytes BETWEEN 67108864 AND 274877906944),
    CONSTRAINT sandbox_settings_nproc_max_check CHECK (nproc_max BETWEEN 16 AND 100000),
    CONSTRAINT sandbox_settings_pids_max_check CHECK (pids_max BETWEEN 16 AND 100000),
    CONSTRAINT sandbox_settings_staging_timeout_secs_check CHECK (staging_timeout_secs BETWEEN 5 AND 86400),
    CONSTRAINT sandbox_settings_timeout_secs_check CHECK (timeout_secs BETWEEN 1 AND 86400),
    CONSTRAINT sandbox_settings_pkey PRIMARY KEY (id)
);

INSERT INTO sandbox_settings_new (id, memory_max_bytes, memory_swap_max_bytes,
    pids_max, cpu_max, address_space_bytes, fsize_bytes, nproc_max, nofile_max,
    cpu_secs_max, timeout_secs, updated_at, staging_timeout_secs,
    interactive_cpu_cores, interactive_mem_bytes, normal_cpu_cores,
    normal_mem_bytes, batch_cpu_cores, batch_mem_bytes, default_env_id,
    updated_by)
SELECT id, memory_max_bytes, memory_swap_max_bytes,
    pids_max, cpu_max, address_space_bytes, fsize_bytes, nproc_max, nofile_max,
    cpu_secs_max, timeout_secs, updated_at, staging_timeout_secs,
    interactive_cpu_cores, interactive_mem_bytes, normal_cpu_cores,
    normal_mem_bytes, batch_cpu_cores, batch_mem_bytes, default_env_id,
    updated_by
FROM sandbox_settings;

DROP TABLE sandbox_settings;

ALTER TABLE sandbox_settings_new RENAME TO sandbox_settings;

-- Raise EXISTING deployments too (see the header — the discriminator rule).
UPDATE sandbox_settings
   SET fsize_bytes = 68719476736,
       updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE fsize_bytes = 2147483648
   AND updated_by IS NULL;
