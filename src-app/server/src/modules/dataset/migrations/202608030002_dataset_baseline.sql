-- dataset module — SQUASHED BASELINE.
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
-- src-app/server/src/modules/dataset/migrations`.
--
-- CONSEQUENCE: a database created before the squash MUST BE RECREATED — see the
-- "SQUASHED BASELINE" section of `src/database.rs`.
--
-- Ordering: applies after the SDK file store (files) and the jobs baseline.

-- == tables ==============================================================

CREATE TABLE public.dataset_files (
    dataset_id uuid NOT NULL,
    file_id uuid NOT NULL,
    ordinal integer DEFAULT 0 NOT NULL,
    role text DEFAULT 'primary'::text NOT NULL,
    kind text,
    integration_status text,
    integration_summary jsonb,
    integration_job_id uuid,
    CONSTRAINT dataset_files_integration_status_check CHECK (((integration_status IS NULL) OR (integration_status = ANY (ARRAY['pending'::text, 'running'::text, 'integrated'::text, 'failed'::text])))),
    CONSTRAINT dataset_files_role_check CHECK ((role = ANY (ARRAY['primary'::text, 'supporting'::text])))
);

CREATE TABLE public.dataset_folder_members (
    folder_id uuid NOT NULL,
    dataset_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.dataset_folders (
    id uuid NOT NULL,
    owner_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.dataset_shares (
    id uuid NOT NULL,
    dataset_id uuid NOT NULL,
    principal_type text NOT NULL,
    principal_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dataset_shares_principal_type_check CHECK ((principal_type = ANY (ARRAY['user'::text, 'group'::text]))),
    CONSTRAINT dataset_shares_role_check CHECK ((role = ANY (ARRAY['view'::text, 'edit'::text])))
);

CREATE TABLE public.datasets (
    id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_id uuid NOT NULL,
    datatype text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text DEFAULT 'upload'::text NOT NULL,
    source_artifact_id uuid,
    content_hash text,
    processing_job_id uuid,
    CONSTRAINT datasets_source_check CHECK ((source = ANY (ARRAY['upload'::text, 'promote'::text])))
);

-- == primary keys / unique / table constraints ===========================

ALTER TABLE ONLY public.dataset_files
    ADD CONSTRAINT dataset_files_pkey PRIMARY KEY (dataset_id, file_id);

ALTER TABLE ONLY public.dataset_folder_members
    ADD CONSTRAINT dataset_folder_members_pkey PRIMARY KEY (folder_id, dataset_id);

ALTER TABLE ONLY public.dataset_folders
    ADD CONSTRAINT dataset_folders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.dataset_shares
    ADD CONSTRAINT dataset_shares_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.datasets
    ADD CONSTRAINT datasets_pkey PRIMARY KEY (id);

-- == indexes =============================================================

CREATE INDEX idx_dataset_files_file ON public.dataset_files USING btree (file_id);

CREATE INDEX idx_dataset_files_integration_job ON public.dataset_files USING btree (integration_job_id);

CREATE INDEX idx_dataset_files_role ON public.dataset_files USING btree (dataset_id, role);

CREATE INDEX idx_dataset_folder_members_dataset ON public.dataset_folder_members USING btree (dataset_id);

CREATE INDEX idx_dataset_folders_owner ON public.dataset_folders USING btree (owner_id, created_at DESC);

CREATE INDEX idx_dataset_shares_principal ON public.dataset_shares USING btree (principal_type, principal_id);

CREATE INDEX idx_datasets_created_at ON public.datasets USING btree (created_at DESC);

CREATE INDEX idx_datasets_owner ON public.datasets USING btree (owner_id, created_at DESC);

CREATE INDEX idx_datasets_processing_job ON public.datasets USING btree (processing_job_id);

CREATE UNIQUE INDEX uq_dataset_shares ON public.dataset_shares USING btree (dataset_id, principal_type, principal_id);

-- == foreign keys ========================================================

ALTER TABLE ONLY public.dataset_files
    ADD CONSTRAINT dataset_files_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES public.datasets(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.dataset_files
    ADD CONSTRAINT dataset_files_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.dataset_files
    ADD CONSTRAINT dataset_files_integration_job_id_fkey FOREIGN KEY (integration_job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.dataset_folder_members
    ADD CONSTRAINT dataset_folder_members_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES public.datasets(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.dataset_folder_members
    ADD CONSTRAINT dataset_folder_members_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.dataset_folders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.dataset_folders
    ADD CONSTRAINT dataset_folders_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.dataset_shares
    ADD CONSTRAINT dataset_shares_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES public.datasets(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.datasets
    ADD CONSTRAINT datasets_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.datasets
    ADD CONSTRAINT datasets_processing_job_id_fkey FOREIGN KEY (processing_job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;
