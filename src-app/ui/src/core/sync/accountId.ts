// Module-level holder for the ACTIVE-ACCOUNT header (`X-Account-Id`), app-side
// (mirrors the SDK's `X-Sync-Connection-Id` holder pattern, but kept in the APP so
// the accounts epic touches no SDK code — the SDK api-client exposes no
// request-header hook, so the app stamps the header via its own fetch/XHR
// interceptor, `installAccountHeader.ts`).
//
// The `Accounts` store's `setActiveAccount(id)` sets this; the interceptor stamps it
// on every same-origin request when set, so the server scopes reads + writes to the
// account the user is acting under. On desktop and for a solo user the holder stays
// `null` → no header → the server defaults to the personal account (invisible tenancy).

let activeAccountId: string | null = null

/** The active account id currently stamped on requests, or `null` (default). */
export const getAccountId = (): string | null => activeAccountId

/** Set (or clear, with `null`) the active-account header the interceptor stamps. */
export const setAccountId = (id: string | null): void => {
  activeAccountId = id
}
