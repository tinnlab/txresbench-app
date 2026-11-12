-- account module — BASELINE (A1 of the accounts/tenancy epic) — SQLite
-- dialect port (ITEM-10, sqlite-store) of
-- `src/modules/account/migrations/202608040012_account_baseline.sql`.
--
-- Creates the account graph the whole epic keys on: `accounts` (personal/org
-- tenancy units) + `account_members` (the (account, user, role) membership
-- edge), the role + kind vocabulary (as CHECK constraints), an idempotent
-- backfill giving every pre-existing user exactly one personal account +
-- owner membership, and the `account::read` grant to the Users group.
--
-- Scope boundary (issue #14 / DEC-3): A1 does NOT touch ownership — it adds NO
-- `projects.account_id` / `datasets.account_id` column and NO projects/datasets
-- repoint (that is A2). Only the account graph + its own backfill live here.
-- (The direct child of this file in the Postgres chain is
-- 202608040013_ownership_account_id.sql, which repairs that.)

-- SQLite port notes (ITEM-10, the DEC-8 type map + DEC-12 port rules):
--   * uuid -> BLOB (16 raw bytes; sqlx's sqlite `Uuid` mapping), boolean ->
--     INTEGER 0/1, `timestamp with time zone DEFAULT now()` -> TEXT RFC3339
--     UTC with `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, no `public.` prefix,
--     no `::` casts, `USING btree` dropped.
--   * SQLite has no `ALTER TABLE … ADD CONSTRAINT`, so the PKs, CHECKs and
--     FKs the Postgres file adds by ALTER are declared INLINE with the SAME
--     constraint names (the ITEM-7/8/9 convention). The FK parents (`users`,
--     the SDK auth schema 202607140050) sort before this file.
--   * the vocabulary CHECKs `kind IN (…)` / `role IN (…)` are the SQLite
--     spelling of `kind = ANY (ARRAY[…])` (the `object_store_migration`
--     phase-Check port precedent); `(kind = 'personal') =
--     (personal_user_id IS NOT NULL)` keeps the Postgres boolean-equality
--     CHECK verbatim (SQLite evaluates both sides to 0/1).
--   * the id columns carry NO SQL default (DEC-12): the runtime binds
--     `Uuid::new_v4()`. The migration's own backfill cannot bind per row
--     (sqlx migrations execute plain SQL — no app-side values), so the
--     SET-BASED backfill uses SQLite's `randomblob(16)` — a 16-byte BLOB,
--     the DEC-8 storage form — instead of `gen_random_uuid()`. Note it does
--     not set the RFC 4122 version/variant bits (an opaque-Uuid consumer
--     cannot tell; the fresh-file chain has zero users at migration time, so
--     the backfill path is the pre-existing-user case by definition).
--   * the two partial indexes keep their exact shapes: `uq_accounts_personal_user`
--     (one personal account per user — the `ensure_personal_account` ON
--     CONFLICT target) and `idx_account_members_user`.

-- Ordering: prefix 202608040012 sorts ABOVE the app's current max
-- (202608040011) and ABOVE the txresbench-auth schema+seed, so `users` + the
-- `Users` group already exist when this applies.
-- CONSEQUENCE (unchanged from the Postgres file): a database created before
-- the squash MUST BE RECREATED — see the "SQUASHED BASELINE" section of
-- `src/database.rs`.

-- == tables ==============================================================

-- The tenancy unit every downstream concern keys on. `kind` is the
-- personal/org discriminator (DEC-1, a text CHECK not a boolean, for
-- extensibility); `personal_user_id` is the owning user for a personal
-- account (NULL for an org), and `accounts_personal_has_user` ties the two
-- together (a personal account MUST have a user; an org MUST NOT).
CREATE TABLE accounts (
    id BLOB NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    personal_user_id BLOB,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT accounts_pkey PRIMARY KEY (id),
    CONSTRAINT accounts_kind_check CHECK (kind IN ('personal','organization')),
    CONSTRAINT accounts_personal_has_user CHECK ((kind = 'personal') = (personal_user_id IS NOT NULL)),
    CONSTRAINT accounts_personal_user_id_fkey FOREIGN KEY (personal_user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- The (account, user) membership edge with its coarse account role. Composite
-- PK is the one-membership-per-(account,user) constraint (DEC / Cal.com
-- precedent).
CREATE TABLE account_members (
    account_id BLOB NOT NULL,
    user_id BLOB NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT account_members_pkey PRIMARY KEY (account_id, user_id),
    CONSTRAINT account_members_role_check CHECK (role IN ('owner','admin','member')),
    CONSTRAINT account_members_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
    CONSTRAINT account_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- == indexes =============================================================

-- One personal account per user, enforced by the DATABASE (DEC-2) — the
-- `ensure_personal_account` ON CONFLICT target + the one-personal-per-user
-- invariant (INV-1). Partial so orgs (personal_user_id IS NULL) are
-- unconstrained.
CREATE UNIQUE INDEX uq_accounts_personal_user ON accounts (personal_user_id) WHERE (kind = 'personal');

-- "which accounts is this user in" (the switcher list + audience source).
CREATE INDEX idx_account_members_user ON account_members (user_id);

-- == data backfill (idempotent) ==========================================
--
-- Give every EXISTING user exactly one personal account + an owner membership
-- (PROV-A1-10). Idempotent (INV-2): re-running is a no-op via `WHERE NOT EXISTS`
-- (guarded by uq_accounts_personal_user) + `ON CONFLICT DO NOTHING`. NO
-- projects/datasets repoint and NO NULL-orphan RAISE — those touch A2's
-- columns. The fresh-file chain has no users when this runs; the backfill is
-- the pre-existing-user case (see the header note on `randomblob(16)`).

-- (1) one personal account per user without one yet (name = the user's username).
INSERT INTO accounts (id, kind, name, personal_user_id)
SELECT randomblob(16), 'personal', u.username, u.id
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.kind = 'personal' AND a.personal_user_id = u.id
);

-- (2) that user as the OWNER member of their personal account.
INSERT INTO account_members (account_id, user_id, role)
SELECT a.id, a.personal_user_id, 'owner'
FROM accounts a
WHERE a.kind = 'personal' AND a.personal_user_id IS NOT NULL
ON CONFLICT (account_id, user_id) DO NOTHING;

-- == permission grant ====================================================
--
-- Grant `account::read` to the default Users group (Administrators already
-- hold `*`). Gates the switcher list + active-account context (A4).
-- `account::manage` is NOT group-granted — admins hold it via `*`. Idempotent
-- (the JSON1 port of `array_append` + `NOT (p = ANY (permissions))`, DEC-8).
UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'account::read')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'account::read');
