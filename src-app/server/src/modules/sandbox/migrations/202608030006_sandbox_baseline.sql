-- sandbox module — SQUASHED BASELINE.
--
-- This single file replaces the module's pre-release incremental migration
-- history. The app was squashed to one baseline per module before first
-- release: the old chain created, ALTERed and then DROPped an earlier
-- domain-specific data model, so it carried retired domain vocabulary forward
-- in perpetuity for a schema that no longer contains it. An applied migration file
-- is byte-immutable (`sqlx::migrate!` checksums full file bytes — see the
-- `MERGED_MIGRATOR` doc in `src/database.rs`), so that vocabulary could not be
-- edited out in place; only a squash removes it.
--
-- Every DDL statement below is a VERBATIM `pg_dump --schema-only` rendering of
-- the schema the full chain produced, so the end state is identical to the
-- pre-squash schema — column ORDER included. Some columns therefore sit where an
-- `ALTER TABLE … ADD COLUMN` put them rather than in a tidier place; that is
-- deliberate, and it is what makes the identity mechanically provable.
--
-- The per-statement DESIGN RATIONALE the retired files carried is not
-- reproduced here (much of it narrated the very model that was dropped). It
-- lives in git history: `git log --diff-filter=D -p -- \
-- src-app/server/src/modules/sandbox/migrations`.
--
-- CONSEQUENCE: a database created before the squash MUST BE RECREATED — see the
-- "SQUASHED BASELINE" section of `src/database.rs`.
--
-- Ordering: applies after the SDK auth schema.

-- == tables ==============================================================

CREATE TABLE public.sandbox_settings (
    id boolean DEFAULT true NOT NULL,
    memory_max_bytes bigint DEFAULT '8589934592'::bigint NOT NULL,
    memory_swap_max_bytes bigint DEFAULT '8589934592'::bigint NOT NULL,
    pids_max bigint DEFAULT 512 NOT NULL,
    cpu_max text DEFAULT '200000 100000'::text NOT NULL,
    address_space_bytes bigint DEFAULT '68719476736'::bigint NOT NULL,
    fsize_bytes bigint DEFAULT '2147483648'::bigint NOT NULL,
    nproc_max bigint DEFAULT 512 NOT NULL,
    nofile_max bigint DEFAULT 4096 NOT NULL,
    cpu_secs_max bigint DEFAULT 600 NOT NULL,
    timeout_secs bigint DEFAULT 600 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    staging_timeout_secs bigint DEFAULT 900 NOT NULL,
    CONSTRAINT sandbox_settings_address_space_bytes_check CHECK (((address_space_bytes >= 134217728) AND (address_space_bytes <= '549755813888'::bigint))),
    CONSTRAINT sandbox_settings_cpu_secs_max_check CHECK (((cpu_secs_max >= 1) AND (cpu_secs_max <= 86400))),
    CONSTRAINT sandbox_settings_fsize_bytes_check CHECK (((fsize_bytes >= 1048576) AND (fsize_bytes <= '274877906944'::bigint))),
    CONSTRAINT sandbox_settings_id_check CHECK ((id = true)),
    CONSTRAINT sandbox_settings_memory_max_bytes_check CHECK (((memory_max_bytes >= 67108864) AND (memory_max_bytes <= '274877906944'::bigint))),
    CONSTRAINT sandbox_settings_memory_swap_max_bytes_check CHECK (((memory_swap_max_bytes >= 0) AND (memory_swap_max_bytes <= '274877906944'::bigint))),
    CONSTRAINT sandbox_settings_nofile_max_check CHECK (((nofile_max >= 64) AND (nofile_max <= 1048576))),
    CONSTRAINT sandbox_settings_nproc_max_check CHECK (((nproc_max >= 16) AND (nproc_max <= 100000))),
    CONSTRAINT sandbox_settings_pids_max_check CHECK (((pids_max >= 16) AND (pids_max <= 100000))),
    CONSTRAINT sandbox_settings_staging_timeout_secs_check CHECK (((staging_timeout_secs >= 5) AND (staging_timeout_secs <= 86400))),
    CONSTRAINT sandbox_settings_timeout_secs_check CHECK (((timeout_secs >= 1) AND (timeout_secs <= 86400)))
);

-- == primary keys / unique / table constraints ===========================

ALTER TABLE ONLY public.sandbox_settings
    ADD CONSTRAINT sandbox_settings_pkey PRIMARY KEY (id);

-- == seed data + permission grants ====================================

-- Seed the single row. Every value is the column DEFAULT, which already carries
-- the net of the ceiling raises squashed in here (memory + swap 8 GiB, address
-- space 64 GiB, staging budget 900 s).
INSERT INTO sandbox_settings (id) VALUES (TRUE)
ON CONFLICT (id) DO NOTHING;
