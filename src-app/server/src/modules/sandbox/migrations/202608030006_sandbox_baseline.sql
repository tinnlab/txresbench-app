-- sandbox module — SQUASHED BASELINE — SQLite dialect port (ITEM-8,
-- sqlite-store) of
-- `src/modules/sandbox/migrations/202608030006_sandbox_baseline.sql`.
--
-- The Postgres file carries the squash provenance (a VERBATIM `pg_dump
-- --schema-only` rendering of the pre-squash chain's schema — column ORDER
-- included). This port preserves that identity — table/column NAMES, column
-- ORDER, constraint NAMES, row semantics — in SQLite dialect (DEC-2/DEC-8).
--
-- SQLite port notes (DEC-8 type map): `bigint` -> INTEGER (the byte-count
-- literals stay decimal), `text` -> TEXT, boolean -> INTEGER 0/1 (the
-- singleton `id` keeps its `DEFAULT 1` + `CHECK (id = 1)`), `timestamp with
-- time zone DEFAULT now()` -> TEXT RFC3339 UTC with
-- `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, no `public.` prefix, no `::` casts
-- (the numeric literal casts are dropped; they were `pg_dump` provenance of
-- the underlying column type), `USING btree` dropped. The Postgres
-- unqualified constraint names are kept verbatim. SQLite has no ALTER TABLE
-- ADD CONSTRAINT, so the PK + the eleven bounds CHECKs are declared INLINE
-- with the SAME names.
--
-- Ordering: applies after the SDK auth schema. CONSEQUENCE (unchanged from
-- the Postgres file): a database created before the squash MUST BE
-- RECREATED — see the "SQUASHED BASELINE" section of `src/database.rs`.

-- == tables ==============================================================

CREATE TABLE sandbox_settings (
    id INTEGER NOT NULL DEFAULT 1,
    memory_max_bytes INTEGER NOT NULL DEFAULT 8589934592,
    memory_swap_max_bytes INTEGER NOT NULL DEFAULT 8589934592,
    pids_max INTEGER NOT NULL DEFAULT 512,
    cpu_max TEXT NOT NULL DEFAULT '200000 100000',
    address_space_bytes INTEGER NOT NULL DEFAULT 68719476736,
    fsize_bytes INTEGER NOT NULL DEFAULT 2147483648,
    nproc_max INTEGER NOT NULL DEFAULT 512,
    nofile_max INTEGER NOT NULL DEFAULT 4096,
    cpu_secs_max INTEGER NOT NULL DEFAULT 600,
    timeout_secs INTEGER NOT NULL DEFAULT 600,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    staging_timeout_secs INTEGER NOT NULL DEFAULT 900,
    CONSTRAINT sandbox_settings_address_space_bytes_check CHECK (address_space_bytes BETWEEN 134217728 AND 549755813888),
    CONSTRAINT sandbox_settings_cpu_secs_max_check CHECK (cpu_secs_max BETWEEN 1 AND 86400),
    CONSTRAINT sandbox_settings_fsize_bytes_check CHECK (fsize_bytes BETWEEN 1048576 AND 274877906944),
    CONSTRAINT sandbox_settings_id_check CHECK (id = 1),
    CONSTRAINT sandbox_settings_memory_max_bytes_check CHECK (memory_max_bytes BETWEEN 67108864 AND 274877906944),
    CONSTRAINT sandbox_settings_memory_swap_max_bytes_check CHECK (memory_swap_max_bytes BETWEEN 0 AND 274877906944),
    CONSTRAINT sandbox_settings_nofile_max_check CHECK (nofile_max BETWEEN 64 AND 1048576),
    CONSTRAINT sandbox_settings_nproc_max_check CHECK (nproc_max BETWEEN 16 AND 100000),
    CONSTRAINT sandbox_settings_pids_max_check CHECK (pids_max BETWEEN 16 AND 100000),
    CONSTRAINT sandbox_settings_staging_timeout_secs_check CHECK (staging_timeout_secs BETWEEN 5 AND 86400),
    CONSTRAINT sandbox_settings_timeout_secs_check CHECK (timeout_secs BETWEEN 1 AND 86400),
    CONSTRAINT sandbox_settings_pkey PRIMARY KEY (id)
);

-- == seed data ==========================================================

-- Seed the single row. Every value is the column DEFAULT, which already carries
-- the net of the ceiling raises squashed in here (memory + swap 8 GiB, address
-- space 64 GiB, staging budget 900 s).
INSERT INTO sandbox_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
