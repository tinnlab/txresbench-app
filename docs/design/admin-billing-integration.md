# Admin Billing integration — encrypted Stripe secret config (design)

**Source of intent:** GitHub issue [#30](https://github.com/tinnlab/txresbench/issues/30)
(EPIC: Admin Console — full administrative control … billing …) and the
security-sensitive feature brief for the **Billing integration** admin page.
Sits alongside `docs/design/admin-settings-coverage.md` (#41) and
`docs/design/admin-console-shell.md` (#42): the shell delivers the
`settingsAdminPages` cluster + `useHasPermission` self-hide seam; #41 exposes the
operational tunables; **this item** exposes the ONE knob those two deliberately
left as a 12-factor env secret — the **Stripe API secret key** — as an
admin-configurable value that is **encrypted at rest** and **never returned in
plaintext**.

## Problem

The Stripe secret key (`STRIPE_SECRET_KEY`) is today a 12-factor env secret read
by `billing/client.rs::StripeClient::from_env`. A deployment that wants to
configure or rotate it through the admin UI (rather than a redeploy) has no
surface to do so. A Stripe secret key in the database is a **payment credential**:
storing it in plaintext, echoing it back on read, or leaking it in a log / error /
trace is a Critical security defect. The webhook signing secret
(`STRIPE_WEBHOOK_SECRET`) is the same class of credential.

## The security contract (non-negotiables — lifted VERBATIM as PLAN invariants)

- **INV-1 (encrypt at rest):** the Stripe secret and webhook secret are stored
  **ENCRYPTED at rest** using the SDK primitive
  `txresbench_framework::secret::encrypt_secret(pool, plaintext, storage_key)`
  (pgcrypto `pgp_sym_encrypt` → `bytea`) and read back via `decrypt_secret(...)`.
  The stored column is `bytea` (ciphertext), **NEVER plaintext**. No bespoke
  crypto is invented and the SDK pin is not changed.

- **INV-2 (never return the plaintext):** the GET endpoint returns a **MASKED
  view only** — `configured: bool`, `last4: Option<String>` (last 4 chars),
  `connected: <status>`, and the price-ID mapping (price IDs are NOT secret). Any
  in-memory secret is held in the SDK's `SecretView<T>` wrapper (it refuses to
  serialize plaintext). **NO endpoint, log line, error message, or trace ever
  contains the secret.**

- **INV-3 (storage key from config; compat mode):** a `SecretsConfig {
  storage_key }` (≥32 chars) is wired into `src-app/server/src/config.rs` +
  `config/dev.example.yaml` (a deployment secret like `jwt.secret`). If
  `storage_key` is **UNSET → compat mode**: no DB secret storage; the Stripe
  secret falls back to the `STRIPE_SECRET_KEY` env var **exactly as today**
  (byte-identical behavior for a deployment that never uses the UI).

- **INV-4 (env fallback):** `billing/client.rs` resolves the Stripe secret as:
  DB-stored (decrypt) **if configured**, ELSE the `STRIPE_SECRET_KEY` env var. A
  deployment can configure via UI **OR** stay 12-factor. Any cached Stripe client
  is invalidated/rebuilt on a rotate.

- **INV-5 (test path never leaks):** the Test action decrypts the stored (or a
  just-submitted) key, makes ONE lightweight Stripe API call to validate it, and
  returns `{ok, message}` — **NEVER the key**. A bad key is a clean 4xx, never a
  500 that leaks the key in an error body.

- **INV-6 (authz + saas):** every integration endpoint is `#[cfg(feature =
  "saas")]` and gated on `billing::admin`; a caller lacking `billing::admin`
  (and not `is_admin`) is refused **403** on GET, PUT, and POST. The frontend page
  self-hides on `billing::admin` presence (A10) and is desktop-absent.

## Design

### Storage (`billing_integration` singleton, migration prefix 202608290080)

A single-row table (mirrors `billing_settings`): `stripe_secret_ciphertext bytea`,
`webhook_secret_ciphertext bytea` (both encrypted via the SDK primitive), a
plaintext `price_ids jsonb` mapping (price ids are deployment config, NOT COGS
allowances — the catalog's allowance/policy stays code-defined per
`admin-settings-coverage.md` INV-1), and `updated_by` / `updated_at` audit
columns (the established per-table `*_by` idiom). The last4 shown in the masked
view is derived at read time from the freshly-decrypted plaintext, never stored.

### Secret resolution (compat + env fallback)

`billing/client.rs` gains an async `resolve_secret(pool)`:
1. if `secrets::storage_key()` is set AND the row has `stripe_secret_ciphertext`
   → `decrypt_secret` → use it;
2. else the `STRIPE_SECRET_KEY` env var (today's `from_env`);
3. else unconfigured (the existing clean error).
`StripeClient` is already built **per-request** (`from_env` at each handler call),
so a rotate is picked up on the next request with no cache to invalidate — the
resolver simply replaces the env read. Compat mode (no `storage_key`) skips step 1
entirely, so behavior is byte-identical to today.

### Endpoints (all `#[cfg(feature="saas")]`, gated `billing::admin`)

- `GET  /api/admin/billing/integration` → the MASKED view (never plaintext).
- `PUT  /api/admin/billing/integration` → set/rotate the secret(s) + price
  mapping (encrypt + store; audit). A **blank/absent** secret field means "leave
  unchanged" (a price-only edit does not wipe the stored secret).
- `POST /api/admin/billing/integration/test` → decrypt the stored (or a
  just-submitted) key, make ONE lightweight Stripe call (`GET /v1/balance`) via
  the existing `billing/client.rs` transport, return `{ok, message}`.

### Bootstrapping interaction with the §16 kill-switch

The existing `/api/billing/*` mount rides `BillingConfig::from_env_opt()` (keyed
on the `STRIPE_SECRET_KEY` **env** var). To let a deployment configure the secret
through the UI alone, when `secrets.storage_key` is configured the
`/api/admin/billing/integration` routes mount **independently of that env
kill-switch** (an admin must be able to reach the page to perform the first
config), while the self-serve `/api/billing/*` surface is unchanged in compat
mode. This is recorded as an owner-facing decision (DEC).

### Frontend

A NEW deployment-level **Billing integration** admin page registered in
`settingsAdminPages`, gated `useHasPermission('billing::admin')` (saas-only →
hidden on desktop). Fields render MASKED (`•••• 4242`) with **Rotate** (reveals a
`type="password"` input to type a new secret — a stored secret is NEVER echoed
into an editable field), a **Test connection** action, and a price-mapping editor.
Every mutation is a permissioned `defineAction` (the secret rotate is
`mutating` + `dangerous`), invoked via `SaasApiClient`.
