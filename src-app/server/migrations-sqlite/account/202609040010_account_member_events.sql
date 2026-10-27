-- account_member_events — #148 (epic #138) — SQLite dialect port (ITEM-10,
-- sqlite-store) of
-- `src/modules/account/migrations/202609040010_account_member_events.sql`.
--
-- The FIRST general-purpose audit ledger in this repo — every semantic
-- decision (append-only, row content, retention, what a row means, why
-- 'system' is not 'internal', the both-roles/one-target CHECKs, the
-- schema-is-the-only-place prose promises are enforced) is argued in the
-- Postgres file and is NOT reproduced here. This port preserves the DDL
-- semantics: same table, same column ORDER, same CHECK names, same row
-- shapes; the DELIBERATE divergences are the three trigger-mechanic ports
-- below (recorded because a trigger that enforces a security property must
-- be provably equivalent).
--
-- SQLite port notes (ITEM-10, the DEC-8 type map):
--   * uuid -> BLOB (id, account_id, actor_user_id, target_user_id,
--     invitation_id), `timestamptz DEFAULT now()` -> TEXT RFC3339 UTC with
--     the `strftime` default; the two role vocabularies -> `CHECK (x IN
--     (…))`.
--   * `num_nonnulls(target_user_id, target_email) = 1` has no SQLite
--     spelling: the port is the boolean-arithmetic form
--     `(target_user_id IS NOT NULL) + (target_email IS NOT NULL) = 1`
--     (probed: both-NULL and both-set are refused, exactly one passes —
--     the NAND and the empty row are both excluded as the Postgres note
--     requires).
--   * `btrim(x) <> ''` -> `trim(x) <> ''`; the partial per-principal index
--     keeps its `WHERE target_user_id IS NOT NULL` predicate.
--
-- TRIGGER-PORT DIVERGENCES (each probed against the engine the port runs
-- on):
--   1. **Append-only DELETE exemption: the discriminator is the parent
--      row's presence, not `pg_trigger_depth()`** (plan-wins — the same
--      recognized PATH, a different probe). SQLite's FK CASCADE fires the
--      child's row triggers, and inside that trigger the parent row is
--      ALREADY GONE (probed on the bundled engine class: an UPDATE/DELETE
--      trigger on the child, the parent DELETE aborts with the message
--      naming whether the parent is still visible — it is not). So the
--      DELETE trigger refuses every direct delete (the parent exists) and
--      permits the cascade (the parent does not) — the Postgres
--      `pg_trigger_depth() > 1` exemption with the same boundary. The one
--      unreachable-in-operation edge: a direct DELETE of a row whose
--      parent was already removed (possible only with `foreign_keys=OFF`,
--      which the app never uses — DEC-7 pins it ON) is permitted, where
--      Postgres refuses it.
--   2. **The no-TRUNCATE statement trigger is OMITTED: SQLite has no
--      TRUNCATE statement at all** (plan-wins — the attack TRUNCATE
--      CASCADE launched there cannot be expressed; the row-level DELETE
--      trigger covers `DELETE FROM`, and DROP TABLE of the ledger is out
--      of scope on both engines). The Ported file's port note records the
--      omission so the next author does not re-add a trigger that can
--      never fire.
--   3. **The cascade-removal recording moved from an `account_members`
--      trigger to a `users` BEFORE DELETE trigger** (plan-wins — the row
--      semantics are identical, the discriminator is structural). SQLite
--      has no trigger depth, and the two properties Postgres combines
--      (`depth > 1` = cascade, `EXISTS (accounts)` = the account is still
--      alive) cannot both be probed from an `account_members` trigger:
--      a direct `remove_member` delete and a users-cascade delete are
--      indistinguishable there. The `users` BEFORE DELETE trigger fires
--      ONLY for a user deletion (i.e. exactly the memberships that leave
--      the tenant without an attributable human) — it records each
--      membership of the deleted user into the events ledger, joined
--      against the still-existent account (the Postgres `EXISTS` guard)
--      and EXCLUDING the personal account that dies with the user (the
--      Postgres cascade-order property 3, probed there and preserved by
--      the `a.personal_user_id` predicate). A direct membership
--      `remove_member` performs no user delete and records nothing (the
--      repository writes the event in its own transaction — the same
--      no-double-record property Postgres got from depth 1).
--      The naming keeps the trigger recognizable as the port of
--      `account_members_record_cascade_removal_trg`:
--      `users_record_membership_cascade_removal_trg`.
--      Inside the trigger the ledger row is BUILT by SQL (no Rust bind
--      path), so `id` is `randomblob(16)` — the same set-based
--      SQL-side-generation reasoning as the 202608040012 backfill: a
--      16-byte BLOB per DEC-8 (the runtime `Uuid::new_v4()` handling of
--      the column's no-default rule applies to INSERT statements the
--      repository writes, not to trigger-created rows).
--   The rationale the Postgres file spends on `SET search_path` /
--   `pg_temp` / SECURITY INVOKER does not port: SQLite triggers cannot
--   specify a search path, there is no schema-qualification and the
--   trigger's relation references are bound at CREATE time by name within
--   the single database — recorded here so the next author does not
--   "fix" the omission back.

