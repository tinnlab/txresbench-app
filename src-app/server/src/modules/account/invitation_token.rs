//! #145 — the invitation TOKEN model: mint, hash, compare, and the pure claimability
//! twin of the SQL predicate.
//!
//! Everything in this file is PURE (no DB, no axum), for the reason
//! `member_scope.rs::resolve_account_id_param` and `mcp/pairing.rs::code_is_claimable`
//! are pure: the truth tables that matter here are unit-testable directly, and a pure
//! twin of a SQL predicate is the only way to test that predicate's *rule* rather than
//! its *transcription*.
//!
//! # The token
//!
//! 256 bits from `rand::rngs::OsRng` (the OS CSPRNG), encoded base64url **without
//! padding** so it is safe in the URL fragment the invite link carries. It is
//! transported in a request BODY, never in a path or query — a token in a URL leaks
//! through `Referer`, browser history, proxy access logs and screen shares. The link the
//! inviter copies is a FRONTEND route with the token in the fragment (`/invite#<token>`);
//! fragments are never sent to the server, and the SPA reads it and POSTs it (#146).
//!
//! # It is stored ONLY as a hash, and this diverges from the house convention
//!
//! `mcp_pairing_codes.code` and `pending_account_links.link_token` are stored in
//! plaintext. This one is not, and the migration carries the full argument. The short
//! version: a pairing code lives 300 seconds, an invitation lives 7 days, and under A3
//! DEC-12 a redeemed invitation is a tenant-wide grant — so for this token a database
//! read IS a grant. Do not "fix" the inconsistency; it is deliberate and recorded in two
//! places.
//!
//! **The consequence, stated so it is not rediscovered as a bug (#145 DEC-2):** because
//! only the hash is stored, *the server cannot reproduce a link it has already handed
//! out*. The plaintext exists exactly twice — in the mint, and in the resend response.
//! That is why `POST …/invitations/{id}/resend` is the copy-link channel and why
//! `GET …/invitations` deliberately returns no link. Issue #145 says both "never stored
//! in plaintext" and "the inviter reads pending invites (and their links) from
//! `GET …/invitations`"; those cannot both hold, and putting the link in the create
//! response instead would have made that response non-uniform, which is the exact oracle
//! the same issue forbids.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use rand::TryRngCore as _;
use sha2::{Digest, Sha256};

use txresbench_core::AppError;

/// Token entropy in bytes. 32 bytes = **256 bits**, the ratified requirement.
///
/// Named rather than inline because the number is the security property: at 256 bits a
/// plain SHA-256 needs no HMAC key (there is nothing to brute-force), which is the whole
/// reason this file has no key management in it. Shrinking this silently invalidates
/// that argument, so TEST-1 pins the decoded length.
const TOKEN_BYTES: usize = 32;

/// Length of a SHA-256 digest, in bytes. Mirrored by the migration's
/// `octet_length(token_sha256) = 32` CHECK.
pub const TOKEN_HASH_BYTES: usize = 32;

