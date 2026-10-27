-- account module — invitations (#145, epic #138) — SQLite dialect port
-- (ITEM-10, sqlite-store) of
-- `src/modules/account/migrations/202609040002_account_invitations.sql`.
--
-- An invitation addresses an EMAIL, not a user — for the full reasoning
-- (address-a-non-user, hashed token, derived-from-timestamps state, resend
-- accounting) see the Postgres file. KEY SEMANTICS KEPT: the plaintext token
-- is never stored (`token_sha256` BLOB), rows are never deleted (revocation,
-- expiry-supersession and acceptance are stamps), expiry is an absolute
-- timestamp enforced in the claim predicate, and the create response is
-- uniform (the create-time token is live-but-unknown until the first resend).
--
-- SQLite port notes (ITEM-10, the DEC-8 type map):
--   * uuid -> BLOB (id, account_id, invited_by, last_resent_by); bytea ->
--     BLOB (`token_sha256`); `octet_length(token_sha256) = 32` -> `length(
--     token_sha256) = 32` (length() of a BLOB in SQLite is the byte count);
--     `char_length(email) <= 254` -> `length(email) <= 254`;
--     `btrim(email)` -> `trim(email)` (same default whitespace set);
--     `timestamptz NOT NULL DEFAULT now()` -> TEXT RFC3339 UTC with the
--     `strftime` default; boolean/INTEGER for `resend_count`;
--   * `CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS`
--     kept where the Postgres file has them (the ITEM-9 contract; harmless
--     on the fresh sqlite file the same way);
--   * the PK, the four data CHECKs and the three FKs the Postgres file
--     declares inline are inline here with the same names (SQLite has no
--     ALTER … ADD CONSTRAINT);
--   * the partial/live-unique index keeps its exact shape — the predicate
--     omits expiry deliberately (the Postgres reasoning: `now()` is not
--     IMMUTABLE and cannot appear in an index predicate; superseded-at-mint
--     in the repository), and the writer-normalized-email premise is a
--     DATABASE guarantee via the `email = lower(trim(email))` CHECK.

CREATE TABLE IF NOT EXISTS account_invitations (
    id            BLOB        NOT NULL,

    -- CASCADE: an invitation is meaningless without its tenant, and unlike
    -- `projects.account_id` there is nothing to preserve. (Accounts are never
    -- deleted today, so this is currently unreachable — it is the right
    -- answer for when they are.)
    account_id    BLOB        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

    -- Normalized at write time by `invitation_token::normalize_email`
    -- (lower + trim). Stored normalized so the partial unique index below and
    -- the accept-time email binding compare the same thing the writer
    -- compared.
    email         TEXT        NOT NULL,

    -- The role the invitation confers, FROZEN at issue. Re-validated at
    -- accept against the escalation guard, never silently re-interpreted.
    role          TEXT        NOT NULL,

    -- SHA-256 of the base64url token. 32 bytes, never NULL, never plaintext.
    token_sha256  BLOB        NOT NULL,

    -- DELIBERATELY NO FOREIGN KEY (the Postgres reasoning: an invitation
    -- must not evaporate because its author's user row was cascaded away).
    invited_by    BLOB,

    created_at    TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

    -- ABSOLUTE, not a TTL (the mcp_pairing_codes posture: TTL computed in
    -- Rust from `InvitationLimits`, absolute timestamp in the column). Expiry
    -- is enforced in the CLAIM PREDICATE, never by a sweeper.
    expires_at    TEXT        NOT NULL,

    accepted_at   TEXT,
    accepted_by   BLOB,       -- no FK: audit, not a live reference
    revoked_at    TEXT,
    revoked_by    BLOB,

    -- Resend accounting (FIX_ROUND-1, F1 — see the Postgres file for why
    -- the per-row shape needed it; 202609040003 supersedes the limiter half).
    resend_count   INTEGER     NOT NULL DEFAULT 0,
    last_resent_at TEXT,
    last_resent_by BLOB,       -- no FK, same reason as `invited_by`

    CONSTRAINT account_invitations_pkey PRIMARY KEY (id),
    CONSTRAINT account_invitations_role_check
        CHECK (role IN ('owner','admin','member')),
    CONSTRAINT account_invitations_accepted_pair_check
        CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)),
    CONSTRAINT account_invitations_token_len_check
        CHECK (length(token_sha256) = 32),
    -- `lower()` and `trim()` are both IMMUTABLE, so this is CHECK-expressible
    -- (the Postgres `btrim` analog); it is what makes the email-normalized
    -- premise of the unique index a database guarantee (Postgres #145
    -- reasoning verbatim).
    CONSTRAINT account_invitations_email_normalized_check
        CHECK (email = lower(trim(email))),
    CONSTRAINT account_invitations_email_nonempty_check
        CHECK (email <> ''),
    -- 254 is the RFC 5321 maximum and matches `users.email`'s own
    -- `varchar(255)`; the btree tuple bound is the Postgres file's reason.
    CONSTRAINT account_invitations_email_len_check
        CHECK (length(email) <= 254),
    CONSTRAINT account_invitations_resend_count_check
        CHECK (resend_count >= 0)
);

-- ONE live invitation per (account, address). The predicate deliberately
-- does NOT mention expiry (see the header note); the consequence — an
-- EXPIRED but unrevoked row still occupies this slot — is handled at mint
-- time by superseding (stamping `revoked_at`) before inserting.
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_invitations_live
    ON account_invitations (account_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- The redemption lookup: unique because a 256-bit collision is not a thing
-- that happens, and a UNIQUE index turns a duplicate token into a loud
-- INSERT failure instead of an ambiguous redemption.
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_invitations_token_sha256
    ON account_invitations (token_sha256);

-- The account-scoped list (`GET …/invitations`), newest first.
CREATE INDEX IF NOT EXISTS idx_account_invitations_account_created
    ON account_invitations (account_id, created_at DESC);

-- The rate-limit windows ("how many invitations did this ACTOR mint recently"
-- and "…this ACCOUNT"), both counted over `created_at` — see
-- 202609040003, which DROPS the three FIX_ROUND-1 limiter indexes (the
-- limiter reads the mint ledger instead) and keeps these two through the
-- file order.
CREATE INDEX IF NOT EXISTS idx_account_invitations_inviter_created
    ON account_invitations (invited_by, created_at DESC);

-- The resend half of the same windows (FIX_ROUND-1, F1). Dropped by
-- 202609040003 (the limiter is gone; kept here so the file evolution matches
-- the Postgres chain file-for-file).
CREATE INDEX IF NOT EXISTS idx_account_invitations_resender
    ON account_invitations (last_resent_by, last_resent_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_invitations_account_resent
    ON account_invitations (account_id, last_resent_at DESC);
