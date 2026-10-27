-- account module — A2 OWNERSHIP REFACTOR (repoint projects/datasets →
-- accounts) — SQLite dialect port (ITEM-10, sqlite-store) of
-- `src/modules/account/migrations/202608040013_ownership_account_id.sql`.
--
-- The behaviour-preserving "step 0" of the accounts/tenancy epic: every
-- project/dataset gains a NOT NULL `account_id` that points at its owner's
-- PERSONAL account (the one A1's `202608040012` baseline back-filled).
-- NOTHING about read/authz behaviour changes here — authz keeps running on
-- `owner_id` (A3 flips it later). `owner_id` is RETAINED, re-scoped in
-- meaning from "the tenant" to "the creating/responsible member within the
-- account" (design §5).
--
-- Sequence follows GitLab's `organization_id` tenant-id backfill (design
-- §14.5): (a) ADD COLUMN nullable + FK (NO ACTION — an account with live
-- projects cannot be dropped out from under them); (b) BACKFILL each row to
-- `accounts.id` where the account is the owner's personal account (idempotent:
-- `WHERE account_id IS NULL`); (c) ZERO-ORPHAN GATE — the migration refuses
-- if any row is still NULL (AC-INV-8); (d) enforce NOT NULL. All in ONE
-- transaction (sqlx wraps each migration).
--
-- SQLite port notes (ITEM-10):
--   * SQLite has no `ALTER TABLE … ADD CONSTRAINT`, no `SET NOT NULL` for an
--     existing column, and an `ADD COLUMN` with a CHECK is validated against
--     EXISTING ROWS at ALTER time (verified: refuses on a populated table,
--     accepts on an empty one, 3.37 + bundled 3.46). Both `projects` and
--     `datasets` cannot have rows when this migration runs — their baselines
--     (202608030003 / 202608030002) sort EARLIER in the same boot-time
--     migrate batch and nothing inserts into them before this file — so
--     step (a) is expressed as ONE `ADD COLUMN` carrying the REFERENCES +
--     CHECK, reaching the PG file's FINAL (d) state directly, with (b) and
--     (c) kept as the identical statements that run against an empty no-op
--     state and the gate DROPPED after it has decided nothing. The PG file's
--     (b)–(d) steps are recorded above for a future populated-table port
--     (the documented scale-up path is the rebuild procedure, not this
--     empty-table form; the rebuild is not used here because both tables
--     carry inbound FKs in this chain).
--   * `ADD COLUMN … REFERENCES` is SQLite-legal (the FK is enforced on DML,
--     NO ACTION on delete — probed); the Postgres constraint names
--     `projects_account_id_fkey` / `datasets_account_id_fkey` are recorded
--     here (SQLite does not name an ADD-COLUMN FK; tooling sees
--     `<table>_<column>_fkey`-style generated names).
--   * the backfill UPDATEs keep the Postgres `UPDATE … FROM` shape — SQLite
--     3.33+ supports it (verified: 3.46 bundled + the 3.37 scratch probe);
--     one dialect note found only by the harness: the UPDATE TARGET's bare
--     alias is rejected (`near "p": syntax error`) — SQLite's UPDATE
--     grammar takes the alias only after `AS`, so the port spells
--     `UPDATE projects AS p …` (the probe: the same statement's `FROM
--     accounts a` side accepts a bare alias).
--   * step (c) has no SQLite procedural `DO … RAISE`; the port expresses the
--     zero-orphan gate as a one-shot CHECK trap table: `INSERT … SELECT 1`
--     over the orphan queries — no orphans ⇒ 0 rows inserted (pass); an
--     orphan ⇒ the first inserted row violates the CHECK ⇒ the statement
--     (and the migration transaction) aborts. The abort names the gate table
--     (`account_backfill_zero_orphan_gate`) rather than the PG message; the
--     message semantics are recorded in the file's header above.
--
-- Ordering: prefix 202608040013 sorts ABOVE A1's `202608040012`, so the
-- personal accounts this backfill JOINs to already exist when this applies
-- (migrations run by global filename prefix, not module order).

-- == (a) add the nullable-later-NOT NULL column + the NO ACTION FK ======

ALTER TABLE projects ADD COLUMN account_id BLOB REFERENCES accounts (id) CHECK (account_id IS NOT NULL);
ALTER TABLE datasets ADD COLUMN account_id BLOB REFERENCES accounts (id) CHECK (account_id IS NOT NULL);

-- == (b) backfill — repoint each row to its owner's personal account =====
--
-- Idempotent via `WHERE account_id IS NULL` (INV-3): a re-apply of these
-- UPDATEs is a no-op. A1's baseline guarantees exactly one personal account
-- per pre-existing user (`uq_accounts_personal_user`), so each owner joins
-- exactly one target. (Empty tables at this point in the chain — see the
-- header note; the statements run and are no-ops.)

UPDATE projects AS p
SET account_id = a.id
FROM accounts a
WHERE a.kind = 'personal'
  AND a.personal_user_id = p.owner_id
  AND p.account_id IS NULL;

UPDATE datasets AS d
SET account_id = a.id
FROM accounts a
WHERE a.kind = 'personal'
  AND a.personal_user_id = d.owner_id
  AND d.account_id IS NULL;

-- == (c) zero-orphan gate (design §5 step 4 / AC-INV-8) =================
--
-- Fail LOUDLY rather than ship a NULL: if any project/dataset owner has no
-- personal account, abort the whole migration instead of keeping a row whose
-- account_id is absent. (See the header note — the CHECK-trap-table port of
-- the Postgres `DO … RAISE EXCEPTION` block.)

CREATE TABLE account_backfill_zero_orphan_gate (probe INTEGER CHECK (probe = -1));

INSERT INTO account_backfill_zero_orphan_gate (probe)
SELECT 1 FROM projects WHERE account_id IS NULL
UNION ALL
SELECT 1 FROM datasets WHERE account_id IS NULL;

DROP TABLE account_backfill_zero_orphan_gate;

-- == (d) enforce NOT NULL ===============================================
-- Reached via the CHECK on the ADD COLUMN (header note): absent is refused
-- on every write; the state is PG's post-(d) state from the column's birth.
