-- Billing integration (#60) — the admin-configurable, ENCRYPTED-at-rest Stripe
-- credential config, promoting the 12-factor `STRIPE_SECRET_KEY` env secret to a
-- singleton DB row an admin can set/rotate through the UI.
--
-- SECURITY: the Stripe secret + webhook signing secret are stored ENCRYPTED as
-- `bytea` ciphertext via the SDK primitive `ziee_framework::secret::encrypt_secret`
-- (pgcrypto `pgp_sym_encrypt`, keyed by `secrets.storage_key`). The plaintext is
-- NEVER stored in a column, NEVER returned by the GET (masked view only), NEVER
-- logged. Read back via `decrypt_secret`. When `secrets.storage_key` is unset the
-- app runs in compat mode: no DB secret storage, env fallback (byte-identical).
--
-- pgcrypto: this is the FIRST `pgp_sym_encrypt` consumer in the app (no prior
-- `CREATE EXTENSION` anywhere — `database.rs`: "CytoAnalyst has no PG extensions
-- yet"), so enable pgcrypto here. `IF NOT EXISTS` is idempotent + safe across a
-- re-migrate; applied in BOTH build profiles (a migration cannot be cfg-gated),
-- only the ROUTE/handler is saas-gated.
--
-- Singleton pattern mirrors `billing_settings` (202608260006): a
-- `singleton boolean PRIMARY KEY` pinned true by a CHECK so exactly one row exists.
-- The price-ID mapping (`price_ids`) is plaintext operator config (Stripe price
-- IDENTIFIERS, NOT the COGS allowances/policy the catalog keeps code-defined).
-- `updated_by`/`updated_at` are the per-table audit idiom.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.billing_integration (
    singleton                 boolean PRIMARY KEY DEFAULT true,
    -- Encrypted (pgp_sym_encrypt) Stripe secret key ciphertext; NULL when unconfigured.
    stripe_secret_ciphertext  bytea,
    -- Encrypted Stripe webhook signing secret ciphertext; NULL when unconfigured.
    webhook_secret_ciphertext bytea,
    -- Plaintext Stripe price-ID overrides (operator config, not secret): a JSON object
    -- keyed by the catalog's price env-var names. Empty object ⇒ use env/defaults.
    price_ids                 jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Audit: the acting admin's user id + last-write time (INV: auditable mutation).
    updated_by                uuid,
    updated_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT billing_integration_singleton_check CHECK (singleton = true)
);

-- Seed the singleton row (unconfigured) so a GET before any PUT returns the masked
-- "not configured" view rather than 404.
INSERT INTO public.billing_integration (singleton, price_ids)
VALUES (true, '{}'::jsonb)
ON CONFLICT (singleton) DO NOTHING;
