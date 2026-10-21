import { z } from 'zod'

/**
 * THE CLIENT MIRROR OF THE SERVER'S PASSWORD RULE — REFUSAL, NEVER TRUNCATION.
 *
 * ── Where the numbers come from ────────────────────────────────────────────────────────────
 * `sdk/crates/ziee-auth/src/auth/password.rs::validate_password_strength` is the authority:
 *
 *     if password.len() < MIN_PASSWORD_LENGTH { … }   // MIN_PASSWORD_LENGTH = 8
 *     if password.len() > MAX_PASSWORD_LENGTH { … }   // MAX_PASSWORD_LENGTH = 72
 *
 * and the same pair is re-stated inline by `modules/user/handlers.rs::check_password` and
 * `modules/app/handlers.rs` (setup). The server REJECTS outside that band — it does not clamp,
 * does not truncate, and does not hash a prefix. 72 is bcrypt's input limit, not a product
 * choice: bcrypt ignores everything past the 72nd byte, so accepting a longer secret would mean
 * silently authenticating a prefix.
 *
 * ── The unit is BYTES ──────────────────────────────────────────────────────────────────────
 * Rust's `str::len()` counts UTF-8 BYTES. A DOM `maxLength` counts UTF-16 code units, and
 * `String.length` likewise. The three disagree the moment a passphrase leaves ASCII: "é" is 1
 * unit and 2 bytes; "🙂" is 2 units and 4 bytes. A character-count mirror is therefore wrong in
 * BOTH directions — too permissive for a passphrase with accents or emoji (the client waves
 * through what the server will reject) and, when enforced by truncation, actively destructive.
 * `passwordByteLength` measures what the server measures.
 *
 * ── Why never `maxLength` on a password field ──────────────────────────────────────────────
 * `maxLength` enforces a cap by DISCARDING the overflow. On any other field the user can read
 * what survived; on a masked one they cannot, and the confirm field truncates identically, so
 * the two agree, validation passes, the change succeeds, and the passphrase the user recorded
 * is not the one that was set. The kit therefore makes `maxLength` inexpressible on
 * `PasswordInput`, and `scripts/lint-secret-input-caps.mjs` closes the `Input type="password"`
 * back door. The cap is stated and REFUSED here instead — the interaction the user can act on.
 *
 * A LOGIN or an account-link field takes an EXISTING secret and must carry no cap at all: a
 * password set before this rule (or by another deployment) is still the right answer, and
 * refusing to submit it would lock its owner out of the only screen that could help them.
 * Caps belong on the fields that CHOOSE a new secret.
 */
export const PASSWORD_MIN_BYTES = 8
export const PASSWORD_MAX_BYTES = 72

const utf8 = new TextEncoder()

/** Length in UTF-8 bytes — the unit `validate_password_strength` compares against. */
export function passwordByteLength(value: string): number {
  return utf8.encode(value).length
}

// The messages say BYTES because that is the rule, and then say what a byte is, because most
// people have no reason to know. Saying "characters" would be a smaller lie only until someone
// used an accent — and then the number in the message would not be the number being enforced.
const BYTE_NOTE = 'Most characters count as 1 byte; accented letters and emoji count as more.'
export const PASSWORD_TOO_SHORT =
  `Password must be at least ${PASSWORD_MIN_BYTES} bytes. ${BYTE_NOTE}`
export const PASSWORD_TOO_LONG =
  `Password must be at most ${PASSWORD_MAX_BYTES} bytes — this one is longer, so shorten it. ` +
  BYTE_NOTE
export const PASSWORD_HAS_NUL = 'Password must not contain NUL characters'

/**
 * The one reason string for a candidate NEW password, or `null` when it is acceptable.
 * Returning the sentence rather than a boolean is deliberate: a caller cannot refuse without
 * having the reason in hand.
 */
export function passwordRefusal(value: string): string | null {
  if (value.includes('\0')) return PASSWORD_HAS_NUL
  const bytes = passwordByteLength(value)
  if (bytes < PASSWORD_MIN_BYTES) return PASSWORD_TOO_SHORT
  if (bytes > PASSWORD_MAX_BYTES) return PASSWORD_TOO_LONG
  return null
}

/**
 * Zod field for a NEW password. `superRefine` rather than `.min`/`.max`, because those measure
 * `String.length` (UTF-16 units) and the server measures bytes.
 *
 * @param emptyMessage what to say when the field has not been filled in at all — a different
 *   sentence from "too short", and the one the form should lead with.
 */
export function newPasswordField(emptyMessage: string): z.ZodType<string, string> {
  return z.string().superRefine((value, ctx) => {
    if (value.length === 0) {
      ctx.addIssue({ code: 'custom', message: emptyMessage })
      return
    }
    const refusal = passwordRefusal(value)
    if (refusal) ctx.addIssue({ code: 'custom', message: refusal })
  })
}
