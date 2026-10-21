-- account module — A2 OWNERSHIP REFACTOR (repoint projects/datasets → accounts).
--
-- The behaviour-preserving "step 0" of the accounts/tenancy epic: every
-- project/dataset gains a NOT NULL `account_id` that points at its owner's
-- PERSONAL account (the one A1's `202608040012` baseline back-filled). NOTHING
-- about read/authz behaviour changes here — authz keeps running on `owner_id`
-- (A3 flips it later). `owner_id` is RETAINED, re-scoped in meaning from "the
-- tenant" to "the creating/responsible member within the account" (design §5).
--
-- Sequence follows GitLab's `organization_id` tenant-id backfill (design §14.5):
--   (a) ADD COLUMN nullable + FK (NO ACTION — an account with live projects
--       cannot be dropped out from under them);
--   (b) BACKFILL each row to `accounts.id` where the account is the owner's
--       personal account (idempotent: `WHERE account_id IS NULL`);
--   (c) ZERO-ORPHAN GATE — RAISE if any row is still NULL (AC-INV-8);
--   (d) enforce NOT NULL.
-- All in ONE transaction (sqlx wraps each migration). A single `UPDATE … FROM`
-- per table is correct at CytoAnalyst's scale (design §14.5 / DEC-3); the batched
-- backfill is the recorded scale-up path if a target table ever grows large.
--
-- Ordering: prefix 202608040013 sorts ABOVE A1's `202608040012`, so the personal
-- accounts this backfill JOINs to already exist when this applies (migrations run
-- by global filename prefix, not module order).

-- == (a) add nullable account_id + FK (NO ACTION) ========================

ALTER TABLE public.projects ADD COLUMN account_id uuid;
ALTER TABLE public.datasets ADD COLUMN account_id uuid;

-- NO ACTION FK (the default, no ON DELETE clause): an `accounts` row with live
-- projects/datasets cannot be deleted (design §5). Distinct from the
-- `projects_owner_id_fkey … ON DELETE CASCADE` sibling — the account is the
-- tenant, not a disposable owner link.
ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);
ALTER TABLE ONLY public.datasets
    ADD CONSTRAINT datasets_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

-- == (b) backfill — repoint each row to its owner's personal account =====
--
-- Idempotent via `WHERE account_id IS NULL` (INV-3): a re-apply of these UPDATEs
-- is a no-op. A1's baseline guarantees exactly one personal account per
-- pre-existing user (`uq_accounts_personal_user`), so each owner joins exactly
-- one target (PROV-A1-10 / CONS-A2-3).

UPDATE public.projects p
SET account_id = a.id
FROM public.accounts a
WHERE a.kind = 'personal'
  AND a.personal_user_id = p.owner_id
  AND p.account_id IS NULL;

UPDATE public.datasets d
SET account_id = a.id
FROM public.accounts a
WHERE a.kind = 'personal'
  AND a.personal_user_id = d.owner_id
  AND d.account_id IS NULL;

-- == (c) zero-orphan gate (design §5 step 4 / AC-INV-8) =================
--
-- Fail LOUDLY rather than ship a NULL: if any project/dataset owner has no
-- personal account, abort the whole migration instead of enforcing NOT NULL on
-- a row that has no account.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.projects WHERE account_id IS NULL)
       OR EXISTS (SELECT 1 FROM public.datasets WHERE account_id IS NULL) THEN
        RAISE EXCEPTION 'account backfill left orphaned rows: a project/dataset owner has no personal account (A1 baseline did not run, or a user was created without one)';
    END IF;
END $$;

-- == (d) enforce NOT NULL ===============================================
--
-- Inline `SET NOT NULL` (design §5 / DEC-4). At CytoAnalyst's row counts the
-- full-table scan is trivial; the `CHECK (…) NOT VALID` + `VALIDATE CONSTRAINT`
-- split is the recorded scale-up path.
ALTER TABLE public.projects ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE public.datasets ALTER COLUMN account_id SET NOT NULL;
