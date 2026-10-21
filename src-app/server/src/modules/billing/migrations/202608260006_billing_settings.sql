-- B3 (billing webhooks) — the singleton billing-settings row (ITEM-9 / DEC-6).
--
-- `grace_period_days` is the dunning grace window B3 sets on `invoice.payment_failed`
-- (`grace_until = now() + grace_period_days`). It is the mandatory configurable-settings
-- deliverable (DEC-6): admin-configurable via `GET/PUT /api/billing/settings` gated by
-- `billing::manage`, read-at-use, bounds-validated `1..=90` (in the handler AND a DB CHECK).
-- Default 14 (design §5: "a configurable window, recommend ~2 weeks").
--
-- Singleton pattern mirrors `project_settings`: a `singleton boolean PRIMARY KEY` pinned
-- true by a CHECK, so exactly one row exists. Seeded here so a GET before any PUT returns
-- the default.
--
-- INV-5 note: as with 202608260005, this is a plain .sql applied in both builds (a migration
-- cannot be cfg-gated); only the settings ROUTE/handler is saas-gated (cfg-compiled).
CREATE TABLE IF NOT EXISTS public.billing_settings (
    singleton         boolean PRIMARY KEY DEFAULT true,
    grace_period_days integer NOT NULL DEFAULT 14,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT billing_settings_singleton_check CHECK (singleton = true),
    CONSTRAINT billing_settings_grace_bounds CHECK (grace_period_days BETWEEN 1 AND 90)
);

INSERT INTO public.billing_settings (singleton, grace_period_days)
VALUES (true, 14)
ON CONFLICT (singleton) DO NOTHING;
