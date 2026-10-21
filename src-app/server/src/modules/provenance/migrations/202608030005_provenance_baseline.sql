-- provenance module — SQUASHED BASELINE.
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
-- src-app/server/src/modules/provenance/migrations`.
--
-- CONSEQUENCE: a database created before the squash MUST BE RECREATED — see the
-- "SQUASHED BASELINE" section of `src/database.rs`.
--
-- Ordering: applies after the project + dataset baselines.

-- == tables ==============================================================

CREATE TABLE public.provenance_code_blobs (
    sha256 text NOT NULL,
    language text NOT NULL,
    source text NOT NULL,
    byte_len bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.provenance_reference_resources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    kind text NOT NULL,
    name text NOT NULL,
    version text DEFAULT ''::text NOT NULL,
    accession text,
    doi text,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.provenance_run_repro (
    run_id uuid NOT NULL,
    project_id uuid,
    kind text NOT NULL,
    status text DEFAULT 'recorded'::text NOT NULL,
    generator_id text DEFAULT ''::text NOT NULL,
    generator_version text DEFAULT ''::text NOT NULL,
    code_sha256 text,
    env_rootfs_sha256 text,
    lockfile_json jsonb,
    seed bigint,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    inputs_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    acting_user uuid,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    rerun_spec_json jsonb,
    dataset_id uuid
);

CREATE TABLE public.provenance_settings (
    id boolean DEFAULT true NOT NULL,
    export_bundle_max_bytes bigint DEFAULT 1073741824 NOT NULL,
    export_retention_days bigint DEFAULT 30 NOT NULL,
    methods_llm_polish_enabled boolean DEFAULT false NOT NULL,
    verify_default_tolerance double precision DEFAULT 0.99 NOT NULL,
    verify_time_budget_secs bigint DEFAULT 3600 NOT NULL,
    verify_size_budget_bytes bigint DEFAULT '4294967296'::bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    capture_code_max_bytes bigint DEFAULT 262144 NOT NULL,
    CONSTRAINT provenance_settings_capture_code_max_bytes_check CHECK (((capture_code_max_bytes >= 4096) AND (capture_code_max_bytes <= 16777216))),
    CONSTRAINT provenance_settings_export_bundle_max_bytes_check CHECK (((export_bundle_max_bytes >= 1048576) AND (export_bundle_max_bytes <= '68719476736'::bigint))),
    CONSTRAINT provenance_settings_export_retention_days_check CHECK (((export_retention_days >= 0) AND (export_retention_days <= 3650))),
    CONSTRAINT provenance_settings_id_check CHECK ((id = true)),
    CONSTRAINT provenance_settings_verify_default_tolerance_check CHECK (((verify_default_tolerance >= (0.0)::double precision) AND (verify_default_tolerance <= (1.0)::double precision))),
    CONSTRAINT provenance_settings_verify_size_budget_bytes_check CHECK (((verify_size_budget_bytes >= 1048576) AND (verify_size_budget_bytes <= '274877906944'::bigint))),
    CONSTRAINT provenance_settings_verify_time_budget_secs_check CHECK (((verify_time_budget_secs >= 1) AND (verify_time_budget_secs <= 86400)))
);

CREATE TABLE public.provenance_verifications (
    id uuid NOT NULL,
    target_run_id uuid NOT NULL,
    project_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    tolerance_mode text DEFAULT 'tolerant'::text NOT NULL,
    diff_report jsonb DEFAULT '{}'::jsonb NOT NULL,
    rootfs_digest text,
    cert_json jsonb,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- == primary keys / unique / table constraints ===========================

ALTER TABLE ONLY public.provenance_code_blobs
    ADD CONSTRAINT provenance_code_blobs_pkey PRIMARY KEY (sha256);

ALTER TABLE ONLY public.provenance_reference_resources
    ADD CONSTRAINT provenance_reference_resources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provenance_run_repro
    ADD CONSTRAINT provenance_run_repro_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.provenance_settings
    ADD CONSTRAINT provenance_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provenance_verifications
    ADD CONSTRAINT provenance_verifications_pkey PRIMARY KEY (id);

-- == indexes =============================================================

CREATE UNIQUE INDEX provenance_reference_dedup ON public.provenance_reference_resources USING btree (kind, content_hash, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX provenance_reference_resources_hash ON public.provenance_reference_resources USING btree (content_hash);

CREATE INDEX provenance_reference_resources_project ON public.provenance_reference_resources USING btree (project_id);

CREATE INDEX provenance_run_repro_dataset_captured ON public.provenance_run_repro USING btree (dataset_id, captured_at DESC);

CREATE INDEX provenance_run_repro_project_captured ON public.provenance_run_repro USING btree (project_id, captured_at DESC);

CREATE INDEX provenance_verifications_project ON public.provenance_verifications USING btree (project_id, created_at DESC);

CREATE INDEX provenance_verifications_run ON public.provenance_verifications USING btree (target_run_id, created_at DESC);

-- == foreign keys ========================================================

ALTER TABLE ONLY public.provenance_reference_resources
    ADD CONSTRAINT provenance_reference_resources_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.provenance_run_repro
    ADD CONSTRAINT provenance_run_repro_code_sha256_fkey FOREIGN KEY (code_sha256) REFERENCES public.provenance_code_blobs(sha256);

ALTER TABLE ONLY public.provenance_run_repro
    ADD CONSTRAINT provenance_run_repro_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES public.datasets(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.provenance_run_repro
    ADD CONSTRAINT provenance_run_repro_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.provenance_verifications
    ADD CONSTRAINT provenance_verifications_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

-- == seed data + permission grants ====================================

INSERT INTO provenance_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- `provenance::read` + `provenance::export` are granted to the Users group (every
-- projects user may read the lineage of, and export, projects they can access; the
-- per-project role via effective_permission gates the specific project). The admin
-- perms `provenance::settings::{read,manage}` get NO grant — Administrators hold
-- them via the `*` wildcard / is_admin short-circuit. Idempotent array_append.
UPDATE public.groups
SET permissions = array_append(permissions, 'provenance::read')
WHERE name = 'Users'
  AND NOT ('provenance::read' = ANY (permissions));

UPDATE public.groups
SET permissions = array_append(permissions, 'provenance::export')
WHERE name = 'Users'
  AND NOT ('provenance::export' = ANY (permissions));
