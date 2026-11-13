/**
 * `safeText` — the UI-side text guard of qa-fixes4 ITEM-1 (results-r3
 * R3-results-2, help-r3's location section, DEC-2): a web demo of the app
 * shows these screens to the public, so no rendered text node may carry an
 * internal host fact.
 *
 * The server's API-boundary sanitiser (`modules/err_sanitiser` in the
 * server crate) is the first line: reason/message fields reach the UI
 * already plain. THIS guard is the second line — it refuses to render the
 * residual patterns the plan pins:
 *
 * - an absolute path of the common roots (`/data/…`, `/home/…`,
 *   `/usr/…`, `/var/…`, `/tmp/…`, `/opt/…`, at a word start — the plan's
 *   own pattern `/(^|\s)\/(data|home|usr|var|tmp|opt)\//`);
 * - the `<app_data>` placeholder.
 *
 * A match logs a console warning in a dev build (the defect is a bug in a
 * producer, not a user event) and returns the generic sentence instead of
 * the text — the screen stays honest and never prints a machine path.
 *
 * Used by the formatters that render provider text (`reason.detail`, a
 * progress `message`, a model-warning detail). The formatters pass the
 * guarded text through, so every txr screen that renders one of those
 * fields inherits the guard; the browser regression test
 * (`tests/gallery-e2e/txr-internal-text.spec.ts`) drives a failed-run
 * fixture with a leaked detail over the real pages.
 *
 * Pure and UI-framework-free on purpose: the txr formatters call it
 * directly (a hook would need a component boundary at every call site).
 */
/** The plan's pattern (case-insensitive): an absolute path of the common roots. */
export const INTERNAL_PATH = /((^|\s)\/(data|home|usr|var|tmp|opt)\/)/i

/** The `<app_data>` placeholder (the dev-machine app-data dir). */
export const INTERNAL_PLACEHOLDER = /<app_data>/i

/** The generic sentence shown instead of a leaked text. */
export const SAFE_TEXT_GENERIC = 'This information is not available'

/**
 * True when `text` carries a pattern nothing user-visible may render.
 */
export function isInternalText(text: string): boolean {
  return INTERNAL_PATH.test(text) || INTERNAL_PLACEHOLDER.test(text)
}

/**
 * Refuse internal text: returns `text` unchanged when clean, else the
 * generic sentence (+ a dev console warning naming the original).
 */
export function safeText(text: string): string {
  if (!isInternalText(text)) return text
  if (import.meta.env?.DEV) {
    console.warn('[safeText] refused to render internal text:', text)
  }
  return SAFE_TEXT_GENERIC
}
