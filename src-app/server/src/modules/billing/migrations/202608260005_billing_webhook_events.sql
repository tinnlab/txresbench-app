-- B3 (billing webhooks) — the webhook idempotency dedupe table (§3.4 / BQ-INV-7 / INV-3).
--
-- Stripe delivers webhooks AT-LEAST-once; the handler dedupes on the Stripe `event.id` so a
-- redelivered event is a no-op. The row is inserted in the SAME transaction as the state
-- change (DEC-5), AFTER dispatch, so a crash mid-flight re-delivers cleanly; and because
-- every dispatch arm derives its TARGET state (never increments), a lost dedupe row is still
-- harmless. Retention: a bounded prune deletes rows older than 90 days (DEC-7) — Stripe
-- never retries beyond ~3 days, so 90d is a generous safety margin.
--
-- Ordering: prefix 202608260005 sorts ABOVE B2's `accounts` ALTER (…003) and B1's
-- `usage_rollup` (…004), so the billing-state columns this module writes already exist.
--
-- INV-5 note: like B2's accounts-columns ALTER, this migration is a plain .sql applied by
-- build.rs in BOTH the saas and desktop/default builds (a migration cannot carry a cargo
-- cfg). Only the billing MODULE CODE (webhook.rs / dunning.rs / the `hmac` usage) is
-- `#[cfg(feature = "saas")]`; the empty dedupe table is harmless on desktop, where no
-- webhook route exists to write it.
CREATE TABLE IF NOT EXISTS public.billing_webhook_events (
    event_id     text PRIMARY KEY,
    event_type   text NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now()
);

-- The retention prune scans by age; index the sweep column.
CREATE INDEX IF NOT EXISTS idx_billing_webhook_events_processed_at
    ON public.billing_webhook_events (processed_at);
