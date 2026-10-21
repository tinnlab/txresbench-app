-- account module — the invitation MINT LEDGER (#145, FIX_ROUND-2).
--
-- WHY A SECOND TABLE, WHEN FIX_ROUND-1 DELIBERATELY AVOIDED ONE.
--
-- The create/resend ceilings (INV-RL) need to answer "how many invitation tokens has this
-- actor, and this account, brought into existence in the last hour / day". FIX_ROUND-1
-- tried to answer that from the invitation rows themselves — a create contributed its
-- `created_at`, a resend contributed a cumulative `resend_count` gated by a single
-- `last_resent_at`. A blind correctness audit then established, empirically, that the
-- per-row shape cannot express a windowed count and fails in BOTH directions:
--
--   * **Evadable.** `last_resent_by` is overwritten on every resend, so two admins
--     alternating resends of ONE invitation each see the other's id in that column and are
--     charged nothing, forever. The per-actor ceiling was not a ceiling.
--   * **A tenant-wide lockout.** `resend_count` is monotone, so once a single row's count
--     reached the ACCOUNT cap, one resend of that one row refused every create and every
--     resend for the WHOLE account for the rest of the window — re-armable once per window,
--     indefinitely, by one actor pacing themselves. "Over-counting fails closed" was true
--     of the resender and false of everyone else in the tenant.
--
-- Neither is fixable by a cleverer predicate: a per-row counter cannot represent two
-- windows, and a monotone counter cannot decay. A row per MINT can, exactly — one row per
-- token brought into existence, counted by `created_at`, with no approximation, no
-- ratchet, and nothing to overwrite.
--
-- THIS IS NOT AN AUDIT TRAIL, and the distinction is why it may be pruned. #148's
-- `account_member_events` is the audit ledger; `account_invitations.resend_count` /
-- `last_resent_at` / `last_resent_by` remain as the invitation's own audit columns and are
-- NOT read by the limiter any more. This table is rate-limit substrate only: nothing but
-- the ceiling reads it, and rows older than the longest window are meaningless. It is
-- therefore pruned opportunistically at mint time, the `mcp_pairing_codes` posture, so
-- there is no sweeper whose absence could matter.
--
-- **The prune is SCOPED to the acting account** (`AccountRepository::record_invitation_mint`
-- carries the full argument). An unscoped, platform-wide DELETE inside a per-tenant
-- transaction was verified, against a real cluster, to block one tenant's mint on another's
-- and to DEADLOCK two tenants outright — because the same statement has several reachable
-- plans with different row-visit orders, chosen from platform-wide statistics. Do not
-- "simplify" the `account_id = $1` predicate away.
--
-- SUPERSEDES A COMMENT IN 202609040002. That file's `resend_count` block still describes
-- those three columns as what a resend SPENDS and points at an over-counting limiter; as of
-- this migration they are audit-only and the limiter reads this table instead. The 0002
-- file cannot be edited — `database.rs` records that sqlx re-verifies migration checksums at
-- boot — so the correction lives here.

CREATE TABLE IF NOT EXISTS public.account_invitation_mints (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- CASCADE with the account, like the invitations themselves: a mint record for a
    -- deleted tenant bounds nothing.
    account_id    uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,

    -- Who minted. **NULL means platform staff**, who are exempt from the ceiling
    -- (`ActorCeiling::PlatformStaff` — rate-limiting the operator repairing an account is
    -- the wrong trade). Recording the mint anyway keeps the row count honest, and the
    -- ACCOUNT window filters `actor_user_id IS NOT NULL` so a staff operator's incident
    -- work can never exhaust a tenant's own budget — which is exactly the asymmetry the
    -- per-row design introduced and could not express its way out of.
    --
    -- No FK, for the same reason as `account_invitations.invited_by`: this must survive
    -- its actor, and it is not a live reference.
    actor_user_id uuid,

    -- Which invitation the token was minted for. No FK: the mint record is about the ACT,
    -- and pruning this table must never be blocked by, nor cascade into, the invitation
    -- ledger. (An invitation is never deleted, so this is belt and braces.)
    invitation_id uuid        NOT NULL,

    created_at    timestamptz NOT NULL DEFAULT now()
);

-- The two windows the ceiling reads, and the scoped prune. Both lead with their key and
-- then `created_at`, which is the only column either predicate ranges over.
CREATE INDEX IF NOT EXISTS idx_account_invitation_mints_actor
    ON public.account_invitation_mints (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_invitation_mints_account
    ON public.account_invitation_mints (account_id, created_at DESC);
-- NOTE there is deliberately no bare `(created_at)` index. The prune is
-- `WHERE account_id = $1 AND created_at <= …`, which `idx_…_account` already serves; a
-- second, unscoped index on `created_at` alone would only offer the planner a
-- platform-ordered path over a per-tenant delete — which is one of the row-visit orders
-- that produced the verified cross-tenant deadlock before the predicate was scoped.

-- ── cleanup of indexes this branch created for a limiter it then replaced ──
--
-- 202609040002 added three indexes to serve the FIX_ROUND-1 limiter, which counted
-- `account_invitations` rows by `created_at`/`last_resent_at`. That limiter is gone; no
-- query in the tree reads those columns for ordering or filtering any more, so the indexes
-- are pure write amplification on the hottest table invitations own. Dropped here rather
-- than left as litter. If #148's audit read wants an inviter-ordered index it should add
-- the one it actually needs, with its own query to justify it.
DROP INDEX IF EXISTS public.idx_account_invitations_resender;
DROP INDEX IF EXISTS public.idx_account_invitations_account_resent;
DROP INDEX IF EXISTS public.idx_account_invitations_inviter_created;

-- ── defence in depth for the SMTP header-injection guard ──
--
-- `validate_invitation_email` refuses control characters at the write path. Its sibling
-- `normalize_email` — the shorter name, the one re-exported for #146's comparison — does
-- NOT, deliberately: the READER must accept whatever registration already stored. A blind
-- security audit pointed out that the split therefore leaves the injection guard with
-- nothing behind it, and that a future writer reaching for the obvious name would store
-- `a@b.com\r\nBcc: …` with the database's blessing. The address is stored verbatim and is
-- exactly what #143's mailer will place in an RFC 5322 header, so the guard belongs at the
-- storage layer too. `~` on a constant pattern is IMMUTABLE, so this is CHECK-expressible.
ALTER TABLE public.account_invitations
    DROP CONSTRAINT IF EXISTS account_invitations_email_no_control_check;
ALTER TABLE public.account_invitations
    ADD CONSTRAINT account_invitations_email_no_control_check
    CHECK (email !~ '[[:cntrl:]]');
