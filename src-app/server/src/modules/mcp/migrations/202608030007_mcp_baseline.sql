-- mcp module — SQUASHED BASELINE.
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
-- src-app/server/src/modules/mcp/migrations`.
--
-- CONSEQUENCE: a database created before the squash MUST BE RECREATED — see the
-- "SQUASHED BASELINE" section of `src/database.rs`.
--
-- Ordering: applies after the SDK auth schema (users).

-- == tables ==============================================================

CREATE TABLE public.mcp_pairing_codes (
    id uuid NOT NULL,
    code text NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);

-- == primary keys / unique / table constraints ===========================

ALTER TABLE ONLY public.mcp_pairing_codes
    ADD CONSTRAINT mcp_pairing_codes_code_key UNIQUE (code);

ALTER TABLE ONLY public.mcp_pairing_codes
    ADD CONSTRAINT mcp_pairing_codes_pkey PRIMARY KEY (id);

-- == indexes =============================================================

CREATE INDEX idx_mcp_pairing_codes_code ON public.mcp_pairing_codes USING btree (code);

-- == foreign keys ========================================================

ALTER TABLE ONLY public.mcp_pairing_codes
    ADD CONSTRAINT mcp_pairing_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- == seed data + permission grants ====================================

-- Grant `mcp::use` to the default Users group (Administrators already hold
-- `*`) so every user can pair an AI assistant to drive the app on their own
-- behalf. Idempotent (skip if already present).
UPDATE public.groups
SET permissions = array_append(permissions, 'mcp::use')
WHERE name = 'Users'
  AND NOT ('mcp::use' = ANY (permissions));
