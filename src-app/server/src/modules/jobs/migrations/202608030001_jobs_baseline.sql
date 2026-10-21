-- jobs module — SQUASHED BASELINE.
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
-- src-app/server/src/modules/jobs/migrations`.
--
-- CONSEQUENCE: a database created before the squash MUST BE RECREATED — see the
-- "SQUASHED BASELINE" section of `src/database.rs`.
--
-- Ordering: applies after the SDK auth schema + seed (users, groups).

-- == tables ==============================================================

CREATE TABLE public.job_dependencies (
    job_id uuid NOT NULL,
    depends_on_job_id uuid NOT NULL,
    CONSTRAINT job_dependencies_check CHECK ((job_id <> depends_on_job_id))
);

CREATE TABLE public.job_logs (
    id uuid NOT NULL,
    job_id uuid NOT NULL,
    seq integer NOT NULL,
    stream text DEFAULT 'stdout'::text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.job_metrics (
    id uuid NOT NULL,
    job_id uuid NOT NULL,
    sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    cpu_pct real NOT NULL,
    mem_bytes bigint NOT NULL,
    mem_peak_bytes bigint,
    pids_current integer
);

CREATE TABLE public.job_milestones (
    id uuid NOT NULL,
    job_id uuid NOT NULL,
    milestone_id text NOT NULL,
    status text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.job_scope (
    job_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_id uuid NOT NULL,
    CONSTRAINT job_scope_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['project'::text, 'dataset'::text])))
);

CREATE TABLE public.job_settings (
    id boolean DEFAULT true NOT NULL,
    max_concurrent_jobs integer DEFAULT 2 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reserved_interactive_slots integer DEFAULT 1 NOT NULL,
    CONSTRAINT job_settings_max_concurrent_jobs_check CHECK (((max_concurrent_jobs >= 1) AND (max_concurrent_jobs <= 64))),
    CONSTRAINT job_settings_reserved_slots_check CHECK (((reserved_interactive_slots >= 0) AND (reserved_interactive_slots < max_concurrent_jobs))),
    CONSTRAINT job_settings_singleton CHECK ((id = true))
);

CREATE TABLE public.jobs (
    id uuid NOT NULL,
    owner_id uuid NOT NULL,
    job_type text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    exit_code integer,
    error text,
    pid integer,
    priority_class text DEFAULT 'normal'::text NOT NULL,
    resource_class text DEFAULT 'cpu-sandbox'::text NOT NULL,
    req_cpu integer,
    req_mem_bytes bigint,
    run_id uuid,
    CONSTRAINT jobs_priority_class_check CHECK ((priority_class = ANY (ARRAY['interactive'::text, 'normal'::text, 'batch'::text]))),
    CONSTRAINT jobs_resource_class_check CHECK ((resource_class = ANY (ARRAY['cpu-sandbox'::text, 'gpu'::text, 'highmem'::text, 'cluster-batch'::text])))
);

-- == primary keys / unique / table constraints ===========================

ALTER TABLE ONLY public.job_dependencies
    ADD CONSTRAINT job_dependencies_pkey PRIMARY KEY (job_id, depends_on_job_id);

ALTER TABLE ONLY public.job_logs
    ADD CONSTRAINT job_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.job_metrics
    ADD CONSTRAINT job_metrics_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.job_milestones
    ADD CONSTRAINT job_milestones_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.job_scope
    ADD CONSTRAINT job_scope_pkey PRIMARY KEY (job_id);

ALTER TABLE ONLY public.job_settings
    ADD CONSTRAINT job_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

-- == indexes =============================================================

CREATE INDEX idx_job_deps_depends_on ON public.job_dependencies USING btree (depends_on_job_id);

CREATE INDEX idx_job_logs_job_seq ON public.job_logs USING btree (job_id, seq);

CREATE INDEX idx_job_metrics_job_time ON public.job_metrics USING btree (job_id, sampled_at);

CREATE INDEX idx_job_milestones_job_id ON public.job_milestones USING btree (job_id);

CREATE INDEX idx_job_scope_kind_id ON public.job_scope USING btree (scope_kind, scope_id);

CREATE INDEX idx_jobs_owner_created ON public.jobs USING btree (owner_id, created_at DESC);

CREATE INDEX idx_jobs_status_created ON public.jobs USING btree (status, created_at);

CREATE INDEX idx_jobs_status_priority_created ON public.jobs USING btree (status, priority_class, created_at);

-- == foreign keys ========================================================

ALTER TABLE ONLY public.job_dependencies
    ADD CONSTRAINT job_dependencies_depends_on_job_id_fkey FOREIGN KEY (depends_on_job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_dependencies
    ADD CONSTRAINT job_dependencies_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_logs
    ADD CONSTRAINT job_logs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_metrics
    ADD CONSTRAINT job_metrics_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_milestones
    ADD CONSTRAINT job_milestones_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_scope
    ADD CONSTRAINT job_scope_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- == seed data + permission grants ====================================

-- Seed the singleton so the scheduler + GET always find a value. The seeded
-- `reserved_interactive_slots` = 1 is the net of the original seed plus the
-- later clamp UPDATE (both squashed in here).
INSERT INTO job_settings (id, max_concurrent_jobs, reserved_interactive_slots)
VALUES (TRUE, 2, 1)
ON CONFLICT (id) DO NOTHING;

-- Grant the job permission to the default Users group (Administrators already
-- hold `*`). `jobs::use` gates job create / list-own / stop-own. The admin-only
-- `jobs::settings::{read,manage}` are NOT granted here. Idempotent.
UPDATE public.groups
SET permissions = array_append(permissions, 'jobs::use')
WHERE name = 'Users'
  AND NOT ('jobs::use' = ANY (permissions));
