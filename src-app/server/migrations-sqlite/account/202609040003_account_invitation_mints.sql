-- account module — the invitation MINT LEDGER (#145, FIX_ROUND-2) —
-- SQLite dialect port (ITEM-10, sqlite-store) of
-- `src/modules/account/migrations/202609040003_account_invitation_mints.sql`.
--
-- WHY a separate ledger (a per-row counter cannot express two windows, and a
-- monotone counter cannot decay — the two failures the Postgres file
-- documents with evidence) and WHY the prune must stay scoped to the acting
-- account: see the Postgres file — the motivation is not reproduced here.
-- The limiter = rate-limit substrate only; nothing but the ceiling reads it
-- and rows older than the longest window are pruned opportunistically at
-- mint time. `account_invitations.resend_count` / `last_resent_at` /
-- `last_resent_by` remain as the invitation's own audit columns and are NO
-- LONGER read by the limiter (the 0002-file comment supersession is
-- recorded in 0002's own header note).
--
-- SQLite port notes (ITEM-10, DEC-8): uuid -> BLOB (id, account_id,
-- actor_user_id, invitation_id — the two audit ids carry NO FK, the
-- Postgres reasoning verbatim); `timestamptz DEFAULT now()` -> TEXT RFC3339
-- UTC with the `strftime` default; `CREATE TABLE IF NOT EXISTS` kept; the
-- PK + account FK inline with the Postgres constraint names
-- (SQLite has no ALTER … ADD CONSTRAINT).
--
-- Construct deltas:
--   * the DROP INDEXes: `DROP INDEX IF EXISTS <name>` with no schema
--     qualifier (SQLite); an index is database-wide unique by name — the
--     `IF EXISTS` matches the Postgres file's `IF EXISTS`;
--   * the `email !~ '[[:cntrl:]]'` CHECK (defence in depth for the SMTP
--     header-injection guard, added here to the STORAGE layer — the
--     Postgres reasoning) has NO SQLite regexp: the port is the ASCII
--     printable-print `email NOT GLOB '*[^ -~]*'` — POSIX `[[:cntrl:]]`
--     covers 0x00–0x1F + 0x7F; the GLOB class scans every byte and refuses
--     a NON-ASCII byte too. Deliberate narrowing, same stance as DEC-11's
--     ASCII-only case folding: the guard's job is refusing header-
--     injection control characters, and the surrounding CHECKs already
--     force a normalized (ASCII) address; a Unicode mailbox is recorded as
--     out of scope here (the same upgrade path DEC-11 names).
--   * the constraint is added by the same REBUILD procedure the Postgres
--     file's `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` requires
--     (SQLite has neither): the table is recreated with the CHECK INLINE
--     (named `account_invitations_email_no_control_check`, the Postgres
--     name) and the three surviving indexes are recreated; the three
--     FIX_ROUND-1 limiter indexes (dropped below) are the ones NOT
--     recreated. Safe: the table has no inbound FKs, no triggers, no seed
--     rows, and nothing inserts into it before this file's position.

CREATE TABLE IF NOT EXISTS account_invitation_mints (
    id            BLOB        NOT NULL,

    -- CASCADE with the account, like the invitations themselves: a mint
    -- record for a deleted tenant bounds nothing.
    account_id    BLOB        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

    -- Who minted. **NULL means platform staff**, exempt from the ceiling;
    -- the ACCOUNT window filters `actor_user_id IS NOT NULL` so a staff
    -- operator's incident work can never exhaust a tenant's own budget (the
    -- Postgres asymmetric-window reasoning).
    --
    -- No FK, for the same reason as `account_invitations.invited_by`: this
    -- must survive its actor, and it is not a live reference.
    actor_user_id BLOB,

    -- Which invitation the token was minted for. No FK: the mint record is
    -- about the ACT, and pruning must never be blocked by, nor cascade into,
    -- the invitation ledger.
    invitation_id BLOB        NOT NULL,

    created_at    TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT account_invitation_mints_pkey PRIMARY KEY (id),
    CONSTRAINT account_invitation_mints_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

-- The two windows the ceiling reads, and the scoped prune. Both lead with
-- their key and then `created_at`, the only column either predicate ranges
-- over. NOTE: there is deliberately no bare `(created_at)` index (the
-- Postgres reasoning — the scoped-prune row-visit order).
CREATE INDEX IF NOT EXISTS idx_account_invitation_mints_actor
    ON account_invitation_mints (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_invitation_mints_account
    ON account_invitation_mints (account_id, created_at DESC);

-- ── cleanup of indexes this branch created for a limiter it then replaced ──

DROP INDEX IF EXISTS idx_account_invitations_resender;
DROP INDEX IF EXISTS idx_account_invitations_account_resent;
DROP INDEX IF EXISTS idx_account_invitations_inviter_created;

-- ── defence in depth for the SMTP header-injection guard ──
-- (see the header note for the CHECK-port mechanics)

CREATE TABLE account_invitations_rebuild (
    id            BLOB        NOT NULL,
    account_id    BLOB        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    email         TEXT        NOT NULL,
    role          TEXT        NOT NULL,
    token_sha256  BLOB        NOT NULL,
    invited_by    BLOB,
    created_at    TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at    TEXT        NOT NULL,
    accepted_at   TEXT,
    accepted_by   BLOB,
    revoked_at    TEXT,
    revoked_by    BLOB,
    resend_count   INTEGER     NOT NULL DEFAULT 0,
    last_resent_at TEXT,
    last_resent_by BLOB,
    CONSTRAINT account_invitations_pkey PRIMARY KEY (id),
    CONSTRAINT account_invitations_role_check
        CHECK (role IN ('owner','admin','member')),
    CONSTRAINT account_invitations_accepted_pair_check
        CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)),
    CONSTRAINT account_invitations_token_len_check
        CHECK (length(token_sha256) = 32),
    -- The storage-layer guard: the address is stored verbatim and is exactly
    -- what the mailer will place in an RFC 5322 header, so the write-path
    -- validator's `~`-pattern guard belongs here too.
    CONSTRAINT account_invitations_email_no_control_check
        CHECK (email NOT GLOB '*[^ -~]*'),
    CONSTRAINT account_invitations_email_normalized_check
        CHECK (email = lower(trim(email))),
    CONSTRAINT account_invitations_email_nonempty_check
        CHECK (email <> ''),
    CONSTRAINT account_invitations_email_len_check
        CHECK (length(email) <= 254),
    CONSTRAINT account_invitations_resend_count_check
        CHECK (resend_count >= 0)
);

INSERT INTO account_invitations_rebuild (id, account_id, email, role, token_sha256,
    invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at,
    revoked_by, resend_count, last_resent_at, last_resent_by)
SELECT id, account_id, email, role, token_sha256,
    invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at,
    revoked_by, resend_count, last_resent_at, last_resent_by
FROM account_invitations;

DROP TABLE account_invitations;

ALTER TABLE account_invitations_rebuild RENAME TO account_invitations;

-- Three survivors recreated (the dropped limiter indexes are NOT). The
-- email-normalized + other CHECKs moved with the rebuild.

CREATE UNIQUE INDEX IF NOT EXISTS uq_account_invitations_live
    ON account_invitations (account_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_account_invitations_token_sha256
    ON account_invitations (token_sha256);

CREATE INDEX IF NOT EXISTS idx_account_invitations_account_created
    ON account_invitations (account_id, created_at DESC);
