-- account module — invitations (#145, epic #138).
--
-- An invitation addresses an EMAIL, not a user. That is not a preference, it is forced
-- by the shipped schema: `account_members.user_id` is `NOT NULL`, carries an FK to
-- `users`, and is half the primary key (202608040012_account_baseline.sql), so an
-- invitation to an address with no user cannot be a row in that table. Since addressing
-- a non-user is the entire point of an invitation, invitations need their own table.
-- (`membership-rescope.md` §7.1 — recorded there so the epic would not re-derive it.)
--
-- WHY THE TOKEN IS HASHED HERE WHEN NOTHING ELSE IN THIS TREE HASHES A TOKEN.
-- `mcp_pairing_codes.code` and `pending_account_links.link_token` both store their token
-- in PLAINTEXT, and that is the house convention. This table deliberately does NOT
-- follow it, and the divergence is recorded HERE so the next author does not "fix" the
-- inconsistency back:
--
--   * a pairing code lives 300 seconds; an invitation lives 7 DAYS by default;
--   * under A3 DEC-12 (#140) account membership is an implicit BULK grant — a redeemed
--     invitation confers at least Viewer on EVERY project, dataset and artifact in the
--     account, and an `owner` invitation confers delete/transfer/share over all of them.
--
-- So for this token, and only this token, a database read IS a tenant-wide grant. The
-- column is `token_sha256 BYTEA` and the plaintext is never written anywhere.
--
-- Precisely where the plaintext exists, because the imprecise version of this sentence
-- was wrong: a token is minted TWICE per invitation's life at minimum. `create_invitation`
-- mints one and stores its hash, but DISCARDS the plaintext unread — it mints
-- unconditionally, before the enumeration branch, so that all four create paths do the
-- same work, and the create response is deliberately uniform and carries nothing. The
-- plaintext an inviter actually uses comes from `POST …/invitations/{id}/resend`, which
-- re-mints and returns it; after that it exists only in their clipboard. So the create-time
-- token is live-but-unknown until the first resend replaces it, which is harmless (nobody
-- holds it) and is the price of the uniform response.
--
-- `sha2` is already an unconditional dependency of the server crate; `hmac` is saas-only,
-- which is why this is a plain SHA-256 of a full-entropy 256-bit token rather than an HMAC
-- (no key management, and none is needed at 256 bits of entropy).
--
-- STATE IS DERIVED FROM TIMESTAMPS, NOT A `status` ENUM. `project_transfers` uses a
-- `status` CHECK admitting only `pending|accepted|declined`, which is exactly why
-- cancellation there had to become a physical DELETE (`project/repository.rs` explains
-- it in situ). Timestamps avoid re-creating that constraint and give free auditability.
-- **Rows are never deleted** — revocation, expiry-supersession and acceptance are all
-- stamps.
--
-- Ordering: prefix 202609040002 sorts directly above 202609040001 (#139), the current
-- global max. Migrations on this tree are PER-MODULE (`modules/<mod>/migrations/`);
-- there is no top-level `src-app/server/migrations`. #148 will add
-- `account_member_events` to this same directory and should take the next free prefix.

CREATE TABLE IF NOT EXISTS public.account_invitations (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- CASCADE: an invitation is meaningless without its tenant, and unlike
    -- `projects.account_id` there is nothing to preserve. (Accounts are never deleted
    -- today, so this is currently unreachable — it is the right answer for when they are.)
    account_id    uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,

    -- Normalized at write time by `invitation_token::normalize_email` (lower + trim).
    -- Stored normalized so the partial unique index below and the accept-time email
    -- binding (#146) compare the same thing the writer compared. The address is echoed
    -- back to the inviter AS TYPED only in the sense that normalization is the identity
    -- for a well-formed address; no separate as-typed column is kept.
    email         text        NOT NULL,

    -- The role the invitation confers, FROZEN at issue. Re-validated at accept against
    -- the escalation guard (#146), never silently re-interpreted.
    role          text        NOT NULL,

    -- SHA-256 of the base64url token. 32 bytes, never NULL, never plaintext.
    token_sha256  bytea       NOT NULL,

    -- DELIBERATELY NO FOREIGN KEY. An invitation must not evaporate because its author's
    -- user row was cascaded away, and nothing in this item requires the inviter to
    -- still hold standing (`membership-rescope.md` §7.5 / D-8: requiring live standing
    -- creates a new stranding class of exactly the kind #178/#201 already document).
    -- In-tree precedent for an FK-less audit actor column: `accounts.admin_suspended_by`,
    -- `compute_meter.account_id`, `storage_meter.account_id`.
    invited_by    uuid,

    created_at    timestamptz NOT NULL DEFAULT now(),

    -- ABSOLUTE, not a TTL — so the TTL policy can change without re-interpreting rows
    -- already written (the `mcp_pairing_codes` posture: TTL computed in Rust from
    -- `InvitationLimits`, absolute timestamp in the column). Expiry is enforced in the
    -- CLAIM PREDICATE, never by a sweeper, so a missing sweeper can never make a stale
    -- invitation acceptable.
    expires_at    timestamptz NOT NULL,

    accepted_at   timestamptz,
    accepted_by   uuid,       -- likewise no FK: audit, not a live reference
    revoked_at    timestamptz,
    revoked_by    uuid,

    -- Resend accounting (FIX_ROUND-1, F1). A resend re-mints a live 256-bit bearer token
    -- and pushes the expiry out; it is an outbound-message operation exactly as create is.
    -- But it UPDATEs an existing row, so a limiter that counts rows by `created_at` — which
    -- is what the first implementation did — grades a resend against a budget it never
    -- spends. Three blind audit angles found that independently: one invitation could be
    -- resent without bound, and once #143's mailer exists that is unbounded outbound mail
    -- from this domain to an attacker-chosen recipient.
    --
    -- These three columns are what a resend spends. `resend_count` is monotone;
    -- `last_resent_at` is what puts the row inside or outside a rate-limit window;
    -- `last_resent_by` is who is charged. See
    -- `AccountRepository::enforce_invitation_mint_budget` for the deliberate (and
    -- conservative) over-count this shape produces and why that is the right direction.
    resend_count   integer     NOT NULL DEFAULT 0,
    last_resent_at timestamptz,
    last_resent_by uuid,       -- no FK, same reason as `invited_by`

    CONSTRAINT account_invitations_role_check
        CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])),
    -- An accepted row must say by whom, and a token must be a real SHA-256. Both are
    -- cheap integrity statements that make a malformed row impossible rather than
    -- merely unlikely.
    CONSTRAINT account_invitations_accepted_pair_check
        CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)),
    CONSTRAINT account_invitations_token_len_check
        CHECK (octet_length(token_sha256) = 32),

    -- The `uq_account_invitations_live` index below indexes `email` DIRECTLY rather than
    -- `lower(email)`, on the premise that the writer already normalized it. These CHECKs
    -- make that premise a DATABASE guarantee instead of an application promise: without
    -- them, a future writer inserting `Alice@x.com` beside `alice@x.com` produces two LIVE
    -- invitations for one address, each with an independently redeemable token, and the
    -- unique index cannot object. `lower()` and `btrim()` are both IMMUTABLE, so this is
    -- expressible as a CHECK; `now()` is not, which is why expiry cannot be in the index
    -- predicate and is handled by the supersede-at-mint step instead.
    CONSTRAINT account_invitations_email_normalized_check
        CHECK (email = lower(btrim(email))),
    CONSTRAINT account_invitations_email_nonempty_check
        CHECK (email <> ''),
    -- The live index is a btree on `(account_id, email)`, whose tuple limit is ~2704
    -- bytes. Without a bound, a multi-kilobyte address makes the INSERT fail with "index
    -- row size exceeds maximum" — a 500, which would break BOTH the declared
    -- `400 INVALID_EMAIL` contract and the uniform-202 enumeration guarantee. 254 is the
    -- RFC 5321 maximum and matches `users.email`'s own `varchar(255)`.
    CONSTRAINT account_invitations_email_len_check
        CHECK (char_length(email) <= 254),
    CONSTRAINT account_invitations_resend_count_check
        CHECK (resend_count >= 0)
);

-- ONE live invitation per (account, address).
--
-- The predicate deliberately does NOT mention expiry: `now()` is not IMMUTABLE and
-- cannot appear in an index predicate at all. Expiry therefore lives in the claim
-- predicate, and the consequence — an EXPIRED but unrevoked row still occupies this
-- slot — is handled explicitly at mint time: `create_invitation` supersedes such a row
-- (stamping `revoked_at`) before inserting, inside the same transaction. See
-- `AccountRepository::create_invitation` and #145 DEC-4. `membership-rescope.md` §13.3
-- recorded this exact question as unresolved; this pair of mechanisms is the answer.
--
-- `email` is already normalized on write, so this indexes the column directly rather
-- than `lower(email)` — indexing an expression the writer does not use is how the two
-- drift apart.
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_invitations_live
    ON public.account_invitations (account_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- The redemption lookup (#146): `WHERE token_sha256 = $1` + the claim predicate. Unique
-- because a 256-bit collision is not a thing that happens, and a UNIQUE index turns a
-- duplicate token — which could only arise from a mint bug — into a loud INSERT failure
-- instead of an ambiguous redemption.
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_invitations_token_sha256
    ON public.account_invitations (token_sha256);

-- The account-scoped list (`GET …/invitations`), newest first.
CREATE INDEX IF NOT EXISTS idx_account_invitations_account_created
    ON public.account_invitations (account_id, created_at DESC);

-- The rate-limit windows: "how many invitations did this ACTOR mint recently" and
-- "…this ACCOUNT". Both are counted over `created_at`, so both want it leading after
-- their key.
CREATE INDEX IF NOT EXISTS idx_account_invitations_inviter_created
    ON public.account_invitations (invited_by, created_at DESC);

-- The resend half of the same windows (FIX_ROUND-1, F1).
CREATE INDEX IF NOT EXISTS idx_account_invitations_resender
    ON public.account_invitations (last_resent_by, last_resent_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_invitations_account_resent
    ON public.account_invitations (account_id, last_resent_at DESC);