CREATE TABLE account_member_events (
    -- surrogate id; the ledger sorts by created_at, never by insertion
    -- order. App-bound `Uuid::new_v4()` (DEC-12 — no SQL default).
    id BLOB NOT NULL,
    -- the tenant this event belongs to. FK cascade: the ledger dies with
    -- the account, which is the ONLY sanctioned deletion path (see the
    -- append-only triggers below).
    account_id BLOB NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    -- who acted. NULL only for a system action — enforced by the
    -- actor_id_kind CHECK, so "an unattributable non-system event" is not
    -- representable. No FK (the credit_grants granted_by precedent): the
    -- ledger does not own the users table, and an audit row must outlive a
    -- deleted actor.
    actor_user_id BLOB,
    -- Classified by the AUTHORITY used, never by the URL prefix (a prefix
    -- is a routing accident; a capability is a fact):
    --   'user'   = a principal acting with no more authority than their own
    --              membership;
    --   'admin'  = a principal acting with the platform-staff capability,
    --              wherever it is checked — the hole an audit trail most
    --              exists to close;
    --   'system' = no human actor is attributable at the layer that
    --              observed the event. Two producers today: the
    --              personal-account provisioning hook, and the trigger
    --              below that records a membership ended by the `users` FK
    --              cascade.
    -- NOTE: 'system' is NOT a synonym for "internal" (the Postgres note).
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'admin', 'system')),
    -- what happened. All eight values are minted now, including the four
    -- invitation ones — so the invitations item needs no second migration
    -- against an append-only table.
    action TEXT NOT NULL CHECK (action IN (
        'invited', 'invite_revoked', 'invite_resent', 'invite_expired',
        'joined', 'role_changed', 'removed', 'left'
    )),
    -- whom it happened to. NULL only for an invitation to an address that
    -- has no user yet (see `exactly_one_target`, and the retention note in
    -- the Postgres header).
    target_user_id BLOB,
    -- the invitation address: TRIMMED by the writer and otherwise stored
    -- VERBATIM (the Postgres reasoning); mutually exclusive with
    -- target_user_id.
    target_email TEXT,
    -- the roles before and after. BOTH present on a role change (enforced
    -- below); a removal carries old_role and no new_role; a join carries
    -- new_role and no old_role.
    old_role TEXT CHECK (old_role IN ('member', 'admin', 'owner')),
    new_role TEXT CHECK (new_role IN ('member', 'admin', 'owner')),
    -- ties an 'invited' event to the 'joined' that answers it. No FK,
    -- deliberately: the invitations table exists, but the ledger must not
    -- depend on it (the Postgres reasoning — and it keeps the port
    -- independent of 202609040002's file order).
    invitation_id BLOB,
    -- free text, the suspend-reason precedent. Staff-authored; omitted from
    -- the account-scoped read projection.
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

    -- An unattributable non-system event is not representable.
    CONSTRAINT account_member_events_pkey PRIMARY KEY (id),
    CONSTRAINT account_member_events_actor_id_kind CHECK (
        (actor_kind = 'system' AND actor_user_id IS NULL)
        OR (actor_kind <> 'system' AND actor_user_id IS NOT NULL)
    ),
    -- EXACTLY ONE of the two identifiers, for EVERY action (the
    -- Postgres `num_nonnulls` note; see the header port note 1).
    CONSTRAINT account_member_events_exactly_one_target CHECK (
        (target_user_id IS NOT NULL) + (target_email IS NOT NULL) = 1
    ),
    -- ...and a membership event names a USER specifically (the Postgres
    -- both-NULL/email-only-bug note).
    CONSTRAINT account_member_events_membership_has_user CHECK (
        action NOT IN ('joined', 'role_changed', 'removed', 'left')
        OR target_user_id IS NOT NULL
    ),
    -- A role change carries BOTH roles or it is not reconstructable.
    CONSTRAINT account_member_events_role_changed_has_both CHECK (
        action <> 'role_changed' OR (old_role IS NOT NULL AND new_role IS NOT NULL)
    ),
    -- A join carries the role it granted and no role before it; a
    -- departure carries the role held and no role after it (the Postgres
    -- both-halves note — no `target_email` mirror for invitation actions,
    -- with the reasoning recorded in the Postgres file).
    CONSTRAINT account_member_events_join_role CHECK (
        action <> 'joined' OR (old_role IS NULL AND new_role IS NOT NULL)
    ),
    CONSTRAINT account_member_events_departure_role CHECK (
        action NOT IN ('removed', 'left')
        OR (new_role IS NULL AND old_role IS NOT NULL)
    ),
    -- `left` means the principal ended their OWN membership; see the
    -- Postgres file for the load-bearing-conjuncts analysis (the third
    -- conjunct is redundant but kept).
    CONSTRAINT account_member_events_left_is_self CHECK (
        action <> 'left'
        OR (actor_kind = 'user'
            AND actor_user_id IS NOT NULL
            AND actor_user_id = target_user_id)
    ),
    -- Blank-string audit fields are worse than absent ones.
    CONSTRAINT account_member_events_reason_nonblank CHECK (
        reason IS NULL OR trim(reason) <> ''
    ),
    CONSTRAINT account_member_events_email_nonblank CHECK (
        target_email IS NULL OR trim(target_email) <> ''
    )
);

