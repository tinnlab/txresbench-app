-- project module — SQUASHED BASELINE.
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
-- src-app/server/src/modules/project/migrations`.
--
-- CONSEQUENCE: a database created before the squash MUST BE RECREATED — see the
-- "SQUASHED BASELINE" section of `src/database.rs`.
--
-- Ordering: applies after the SDK notifications schema and the dataset baseline.

-- == tables ==============================================================

CREATE TABLE public.project_datasets (
    dataset_id uuid NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.project_settings (
    singleton boolean DEFAULT true NOT NULL,
    transfer_enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_settings_singleton_check CHECK (singleton)
);

CREATE TABLE public.project_shares (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    permission_level text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_shares_permission_level_check CHECK ((permission_level = ANY (ARRAY['viewer'::text, 'editor'::text]))),
    CONSTRAINT project_shares_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])))
);

CREATE TABLE public.project_transfers (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    from_user_id uuid NOT NULL,
    to_user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_transfers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])))
);

CREATE TABLE public.projects (
    id uuid NOT NULL,
    owner_id uuid NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- == primary keys / unique / table constraints ===========================

ALTER TABLE ONLY public.project_datasets
    ADD CONSTRAINT project_datasets_pkey PRIMARY KEY (project_id, dataset_id);

ALTER TABLE ONLY public.project_settings
    ADD CONSTRAINT project_settings_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY public.project_shares
    ADD CONSTRAINT project_shares_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.project_transfers
    ADD CONSTRAINT project_transfers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

-- == indexes =============================================================

CREATE INDEX idx_project_datasets_dataset ON public.project_datasets USING btree (dataset_id);

CREATE INDEX idx_project_datasets_project ON public.project_datasets USING btree (project_id, created_at DESC);

CREATE INDEX idx_project_shares_recipient_status ON public.project_shares USING btree (recipient_id, status);

CREATE INDEX idx_project_transfers_to_status ON public.project_transfers USING btree (to_user_id, status);

CREATE INDEX idx_projects_owner_created ON public.projects USING btree (owner_id, created_at DESC);

CREATE UNIQUE INDEX uq_project_shares_project_recipient ON public.project_shares USING btree (project_id, recipient_id);

CREATE UNIQUE INDEX uq_project_transfers_pending ON public.project_transfers USING btree (project_id) WHERE (status = 'pending'::text);

-- == foreign keys ========================================================

ALTER TABLE ONLY public.project_datasets
    ADD CONSTRAINT project_datasets_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES public.datasets(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.project_datasets
    ADD CONSTRAINT project_datasets_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.project_shares
    ADD CONSTRAINT project_shares_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.project_shares
    ADD CONSTRAINT project_shares_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.project_shares
    ADD CONSTRAINT project_shares_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.project_transfers
    ADD CONSTRAINT project_transfers_from_user_id_fkey FOREIGN KEY (from_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.project_transfers
    ADD CONSTRAINT project_transfers_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.project_transfers
    ADD CONSTRAINT project_transfers_to_user_id_fkey FOREIGN KEY (to_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- == seed data + permission grants ====================================

-- Seed the singleton (default: transfer enabled — an admin can disable).
INSERT INTO project_settings (singleton, transfer_enabled)
    VALUES (true, true)
    ON CONFLICT (singleton) DO NOTHING;

-- Grant the permissions to the default Users group (Administrators already hold
-- `*`). `projects::use` gates all project CRUD; `notifications::read` gates the
-- SDK notification inbox. Idempotent (skip if already present).
UPDATE public.groups
SET permissions = array_append(permissions, 'projects::use')
WHERE name = 'Users'
  AND NOT ('projects::use' = ANY (permissions));

UPDATE public.groups
SET permissions = array_append(permissions, 'notifications::read')
WHERE name = 'Users'
  AND NOT ('notifications::read' = ANY (permissions));