/// Mint a fresh invitation token: `TOKEN_BYTES` from the OS CSPRNG, base64url-no-pad.
///
/// `OsRng` rather than a seeded/thread RNG: this value is a bearer credential for a
/// tenant-wide grant, so it must come from the operating system's entropy source and
/// must not be reproducible from any process state.
///
/// Returns an error rather than panicking if the OS entropy source fails — a panic here
/// would take down a request thread on a condition the caller can legitimately report as
/// a 500.
pub fn mint_token() -> Result<String, AppError> {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|e| AppError::internal_error(format!("CSPRNG unavailable: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// SHA-256 of a token's UTF-8 bytes — what the `token_sha256` column stores and what the
/// redemption lookup queries by.
///
/// Hashing the ENCODED string (not the raw entropy) is deliberate: the encoded string is
/// what the holder possesses and what arrives on the wire, so hashing it means the
/// server never has to decode attacker-controlled input before looking it up. A
/// malformed token simply hashes to something no row carries.
pub fn token_sha256(token: &str) -> [u8; TOKEN_HASH_BYTES] {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    h.finalize().into()
}

/// Constant-time equality for two stored hashes.
///
/// **Honest scope of this function.** The redemption lookup is `WHERE token_sha256 = $1`
/// — a Postgres `bytea` comparison, which this codebase does not control and which is
/// not constant-time. So this helper does not make the whole path constant-time, and
/// claiming otherwise would be a security claim that outruns its code. What it does is
/// make every comparison *in Rust* constant-time, so that a caller (#146's accept, or a
/// future re-check) that compares a recomputed hash against a fetched one does not
/// introduce a timing signal on top.
///
/// Why the residual is acceptable: the value being compared is a SHA-256 digest, not the
/// token. Learning digest bytes by timing an index probe does not yield a preimage, and
/// the token itself has 256 bits of entropy, so there is nothing to narrow.
///
/// **It has NO production caller in this item, and that is stated rather than implied.**
/// #145 never compares two hashes in Rust — the lookup is a single SQL equality on a unique
/// index — so this exists for #146, which does need a comparator once it holds both a
/// recomputed hash and a fetched one. That is the same posture as
/// `mcp/pairing.rs::code_is_claimable`, which is likewise called only by tests. A reader
/// should not infer that this function is protecting the lookup below; it is not, and a
/// security helper implying a protection it does not provide is exactly what this module
/// polices elsewhere.
pub fn hash_matches(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The maximum stored address length, in bytes.
///
/// 254 is the RFC 5321 maximum for a forward-path address, and it matches `users.email`'s
/// own `varchar(255)`. It is not cosmetic: the live-invitation unique index is a btree on
/// `(account_id, email)`, whose tuple limit is ~2704 bytes, so an unbounded address turns
/// an INSERT into `index row size exceeds maximum` — a **500**, which would break both the
/// declared `400 INVALID_EMAIL` contract and the uniform-202 enumeration guarantee. The
/// migration carries the same bound as a CHECK so the two cannot drift.
pub const MAX_EMAIL_BYTES: usize = 254;

/// Normalize an email address for COMPARISON: `lower(trim(…))`. Nothing else.
///
/// # What the STORAGE-layer CHECKs do and do not guarantee, stated here because prose does
/// not belong in an applied migration
///
/// `202609040002` carries `CHECK (email = lower(btrim(email)))` and says it makes "one live
/// invitation per (account, address)" a DATABASE guarantee rather than an application
/// promise. It does not, quite, and the gap was measured: one-argument `btrim` strips ASCII
/// SPACE only, while `str::trim` strips all Unicode `White_Space`, so a `U+00A0`-padded
/// address satisfies the CHECK and could sit beside its unpadded twin as a second live row.
/// `202609040003` adds `CHECK (email !~ '[[:cntrl:]]')` — verified on this cluster to be
/// exactly Unicode `Cc`, i.e. exactly `char::is_control` — which closes the control-character
/// half but not the whitespace half (U+2000-U+200A, U+2028/2029, U+205F, U+3000 and the rest
/// of Unicode `White_Space` all satisfy the `btrim` CHECK).
///
/// **None of that residue is reachable through any shipped route**, and the qualifier is
/// restored here because it was dropped when this text moved out of the migration:
/// [`validate_invitation_email`] trims and then refuses anything but printable ASCII, and it
/// is the only writer. The gap is precisely in the defence-in-depth layer — what the CHECKs
/// would catch if a FUTURE writer bypassed the validator — not in the shipped behaviour.
///
/// **The remaining half is closed in [`validate_invitation_email`], not in SQL**, by trimming
/// and then requiring the rest to be printable ASCII. That is the right layer for it: a CHECK
/// would have to enumerate, and an enumeration provably does not close this class — a blind
/// audit stored `\u{FEFF}alice@x.com` beside `alice@x.com` through the real route while a
/// five-codepoint denylist was in force, then found fifteen more classes of survivor.
///
/// This is the transform BOTH sides of the accept-time binding apply — #145 to the
/// invited address at write time, #146 to the authenticated user's `users.email` at
/// redemption — which is why it is one function and not two call sites doing
/// `to_lowercase()`.
///
/// **It deliberately does NOT validate**, and that separation is a correction rather than
/// a simplification. An earlier version folded the write-time syntax rules in here, which
/// made the READER fallible on shapes registration accepts: `POST /api/auth/register`
/// stores an address as free text, so a user registered at a single-label domain would
/// have 400'd on their OWN address and could never have redeemed an invitation. The writer
/// wants a strict rule; the reader must accept whatever is already stored. Hence two
/// functions: this one, and [`validate_invitation_email`].
///
/// Errors only on an empty or whitespace-only value, which is not an address on either
/// side.
///
/// # What this deliberately does NOT do, on either side
///
/// No provider-specific canonicalization (`a.b@gmail` vs `ab@gmail`, `+tag` suffixes) — and
/// the reason matters more than the omission. **An email is not an identity here.**
/// `users.email_verified` exists (`txresbench-auth`'s `202607140050_auth_schema.sql`) and is set
/// by OAuth provisioning, but there is **no verification flow for password registration**,
/// and `users_email_key` is a **case-sensitive** UNIQUE index — so two distinct principals
/// can differ only by case and both satisfy the binding. It is therefore *containment
/// against a leaked link reaching the wrong logged-in tab*, not proof of identity, and
/// canonicalizing harder would only make that overclaim more convincing. #146 may consult
/// `email_verified` if it wants a stronger control; #143 owns closing the gap.
///
/// (An earlier version of this comment asserted the column did not exist at all. It does;
/// the claim was wrong, it was the stated justification for not strengthening the binding,
/// and it is corrected here rather than deleted.)
pub fn normalize_email(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::bad_request(
            "INVALID_EMAIL",
            "an invitation must name an email address",
        ));
    }
    Ok(trimmed.to_lowercase())
}

/// The WRITE-side rule: [`normalize_email`], then a deliberately minimal well-formedness
/// check. Used only when an address is being STORED.
///
/// # What is validated, and why exactly this much
///
/// **The address must be printable ASCII, end to end**, which subsumes the two rules this
/// function grew one at a time: no control characters (header injection — `str::trim`
/// removes OUTER whitespace, but an INTERIOR `\r\n` survives it and is exactly what #143's
/// mailer will place in an RFC 5322 header) and nothing invisible (an unrenderable
/// character makes a second, distinct string for the same human-readable address). The
/// block comment in the body carries the evidence for why a category rule replaced an
/// enumeration.
///
/// NOTE `raw.trim()` runs FIRST, so **outer** whitespace is normalized away rather than
/// refused — a padded address is accepted and stored trimmed. The rule applies to what is
/// left after trimming. An earlier version of this doc said "all whitespace anywhere",
/// which this function's own positive test case contradicts.
///
/// Also refused: anything that is not printable ASCII (see the block comment in the body —
/// it is a category rule because an enumeration provably was not one), more or fewer than
/// one `@`, an empty local part, a domain with no dot, and anything over
/// [`MAX_EMAIL_BYTES`]. The dot rule is the one arguably-strict choice: it
/// rejects `user@localhost`, which is valid SMTP but is not an address a human is invited
/// at in a hosted product — and admitting it costs a real check against typos
/// (`a@gmailcom`) that would otherwise be stored, look live, and never be deliverable.
///
/// The length bound is not cosmetic: the live-invitation unique index is a btree on
/// `(account_id, email)`, whose tuple limit is ~2704 bytes, so an unbounded address would
/// eventually turn an INSERT into `index row size exceeds maximum` — a **500**, breaking
/// both the declared `400 INVALID_EMAIL` contract and the uniform-202 enumeration
/// guarantee. The migration carries the same bound as a CHECK so the two cannot drift.
pub fn validate_invitation_email(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    // THE ADDRESS MUST BE ASCII-GRAPHIC, END TO END. That is a category rule, not a list,
    // and the difference is the whole point of this block.
    //
    // Two problems it closes, and the second is why the rule is this broad:
    //
    //   * **Header injection.** `str::trim` strips OUTER whitespace; an INTERIOR `\r\n`
    //     survives it, and this value is stored verbatim and is exactly what #143's mailer
    //     will place in an RFC 5322 `To:` header.
    //   * **Invisible duplicates.** A character that renders as nothing makes
    //     `<invisible>alice@x.com` a DIFFERENT string from `alice@x.com` — a second row
    //     under `uq_account_invitations_live`, with its own redeemable token, for what a
    //     human reads as one address.
    //
    // **The second problem is why an enumeration was abandoned.** A previous revision
    // refused `is_control() || is_whitespace()` plus five named zero-width codepoints, and
    // its comment claimed to be "refusing the class". It was not: a blind audit enumerated
    // `1..=0x10FFFF` against those predicates and found U+00AD SOFT HYPHEN, U+034F, U+061C,
    // U+115F/U+1160, U+180B..U+180F, U+200E/U+200F, U+202A..U+202E, U+2061..U+2064,
    // U+206A..U+206F, U+2800, U+3164, U+FE00..U+FE0F, U+FFA0 and the U+E0020..U+E007F tag
    // block all passing — then demonstrated SEVEN live rows coexisting for one
    // `alice@x.com` against a scratch database carrying the real constraints. Rust's
    // standard library exposes no Unicode-category predicate, so "reject Cf and
    // Default_Ignorable" is not expressible without a new dependency; `is_ascii_graphic`
    // is, and it is a strict superset of every list anyone could have written.
    //
    // **What this deliberately refuses, stated because it is a real limitation.**
    // Internationalized addresses (SMTPUTF8 local parts, IDN domains) are rejected. This
    // product has no mail transport at all (#143), so nothing can deliver to one today;
    // and the right way to accept them later is to punycode/normalize at the boundary and
    // store the ASCII form — not to widen this predicate, which would re-open exactly the
    // invisible-duplicate class above. Whoever adds delivery owns that decision.
    if !trimmed.chars().all(|c| c.is_ascii_graphic()) {
        return Err(AppError::bad_request(
            "INVALID_EMAIL",
            "an email address may contain only printable ASCII characters — no spaces, \
             control characters, or invisible or non-ASCII characters",
        ));
    }
    if trimmed.len() > MAX_EMAIL_BYTES {
        return Err(AppError::bad_request(
            "INVALID_EMAIL",
            "that email address is too long",
        ));
    }
    let mut parts = trimmed.split('@');
    let local = parts.next().unwrap_or("");
    let domain = parts.next().unwrap_or("");
    let shape_ok =
        !local.is_empty() && !domain.is_empty() && parts.next().is_none() && domain.contains('.');
    if !shape_ok {
        return Err(AppError::bad_request(
            "INVALID_EMAIL",
            "that does not look like an email address",
        ));
    }
    // No post-lowercase length re-check. An earlier version had one, justified by
    // "`to_lowercase` can (for a few scripts) change a string's length" — true in general,
    // and UNREACHABLE here since the ASCII-graphic gate above: an all-ASCII string's
    // lowercase form has the same byte length, and the bound was already checked. A guard
    // standing behind a stronger one, with a comment asserting it fires, is the same defect
    // class this file has removed twice; it is deleted rather than re-worded.
    Ok(normalize_email(raw)?)
}

/// The PURE twin of the claim predicate: is this invitation redeemable *now*?
///
/// An invitation is claimable only when it has not been accepted, has not been revoked,
/// and has not expired. `expires_at > now` is **strict** — the boundary instant itself is
/// expired — matching `mcp/pairing.rs::code_is_claimable`, whose own boundary test pins
/// the same choice.
///
/// This exists for the reason `code_is_claimable` and `initiator_still_owner_locked`
/// exist: the authoritative predicate lives in SQL, where it is enforced atomically, and
/// a pure twin is the only way to unit-test the RULE. The two must be kept in step —
/// `AccountRepository::find_pending_invitation_by_token_hash` carries the SQL and names
/// this function in its doc so a reader of either finds the other.
pub fn invitation_is_claimable(
    accepted_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> bool {
    accepted_at.is_none() && revoked_at.is_none() && expires_at > now
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use std::collections::HashSet;

    // TEST-1 [covers: ITEM-3, ITEM-16] — the token really carries 256 bits and is really
    // URL-fragment-safe.
    //
    // A mutation that shortens `TOKEN_BYTES`, or that swaps `URL_SAFE_NO_PAD` for the
    // standard alphabet, goes red here. The alphabet assertion is not cosmetic: `+` and
    // `/` and `=` all have to be percent-encoded in a URL, and a link that silently
    // re-encodes differs from the token the server hashed.
    #[test]
    fn mint_token_is_256_bits_of_url_safe_entropy() {
        let t = mint_token().expect("mint");
        let decoded = URL_SAFE_NO_PAD.decode(&t).expect("token decodes as base64url");
        assert_eq!(decoded.len(), 32, "256 bits, not fewer: {t}");

        for bad in ['+', '/', '='] {
            assert!(
                !t.contains(bad),
                "the token must be URL-fragment-safe (no {bad:?}): {t}"
            );
        }

        // Distinctness over many mints — a constant or a low-entropy source shows up
        // immediately. (This is a smoke test for "is it random at all", not a statistical
        // test; the entropy guarantee is `OsRng`'s.)
        let mut seen = HashSet::new();
        for _ in 0..1000 {
            assert!(
                seen.insert(mint_token().expect("mint")),
                "two mints collided — the token source is not a CSPRNG"
            );
        }
    }

    // TEST-2 [covers: ITEM-3, ITEM-16] — `token_sha256` is a real, untruncated SHA-256,
    // and `hash_matches` is a real comparator.
    //
    // Pinned against the PUBLISHED SHA-256("abc") vector rather than against the
    // function's own output, so a mutation that swaps the digest, truncates it, or
    // double-hashes cannot satisfy the test by being self-consistent.
    #[test]
    fn token_sha256_is_the_published_digest_and_hash_matches_compares_all_bytes() {
        let want =
            hex::decode("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
                .expect("known vector");
        assert_eq!(
            token_sha256("abc").to_vec(),
            want,
            "must be a plain, untruncated SHA-256 of the token's UTF-8 bytes"
        );

        assert_eq!(token_sha256("abc"), token_sha256("abc"), "deterministic");
        assert_ne!(
            token_sha256("abc"),
            token_sha256("abd"),
            "different tokens hash differently"
        );

        // The comparator: equal, length-mismatched, and equal-prefix/different-suffix —
        // the last is the case an early-return implementation gets wrong.
        let a = token_sha256("abc");
        assert!(hash_matches(&a, &a));
        assert!(!hash_matches(&a, &a[..31]), "length mismatch is not a match");
        let mut b = a;
        b[31] ^= 0x01;
        assert!(
            !hash_matches(&a, &b),
            "a difference in the LAST byte must still be caught"
        );
        let mut c = a;
        c[0] ^= 0x01;
        assert!(!hash_matches(&a, &c), "and in the first");
    }

    // TEST-3 [covers: ITEM-3, ITEM-16] — the claimability truth table, and the boundary.
    //
    // This is the pure twin of the SQL claim predicate in
    // `find_pending_invitation_by_token_hash`. Each of the three killers is asserted
    // ALONE, so a mutation that drops any one clause from either side goes red.
    #[test]
    fn invitation_is_claimable_truth_table() {
        let now = Utc::now();
        let later = now + Duration::days(1);
        let earlier = now - Duration::days(1);

        assert!(
            invitation_is_claimable(None, None, later, now),
            "pending, unrevoked, unexpired ⇒ claimable"
        );

        assert!(
            !invitation_is_claimable(Some(earlier), None, later, now),
            "already accepted ⇒ NOT claimable (single-use)"
        );
        assert!(
            !invitation_is_claimable(None, Some(earlier), later, now),
            "revoked ⇒ NOT claimable"
        );
        assert!(
            !invitation_is_claimable(None, None, earlier, now),
            "expired ⇒ NOT claimable"
        );

        // The boundary instant is EXPIRED — strict `>`, matching `code_is_claimable`.
        assert!(
            !invitation_is_claimable(None, None, now, now),
            "expires_at == now is expired, not claimable (strict >)"
        );
        assert!(
            invitation_is_claimable(None, None, now + Duration::nanoseconds(1), now),
            "one instant later is claimable — the boundary is exactly at `now`"
        );

        // And every combination of killers stays refused.
        assert!(!invitation_is_claimable(
            Some(earlier),
            Some(earlier),
            earlier,
            now
        ));
    }

    // TEST-4 [covers: ITEM-3, ITEM-16] — normalization is the binding #146 re-checks,
    // and (FIX_ROUND-1, F4) the validation that keeps a CRLF payload out of the table.
    #[test]
    fn normalize_email_lowercases_trims_and_is_idempotent() {
        assert_eq!(
            normalize_email("  A.B+tag@Ex.COM ").unwrap(),
            "a.b+tag@ex.com",
            "lowercased and trimmed — and the INTERIOR is untouched, `+tag` included"
        );
        assert_eq!(
            normalize_email("\t\nUser@Example.org\r\n").unwrap(),
            "user@example.org",
            "tabs and newlines are whitespace too"
        );

        let once = normalize_email(" Mixed@Case.io ").unwrap();
        assert_eq!(
            normalize_email(&once).unwrap(),
            once,
            "idempotent — re-normalizing a stored address must not change it, or the \
             accept-time comparison drifts from what was written"
        );

        for blank in ["", "   ", "\t\n"] {
            let err = normalize_email(blank).unwrap_err();
            assert_eq!(err.status_code(), 400, "blank address is a 400: {blank:?}");
            assert_eq!(validate_invitation_email(blank).unwrap_err().status_code(), 400);
        }

        // ── the READ side must accept whatever registration already stored ──
        //
        // This is the split's whole point (FIX_ROUND-2): `POST /api/auth/register` takes an
        // address as free text, so `users.email` can hold shapes the WRITE rule refuses. If
        // #146 normalized with the strict rule it would 400 on the invitee's OWN address
        // and they could never redeem anything.
        for stored in ["bob@localhost", "weird@@notreally", "no-at-sign", "x@y"] {
            assert!(
                normalize_email(stored).is_ok(),
                "the reader must not reject an address registration accepted: {stored:?}"
            );
            assert!(
                validate_invitation_email(stored).is_err(),
                "…while the WRITER still refuses it: {stored:?}"
            );
        }

        // ── the header-injection guard (FIX_ROUND-1, F4) ──
        //
        // `trim()` strips OUTER whitespace; an INTERIOR CRLF survives it, and this value is
        // stored verbatim and is exactly what #143's mailer will put in a `To:` header.
        // Each of these is a real SMTP-header-injection payload, and each must be a 400 —
        // not a 500, and above all not a stored row.
        // NOTE every payload here has EXACTLY ONE `@`. That is deliberate: a payload like
        // `a@b.com\r\nBcc: victim@x.com` carries a second `@` and is refused by the SHAPE
        // rule, so it would pass this test with the ASCII-graphic guard deleted — which is
        // precisely the confound a blind tests-quality audit found in the integration twin
        // of this test.
        //
        // The INVISIBLE arms below are the ones an enumeration got wrong. A previous
        // revision refused `is_control || is_whitespace` plus five named zero-width
        // codepoints; a blind audit enumerated all of Unicode against those predicates and
        // demonstrated SEVEN live rows coexisting for one `alice@x.com`. U+00AD and U+200E
        // are two of the survivors and are here for that reason — they would pass every
        // predicate that list contained.
        for evil in [
            "a@b.com\r\nBcc-header-only",
            "a@b.com\nX-Injected: yes",
            "a@b.com\rSubject: spam",
            "a\u{0}b@c.com",
            "a@b\u{7f}.com",
            // Interior whitespace, and the NON-BREAKING space specifically: `str::trim`
            // removes it at the EDGES, so an outer one is silently normalized away — but an
            // interior one is not, and a leading one would satisfy the migration's
            // `btrim`-based CHECK (one-argument `btrim` strips ASCII space only).
            "a b@c.com",
            "a\u{00A0}b@c.com",
            // Zero-width: neither whitespace nor control, so these passed EVERY guard and
            // could sit beside the same address as a second LIVE invitation.
            "\u{FEFF}alice@x.com",
            "al\u{200B}ice@x.com",
            "alice\u{2060}@x.com",
            "\u{00AD}alice@x.com",
            "ali\u{200E}ce@x.com",
            "alice\u{180E}@x.com",
            "alice\u{FE0F}@x.com",
            "ali\u{2800}ce@x.com",
            // …and non-ASCII generally: an internationalized address is refused, which is a
            // stated limitation rather than an accident (see the body comment).
            "josé@example.com",
            "alice@exämple.com",
        ] {
            let err = validate_invitation_email(evil).unwrap_err();
            assert_eq!(
                err.status_code(),
                400,
                "a control character anywhere is refused: {evil:?}"
            );
        }

        // ── shape, minimally ──
        for bad in ["nobody", "@b.com", "a@", "a@b@c.com", "a@bcom"] {
            assert_eq!(
                validate_invitation_email(bad).unwrap_err().status_code(),
                400,
                "malformed address is a 400: {bad:?}"
            );
        }

        // ── the length bound, which keeps a btree-tuple overflow from becoming a 500 ──
        let too_long = format!("{}@example.com", "a".repeat(MAX_EMAIL_BYTES));
        assert_eq!(
            validate_invitation_email(&too_long).unwrap_err().status_code(),
            400,
            "an over-long address is a 400 here, not an 'index row size exceeds maximum' \
             500 from the unique index"
        );
        // `"@example.com"` is 12 bytes, so the local part gets the remaining budget. (The
        // first version of this line said 13 and produced a 253-byte address — the
        // boundary assertion below is what caught it, which is exactly why the boundary is
        // asserted by CONSTRUCTION rather than by a hardcoded string.)
        let at_limit = format!("{}@example.com", "a".repeat(MAX_EMAIL_BYTES - 12));
        assert_eq!(at_limit.len(), MAX_EMAIL_BYTES);
        assert!(
            validate_invitation_email(&at_limit).is_ok(),
            "…and the boundary itself is ACCEPTED, so the bound is not off by one"
        );

        // ── and a perfectly ordinary address with a plus tag and dots still passes ──
        assert!(validate_invitation_email("first.last+tag@sub.example.co.uk").is_ok());
    }
}
