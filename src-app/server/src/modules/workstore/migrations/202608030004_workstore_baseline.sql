-- workstore module — SQUASHED BASELINE.
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
-- src-app/server/src/modules/workstore/migrations`.
--
-- CONSEQUENCE: a database created before the squash MUST BE RECREATED — see the
-- "SQUASHED BASELINE" section of `src/database.rs`.
--
-- Ordering: applies after the project + dataset baselines.

-- == tables ==============================================================

CREATE TABLE public.artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    run_id uuid,
    output_id text NOT NULL,
    datatype text NOT NULL,
    storage_layout text NOT NULL,
    object_key text NOT NULL,
    is_multifile boolean DEFAULT false NOT NULL,
    content_hash text NOT NULL,
    shape jsonb DEFAULT '{}'::jsonb NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    covered_axes jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    dataset_id uuid,
    hidden boolean DEFAULT false NOT NULL,
    representation_of uuid
);

CREATE TABLE public.workstore_axis_entry (
    project_id uuid NOT NULL,
    axis_name text NOT NULL,
    entry_index integer NOT NULL,
    entry_key text,
    group_id uuid,
    group_local_index integer
);

-- == primary keys / unique / table constraints ===========================

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workstore_axis_entry
    ADD CONSTRAINT workstore_axis_entry_pkey PRIMARY KEY (project_id, axis_name, entry_index);

-- == indexes =============================================================

CREATE INDEX artifacts_dataset_datatype ON public.artifacts USING btree (dataset_id, datatype);

CREATE INDEX artifacts_dataset_id ON public.artifacts USING btree (dataset_id);

CREATE UNIQUE INDEX artifacts_natural_key ON public.artifacts USING btree (COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(dataset_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid), output_id);

CREATE INDEX artifacts_object_key ON public.artifacts USING btree (object_key);

CREATE INDEX artifacts_project_datatype ON public.artifacts USING btree (project_id, datatype);

CREATE INDEX artifacts_project_run ON public.artifacts USING btree (project_id, run_id);

CREATE INDEX idx_artifacts_representation_of ON public.artifacts USING btree (representation_of);

CREATE INDEX workstore_axis_entry_group ON public.workstore_axis_entry USING btree (project_id, axis_name, group_id);

CREATE UNIQUE INDEX workstore_axis_entry_group_identity ON public.workstore_axis_entry USING btree (project_id, axis_name, group_id, group_local_index) WHERE (group_id IS NOT NULL);

CREATE UNIQUE INDEX workstore_axis_entry_key ON public.workstore_axis_entry USING btree (project_id, axis_name, entry_key) WHERE (entry_key IS NOT NULL);

-- == foreign keys ========================================================

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES public.datasets(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_representation_of_fkey FOREIGN KEY (representation_of) REFERENCES public.artifacts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.workstore_axis_entry
    ADD CONSTRAINT workstore_axis_entry_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