-- The account-scoped read (tenant route + staff route): account, newest
-- first.
CREATE INDEX idx_account_member_events_account
    ON account_member_events (account_id, created_at DESC);
-- "everything that ever happened to this principal", across accounts. Ship-
-- now vs CONCURRENTLY-later reasoning in the Postgres file (SQLite has no
-- CONCURRENTLY; an index build here is non-blocking anyway — in-transaction
-- like every other statement, and the write-lock the Postgres note fears
-- has no SQLite analog the same way).
CREATE INDEX idx_account_member_events_target
    ON account_member_events (target_user_id, created_at DESC)
    WHERE target_user_id IS NOT NULL;

-- == APPEND-ONLY, ENFORCED BY THE DATABASE (#148 DEC-2) ==================
-- (see the header note for the discriminator port)

CREATE TRIGGER account_member_events_append_only_trg
BEFORE UPDATE ON account_member_events
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'account_member_events is append-only: UPDATE is refused (a correction is a NEW row)');
END;

CREATE TRIGGER account_member_events_no_delete_trg
BEFORE DELETE ON account_member_events
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'account_member_events is append-only: DELETE is refused (a correction is a NEW row)')
    WHERE EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id);
END;

-- == THE HOLE THE APPLICATION CANNOT SEE =================================
-- (see the header note for the trigger-move port)

CREATE TRIGGER users_record_membership_cascade_removal_trg
BEFORE DELETE ON users
FOR EACH ROW
BEGIN
    INSERT INTO account_member_events (id, account_id, actor_kind, action, target_user_id, old_role)
    SELECT randomblob(16), m.account_id, 'system', 'removed', m.user_id, m.role
      FROM account_members m
      JOIN accounts a ON a.id = m.account_id
     WHERE m.user_id = OLD.id
       AND (a.personal_user_id IS NULL OR a.personal_user_id <> OLD.id);
END;
