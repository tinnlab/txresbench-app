-- drafts module — BASELINE.
--
-- A `draftable entity` is a domain-free, mutable, project-scoped working document
-- (`drafts` row) a package can EDIT declaratively and FREEZE into a content-addressed
-- immutable artifact. Core interprets NOTHING about a draft's `kind` or `data`
-- (INV-1): it owns the table, the freeze transition, the sync contract and the
-- `$state`↔draft binding; the package owns the schema, the edit view and the freeze
-- producer.
--
-- `status` is a BARE text column with the vocabulary in a `const` (like
-- `artifacts.status` / `project_shares.status`) — never `unwrap()`ed as an enum from
-- the DB. `open | frozen`.
--
-- Ordering: applies after the project baseline (the `project_id` FK) and the
-- workstore artifact baseline (the `frozen_artifact_id` FK).

-- == tables ==============================================================

CREATE TABLE public.drafts (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    kind text NOT NULL,
    project_id uuid NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    frozen_artifact_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT drafts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'frozen'::text])))
);

-- == primary keys / table constraints ====================================

ALTER TABLE ONLY public.drafts
    ADD CONSTRAINT drafts_pkey PRIMARY KEY (id);

-- == indexes =============================================================

-- The one list index: drafts of a given kind within a project, newest-touched
-- first (the `list?project_id&kind` query shape).
CREATE INDEX drafts_project_idx ON public.drafts USING btree (project_id, kind, updated_at DESC);

-- == foreign keys ========================================================

-- Project-cascade-delete: an abandoned draft dies with its project (DEC-1; no TTL
-- prune in v1).
ALTER TABLE ONLY public.drafts
    ADD CONSTRAINT drafts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

-- A frozen artifact removed out from under a draft nulls the pointer (the draft row
-- persists; a subsequent freeze re-mints — INV-2/DEC-3).
ALTER TABLE ONLY public.drafts
    ADD CONSTRAINT drafts_frozen_artifact_id_fkey FOREIGN KEY (frozen_artifact_id) REFERENCES public.artifacts(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.drafts
    ADD CONSTRAINT drafts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- == permission grants ===================================================

-- Grant `drafts::use` to the default Users group (Administrators already hold `*`).
-- Idempotent (skip if already present).
UPDATE public.groups
SET permissions = array_append(permissions, 'drafts::use')
WHERE name = 'Users'
  AND NOT ('drafts::use' = ANY (permissions));
