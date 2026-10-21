-- account_member_events — #148 (epic #138). The FIRST general-purpose audit ledger in this
-- repo: before it there was no audit_log / security_event table, no such migration and no
-- structured audit convention. `provenance` is domain-scientific lineage (which job produced
-- which dataset from which inputs and code) and is not this. What is chosen here becomes the
-- pattern, so the rationale is written down rather than left to be re-derived.
--
-- Follows the `credit_grants` precedent (billing/202608280010_billing_credits.sql): an
-- APPEND-ONLY ledger, `account_id` FK cascade, actor ids as plain audit columns with no
-- cross-module FK, a per-account (account_id, created_at DESC) read index, and CHECKs backing
-- the writer so no non-writer insert can land a degenerate row. It deliberately does NOT
-- follow the `accounts.admin_suspended_by/_at/_reason` current-state precedent, which cannot
-- answer "who was in this account in March".
--
-- WHAT A ROW MEANS (#148 DEC-1): a row records a membership mutation that COMMITTED. A
-- REFUSED attempt is not a row. That is not a preference — it is forced by the two properties
-- in this item's title: the write happens inside the mutation's own transaction, and a refusal
-- returns an error before that transaction commits, so any row it wrote is rolled back by the
-- very mechanism that makes the ledger trustworthy. "Append-only + in-transaction" and
-- "records attempts" are mutually exclusive by construction; an attempt log would need a
-- separate out-of-transaction sink with its own retention story, and is deliberately not built
-- here. Read this table as "what happened to this account", never as "who tried what".
--
-- WHAT A ROW MUST NEVER CONTAIN (#148 DEC-14): no invitation token or token hash; no username,
-- display name or any other users-table column (store the id, join for identity, so this never
-- becomes a second permanently-retained copy of the user directory with a different retention
-- story); no IP address, user agent, session id or request body. `target_email` is admitted
-- ONLY where no user id can exist -- an invitation to an address that never became an account
-- -- and the CHECK below enforces that exclusivity so the column cannot drift into a shadow
-- copy of the user directory's email.
--
-- RETENTION (#148 DEC-13): rows are PERMANENT. The one deletion path is the account FK cascade
-- below. The row content is held to ids, an enum and two role names precisely so that
-- "permanent" is a defensible story.
--
-- Prefix 202609040010: above the current global maximum (202609040001, the members-manage
-- migration) and leaving ...0002-...0009 free for a parallel branch. Migrations are per-module
-- and are composed by build.rs into migrations-merged/, version-sorted by FILENAME across ALL
-- modules, so the prefix namespace is global and a duplicate filename panics the build.
-- database.rs checksums the FULL FILE BYTES of every applied migration: once this has run
-- anywhere it is immutable, comments included. Never edit it -- add a new file.
--
-- **This file WAS edited repeatedly while the branch was in review, and that was correct**: the
-- rule binds a migration that has been applied somewhere DURABLE, and until this merges the only
-- databases that have run it are the per-worktree build DB (which build.rs wipes and
-- re-migrates on every build) and the per-test databases (fresh per spawned server). A branch
-- that could not correct its own unmerged migration could not act on a review at all.
-- **Consequence for anyone who ran an EARLIER commit of this branch against a durable database:
-- that database will refuse to boot with a checksum VersionMismatch. Drop it and re-provision.**
-- From the merge onward the rule binds absolutely.

CREATE TABLE account_member_events (
    -- surrogate id; the ledger sorts by created_at, never by insertion order.
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    -- the tenant this event belongs to. FK cascade: the ledger dies with the account, which is
    -- the ONLY sanctioned deletion path (see the append-only triggers below).
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    -- who acted. NULL only for a system action -- enforced by the actor_id_kind CHECK, so
    -- "an unattributable non-system event" is not representable. No FK (the credit_grants
    -- granted_by precedent): the ledger does not own the users table, and an audit row must
    -- outlive a deleted actor rather than block the delete or vanish with it.
    actor_user_id uuid,
    -- Classified by the AUTHORITY used, never by the URL prefix (a prefix is a routing
    -- accident; a capability is a fact):
    --   'user'   = a principal acting with no more authority than their own membership;
    --   'admin'  = a principal acting with the platform-staff capability, wherever it is
    --              checked -- the hole an audit trail most exists to close;
    --   'system' = no human actor is attributable at the layer that observed the event. Two
    --              producers today: the personal-account provisioning hook, and the trigger
    --              below that records a membership ended by the `users` FK cascade.
    -- A staff action MUST be distinguishable from an owner's, and an unattributable one from
    -- both -- that is this column's whole job.
    --
    -- NOTE for any reader of the account-scoped projection: 'system' is NOT a synonym for
    -- "internal". The provisioning seed is internal and is hidden there; a membership that
    -- ENDED without an attributable human is a real event in the tenant and is shown.
    actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'admin', 'system')),
    -- what happened. All eight values are minted now, including the four invitation ones whose
    -- producers land with the invitations item -- so that item needs no second migration
    -- against an append-only table.
    action text NOT NULL CHECK (action IN (
        'invited', 'invite_revoked', 'invite_resent', 'invite_expired',
        'joined', 'role_changed', 'removed', 'left'
    )),
    -- whom it happened to. NULL only for an invitation to an address that has no user yet --
    -- an invitation to somebody already in the directory names them by id instead, and carries
    -- no address (see `exactly_one_target`, and the retention note in the header).
    target_user_id uuid,
    -- the invitation address: TRIMMED by the writer and otherwise stored VERBATIM. Not
    -- lowercased -- the local part is case-sensitive, and this row is append-only, so a lossy
    -- transform here could never be undone. Mutually exclusive with target_user_id (below).
    target_email text,
    -- the roles before and after. BOTH are present on a role change (enforced below); a
    -- removal carries old_role and no new_role; a join carries new_role and no old_role.
    old_role text CHECK (old_role IN ('member', 'admin', 'owner')),
    new_role text CHECK (new_role IN ('member', 'admin', 'owner')),
    -- ties an 'invited' event to the 'joined' that answers it. No FK, deliberately: the
    -- invitations table does not exist yet, and this migration must not depend on it.
    invitation_id uuid,
    -- free text, the suspend-reason precedent. Staff-authored; omitted from the account-scoped
    -- read projection (an operator's internal note is not the reading tenant's business).
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- An unattributable non-system event is not representable. This is the constraint that
    -- makes "who removed this member" answerable for every staff action.
    CONSTRAINT account_member_events_actor_id_kind CHECK (
        (actor_kind = 'system' AND actor_user_id IS NULL)
        OR (actor_kind <> 'system' AND actor_user_id IS NOT NULL)
    ),
    -- EXACTLY ONE of the two identifiers, for EVERY action. Two things at once:
    --   * never BOTH -- once there is a user, the id is the identifier, and that exclusivity
    --     is what stops the email column becoming a permanent duplicate of the directory's;
    --   * never NEITHER -- an event naming no principal at all is not an audit record.
    -- Written with num_nonnulls rather than as a pair of ORs because the pair spells a NAND,
    -- which admits the both-NULL row: an `invited` naming nobody. A blind audit reproduced
    -- exactly that against a live Postgres, and the invitations item is meant to inherit
    -- these CHECKs unchanged, so the degenerate shape would have been baked in.
    CONSTRAINT account_member_events_exactly_one_target CHECK (
        num_nonnulls(target_user_id, target_email) = 1
    ),
    -- ...and a membership event names a USER specifically. `num_nonnulls(...) = 1` says
    -- "exactly one identifier", which is NOT the same claim: without this line a `removed`
    -- or `role_changed` row carrying only an email is accepted. A blind audit reproduced
    -- exactly that after an earlier round replaced this constraint instead of adding to it,
    -- and such rows are additionally INVISIBLE to the partial per-principal index below, so
    -- the "everything that happened to this principal" query would silently miss them.
    CONSTRAINT account_member_events_membership_has_user CHECK (
        action NOT IN ('joined', 'role_changed', 'removed', 'left')
        OR target_user_id IS NOT NULL
    ),
    -- A role change carries BOTH roles or it is not reconstructable.
    CONSTRAINT account_member_events_role_changed_has_both CHECK (
        action <> 'role_changed' OR (old_role IS NOT NULL AND new_role IS NOT NULL)
    ),
    -- NO mirror of `membership_has_user` for the invitation actions, deliberately, and the
    -- reasoning is recorded because a round of review added one and it was WRONG. Forcing
    -- `target_email` on every invitation makes an invite of a user who ALREADY EXISTS
    -- unrecordable by id, and — combined with `exactly_one_target` — compels a permanently
    -- retained copy of that user's directory email: precisely the duplication the retention
    -- decision in this header exists to prevent. An invitation names EITHER an address (there
    -- is no user yet) OR a user id (there is); `exactly_one_target` above already says exactly
    -- that, and it is the whole rule.
    -- A join carries the role it granted and no role before it; a departure carries the role
    -- held and no role after it. BOTH halves, positive and negative: an earlier version stated
    -- only the negative, so a `joined` or `removed` row carrying NEITHER role was accepted
    -- while three prose sites promised one. On an append-only table the schema is the only
    -- place a shape can be refused, so what the prose promises the schema must enforce.
    CONSTRAINT account_member_events_join_role CHECK (
        action <> 'joined' OR (old_role IS NULL AND new_role IS NOT NULL)
    ),
    CONSTRAINT account_member_events_departure_role CHECK (
        action NOT IN ('removed', 'left')
        OR (new_role IS NULL AND old_role IS NOT NULL)
    ),
    -- `left` means the principal ended their OWN membership -- that is the entire distinction
    -- from `removed`, and it is what lets a reader tell a resignation from an eviction. It was
    -- enforced only by the Rust classifier; a row where the two ids differ, or where there is
    -- no actor at all, was storable. The cascade trigger writes `removed`, never `left`, so it
    -- is unaffected.
    --
    -- TWO load-bearing conjuncts and one deliberate belt-and-braces, stated exactly because an
    -- earlier version of this comment got its own arithmetic wrong:
    --   * `actor_kind = 'user'` -- LOAD-BEARING. Staff removing their own membership row acted
    --     with STAFF authority, and which authority was used is the security-relevant fact, so
    --     that is a `removed`. The rule lived only inside the Rust classifier; a caller
    --     building the row directly could write the shape the rule forbids.
    --   * `actor_user_id = target_user_id` -- LOAD-BEARING. The equality itself.
    --   * `actor_user_id IS NOT NULL` -- REDUNDANT TODAY, and kept anyway. It was load-bearing
    --     before the first conjunct existed, because `x = NULL` is NULL rather than FALSE and a
    --     CHECK passes on NULL, so an unattributed `left` was storable. Adding
    --     `actor_kind = 'user'` made it unreachable: `actor_id_kind` above already forces a
    --     non-NULL actor for every kind except 'system'. A blind round proved the redundancy
    --     exhaustively -- a table without this conjunct admits and rejects identical rows. It
    --     stays so that `left_is_self` remains true on its own terms if `actor_id_kind` is ever
    --     relaxed, and this note exists so the next reader is not misled into thinking it is
    --     doing work today.
    CONSTRAINT account_member_events_left_is_self CHECK (
        action <> 'left'
        OR (actor_kind = 'user'
            AND actor_user_id IS NOT NULL
            AND actor_user_id = target_user_id)
    ),
    -- Blank-string audit fields are worse than absent ones: they read as recorded.
    CONSTRAINT account_member_events_reason_nonblank CHECK (
        reason IS NULL OR btrim(reason) <> ''
    ),
    CONSTRAINT account_member_events_email_nonblank CHECK (
        target_email IS NULL OR btrim(target_email) <> ''
    )
);

-- The account-scoped read (both the tenant route and the staff route) filters and sorts by
-- account, newest first.
CREATE INDEX idx_account_member_events_account
    ON account_member_events (account_id, created_at DESC);
-- "everything that ever happened to this principal", across accounts -- the incident question
-- the current-state columns cannot answer.
--
-- HAS NO CONSUMER TODAY, and ships anyway. A blind audit flagged it as write amplification on a
-- permanently-growing table, which is accurate. It is kept because the alternative is worse:
-- this migration runner executes each file inside an implicit transaction, so
-- CREATE INDEX CONCURRENTLY is unavailable, and adding this index later means a BLOCKING index
-- build on an append-only ledger that only ever grows -- most likely during the incident that
-- makes someone want the query. Small constant write cost now, versus a write lock on the audit
-- trail later.
CREATE INDEX idx_account_member_events_target
    ON account_member_events (target_user_id, created_at DESC)
    WHERE target_user_id IS NOT NULL;

-- == APPEND-ONLY, ENFORCED BY THE DATABASE (#148 DEC-2) =======================================
-- A convention that nothing updates this table is not enforcement. A REVOKE was considered and
-- rejected: the application connects as the cluster owner, a role REVOKE does not bind, and
-- changing the runtime role is a deployment decision this migration has no standing to make.
-- A trigger binds EVERY role and EVERY connection, psql included.
--
-- The one exemption is DELETE at pg_trigger_depth() > 1, which is what lets the accounts FK
-- cascade above still work: a cascade deletes the child rows from inside the parent's internal
-- referential-integrity trigger, so our row trigger sees depth 2, while a direct
-- `DELETE FROM account_member_events` sees depth 1.
--
-- HONEST LIMIT, stated rather than claimed away: that exemption is depth-based, not
-- cascade-specific, so a DELETE nested inside ANY trigger is permitted -- as, equally, is a
-- DROP TRIGGER by anyone holding DDL rights on this schema. This enforces the ledger against
-- application code and direct statements. It does not, and cannot, defend against a principal
-- who owns the schema, and no claim beyond that is made.
--
-- Every behavior below was probed against a real Postgres before it was written: direct UPDATE
-- refused, direct DELETE refused, TRUNCATE refused, TRUNCATE ... CASCADE refused, account
-- delete cascades successfully.
-- `SET search_path` on every trigger function in this file, **schema-qualified names in the one
-- that touches relations**, and `pg_temp` pinned LAST. Without the pin a session running with a
-- narrowed or shadowed search_path changes what these triggers do -- a blind audit reproduced
-- BOTH directions against a live database: `SET search_path = ''` made a user deletion FAIL
-- outright, and a decoy `accounts` table earlier in the path made the audit row silently NOT be
-- written. A trigger that enforces a security property must not be reconfigurable by the
-- caller's session.
--
-- **`pg_temp` is why a bare pin is not enough.** When `pg_temp` is not NAMED in the path,
-- Postgres still searches it FIRST for relation names -- so a caller's
-- `CREATE TEMP TABLE accounts` shadows the real one even inside a function declared
-- `SET search_path = pg_catalog, public`. Reproduced against a live database, in both
-- directions.
--
-- The accurate rule, stated precisely because an earlier version of this comment overstated it
-- in BOTH directions and a blind round measured the truth: **either** naming `pg_temp` LAST in
-- the pin **or** schema-qualifying every relation is sufficient on its own (the `SET` already
-- overrides the caller's session; the only gap a bare pin leaves is the implicit `pg_temp`
-- prefix). This file does BOTH, because belt-and-braces costs nothing here and because the next
-- author should not have to re-derive which single measure they are relying on.
CREATE FUNCTION account_member_events_append_only() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        -- The accounts FK cascade (or another trigger). Permitted; see the note above.
        RETURN OLD;
    END IF;
    RAISE EXCEPTION
        'account_member_events is append-only: % is refused (a correction is a NEW row)', TG_OP
        USING ERRCODE = '0A000';
END;
$$;

CREATE TRIGGER account_member_events_append_only_trg
    BEFORE UPDATE OR DELETE ON account_member_events
    FOR EACH ROW EXECUTE FUNCTION account_member_events_append_only();

-- Row triggers do NOT fire on TRUNCATE, so without this statement trigger the whole ledger is
-- one statement away from gone -- including via TRUNCATE accounts CASCADE.
CREATE FUNCTION account_member_events_no_truncate() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'account_member_events is append-only: TRUNCATE is refused'
        USING ERRCODE = '0A000';
END;
$$;

CREATE TRIGGER account_member_events_no_truncate_trg
    BEFORE TRUNCATE ON account_member_events
    FOR EACH STATEMENT EXECUTE FUNCTION account_member_events_no_truncate();

-- == THE HOLE THE APPLICATION CANNOT SEE ======================================================
-- Every membership mutation that goes through the repository is audited. But a membership can
-- also end WITHOUT any application code running at all: `account_members_user_id_fkey` is
-- ON DELETE CASCADE to `users`, so deleting a user silently drops every organization membership
-- they held. A blind audit reproduced this against a real database: the org's ledger kept
-- saying `joined` while `account_members` said the person had never been there. That is worse
-- than a missing row -- it is a ledger that is confidently WRONG about the one question it
-- exists to answer, while looking complete.
--
-- It cannot be closed in the repository, because no repository call happens. It is closed here,
-- at the only layer that observes the cascade.
--
-- Three properties, each probed against a live Postgres before this was written:
--   1. `pg_trigger_depth() > 1` fires ONLY for a cascade-driven delete. `remove_member`'s own
--      DELETE runs at depth 1, so it does NOT double-record.
--   2. The `EXISTS (SELECT 1 FROM accounts ...)` guard is what stops this WEDGING account
--      deletion. When the ACCOUNT is being deleted, its `account_members` rows cascade too --
--      and inserting a child row referencing the just-deleted parent would trip the events FK
--      and abort the whole delete. During that cascade the parent is already gone, so the
--      guard is false and nothing is written; the account's ledger is cascading away anyway.
--   3. A user who owns a personal account AND belongs to an org gets exactly one row: the org
--      membership is recorded, the personal one is not (it dies with its account).
--
-- `actor_kind = 'system'` is the honest classification and its limit is stated rather than
-- glossed: a human almost certainly ordered the user deletion, but that actor is not available
-- at this layer. The row says the membership ENDED and when; it does not claim to say who
-- ordered it. Recording that truthfully is strictly better than a ledger that says nothing.
-- WHY THIS IS `BEFORE` AND NOT `AFTER`, since BEFORE is the riskier phase and the choice is
-- not free: `pg_trigger_depth()` is the ONLY signal that distinguishes a cascade-driven delete
-- from the repository's own, and it is **1 in an AFTER trigger for both cases**. Measured, not
-- assumed -- an instrumented pair of triggers on a live Postgres reported BEFORE/2 and AFTER/1
-- for a cascade, BEFORE/1 and AFTER/1 for a direct delete. So AFTER cannot tell the two apart
-- and would double-record every ordinary removal.
--
-- The residual risk that buys, stated rather than left implicit: a BEFORE trigger records a
-- removal that has not happened yet, so a LATER-firing BEFORE DELETE trigger on this table
-- returning NULL would veto the delete while this row is already written -- a permanent,
-- uncorrectable phantom in an append-only ledger. Triggers fire in NAME order, so only a
-- trigger sorting after `account_members_record_cascade_removal_trg` could do it. There is no
-- such trigger today; adding one is a deliberate act, and this comment is where its author is
-- told what it would break.
--
-- Two further limits worth saying plainly:
--   * `pg_trigger_depth() > 1` is not cascade-SPECIFIC. Any delete of a membership nested
--     inside any trigger writes a permanent `system`/`removed` row, and conversely a delete
--     issued from a plain function at depth 0 records nothing. The FK cascade is the only such
--     path today.
--   * The `EXISTS` probe is an unlocked read followed by an FK-checked insert, i.e. a TOCTOU
--     shape. It is safe here for a reason that is not obvious: the row lock on the
--     `account_members` tuple is already held when this trigger runs, so a concurrent
--     `DELETE FROM accounts` cannot commit inside the window. Raced against a live database
--     and confirmed. That safety comes from the caller's locking, not from this function.
CREATE FUNCTION account_members_record_cascade_removal() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF pg_catalog.pg_trigger_depth() > 1
       AND EXISTS (SELECT 1 FROM public.accounts WHERE id = OLD.account_id) THEN
        -- `OLD.role` crosses from `account_members`' role CHECK into this table's `old_role`
        -- CHECK. The two domains are declared INDEPENDENTLY and coincide today; a future
        -- migration that adds a role to `account_members` without adding it here turns every
        -- user deletion into a hard failure, because this trigger has no exception handler.
        -- Anyone widening one domain must widen the other.
        INSERT INTO public.account_member_events
            (account_id, actor_kind, action, target_user_id, old_role)
        VALUES (OLD.account_id, 'system', 'removed', OLD.user_id, OLD.role);
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER account_members_record_cascade_removal_trg
    BEFORE DELETE ON account_members
    FOR EACH ROW EXECUTE FUNCTION account_members_record_cascade_removal();
