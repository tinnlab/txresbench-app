-- account module — BASELINE (A1 of the accounts/tenancy epic).
--
-- Creates the account graph the whole epic keys on: `accounts` (personal/org
-- tenancy units) + `account_members` (the (account, user, role) membership edge),
-- the role + kind vocabulary (as CHECK constraints), an idempotent backfill giving
-- every pre-existing user exactly one personal account + owner membership, and the
-- `account::read` grant to the Users group.
--
-- Scope boundary (issue #14 / DEC-3): A1 does NOT touch ownership — it adds NO
-- `projects.account_id` / `datasets.account_id` column and NO projects/datasets
-- repoint (that is A2). Only the account graph + its own backfill live here.
--
-- Ordering: prefix 202608040012 sorts ABOVE the app's current max (202608040011)
-- and ABOVE the ziee-auth schema+seed (202607140050 / 202607144500), so `users` +
-- the `Users` group already exist when this applies.

-- == tables ==============================================================

-- The tenancy unit every downstream concern keys on. `kind` is the personal/org
-- discriminator (DEC-1, a text CHECK not a boolean, for extensibility);
-- `personal_user_id` is the owning user for a personal account (NULL for an org),
-- and `accounts_personal_has_user` ties the two together (a personal account MUST
-- have a user; an org MUST NOT).
CREATE TABLE public.accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    personal_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT accounts_kind_check CHECK ((kind = ANY (ARRAY['personal'::text, 'organization'::text]))),
    CONSTRAINT accounts_personal_has_user CHECK (((kind = 'personal'::text) = (personal_user_id IS NOT NULL)))
);

-- The (account, user) membership edge with its coarse account role. Composite PK
-- is the one-membership-per-(account,user) constraint (DEC / Cal.com precedent).
CREATE TABLE public.account_members (
    account_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);

-- == primary keys / unique / table constraints ===========================

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.account_members
    ADD CONSTRAINT account_members_pkey PRIMARY KEY (account_id, user_id);

-- == indexes =============================================================

-- One personal account per user, enforced by the DATABASE (DEC-2) — the
-- `ensure_personal_account` ON CONFLICT target + the one-personal-per-user
-- invariant (INV-1). Partial so orgs (personal_user_id IS NULL) are unconstrained.
CREATE UNIQUE INDEX uq_accounts_personal_user ON public.accounts USING btree (personal_user_id) WHERE (kind = 'personal'::text);

-- "which accounts is this user in" (the switcher list + audience source).
CREATE INDEX idx_account_members_user ON public.account_members USING btree (user_id);

-- == foreign keys ========================================================

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_personal_user_id_fkey FOREIGN KEY (personal_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.account_members
    ADD CONSTRAINT account_members_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.account_members
    ADD CONSTRAINT account_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- == data backfill (idempotent) ==========================================
--
-- Give every EXISTING user exactly one personal account + an owner membership
-- (PROV-A1-10). Idempotent (INV-2): re-running is a no-op via `WHERE NOT EXISTS`
-- (guarded by uq_accounts_personal_user) + `ON CONFLICT DO NOTHING`. NO
-- projects/datasets repoint and NO NULL-orphan RAISE — those touch A2's columns.

-- (1) one personal account per user without one yet (name = the user's username).
INSERT INTO public.accounts (id, kind, name, personal_user_id)
SELECT gen_random_uuid(), 'personal', u.username, u.id
FROM public.users u
WHERE NOT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.kind = 'personal' AND a.personal_user_id = u.id
);

-- (2) that user as the OWNER member of their personal account.
INSERT INTO public.account_members (account_id, user_id, role)
SELECT a.id, a.personal_user_id, 'owner'
FROM public.accounts a
WHERE a.kind = 'personal' AND a.personal_user_id IS NOT NULL
ON CONFLICT (account_id, user_id) DO NOTHING;

-- == permission grant ====================================================
--
-- Grant `account::read` to the default Users group (Administrators already hold
-- `*`). Gates the switcher list + active-account context (A4). `account::manage`
-- is NOT group-granted — admins hold it via `*`. Idempotent.
UPDATE public.groups
SET permissions = array_append(permissions, 'account::read')
WHERE name = 'Users'
  AND NOT ('account::read' = ANY (permissions));
