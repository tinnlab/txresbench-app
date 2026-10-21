/**
 * Shared client-side validators.
 *
 * EMAIL_RE — email validation regex used across every form's email field.
 *
 * IMPORTANT: use ONLY bounded, two-sided `{n,m}` quantifiers here — NEVER an
 * open-ended `{n,}`. The Vite production build's minifier (Rolldown/Oxc)
 * corrupts open-ended `{n,}` quantifiers into `{n}` inside JS regex literals,
 * so a source `[A-Za-z]{2,}` ships as `[A-Za-z]{2}` and silently rejects any
 * 3+char TLD (`.com`/`.org`/…). Two-sided ranges have no trailing comma to
 * drop and survive minification intact.
 *
 * Semantics mirror the backend `is_valid_email`
 * (src-app/server/src/modules/app/utils.rs): exactly one `@`, a non-empty local
 * part, a dotted domain, each domain label 1–63 chars of alnum/`-` (not leading
 * or trailing `-`), and an alphabetic TLD of 2–63 chars.
 */
export const EMAIL_RE =
  /^[^\s@]+@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/

/** Returns true when `value` looks like a valid email (see EMAIL_RE). */
export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value)
}
