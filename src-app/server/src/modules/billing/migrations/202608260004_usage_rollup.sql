-- usage_rollup — B1 (billing epic) — the per-account, per-period aggregation of the
-- raw compute/storage metering signal into billable units (PROV-B1-1).
--
-- B1 is a DOWNSTREAM READER of the metering tables (BQ-INV-2 / INV-5): the fold job
-- SELECTs T5's `compute_meter`/`storage_meter` rows and writes ONLY this table — it
-- never mutates a meter row. One source of truth (the meters), two readers (billing
-- here + quota B4), design §1.5.
--
-- Exactly-once (BQ-INV-1 / INV-1 / INV-4), the three composed guards of design §2.3:
--   1. meter → one row: T5's `compute_meter.job_id UNIQUE` / append-only storage ledger.
--   2. meter → rollup HIGH-WATER MARK: `last_meter_seen` over `compute_meter.finished_at`
--      — the fold sums only `finished_at > last_meter_seen` and advances the mark, so a
--      raw compute row folded twice adds ONCE. Storage is RECOMPUTED from the full
--      period delta history each run (a stock integral cannot skip deltas), idempotent
--      by construction (DEC-3).
--   3. rollup → Stripe IDENTIFIER: the report step's idempotency `identifier`
--      f(account_id, period_start, resource, last_meter_seen); Stripe dedups on it.
-- `UNIQUE (account_id, period_start)` makes the billing period the rollup idempotency
-- key: a re-run of the fold UPSERTs the SAME row, never a duplicate (INV-1).
--
-- Aggregation shape (INV-3), following Lago's billable-metric vocabulary (design §12):
--   • compute = Lago `SUM` over the period: Σ cpu_secs/3600 → `compute_core_hours`
--     (CPU-class rows), Σ gpu_secs/3600 → `gpu_hours` (GPU-class rows), split on
--     `compute_meter.resource_class`.
--   • storage = Lago `WEIGHTED_SUM` (time-weighted stock): the GB-months integral of
--     `logical_bytes` held over the period, walked in `storage_meter.created_at` order.
--
-- INV-2 (keyed on account_id, never user_id, BQ-INV-3): every column, fold and read
-- resolves its tenant as `accounts.id`.
--
-- FK `account_id → accounts(id) ON DELETE CASCADE`: unlike the METER ledgers (which
-- deliberately carry no FK so they outlive the account), the rollup is a DERIVED
-- per-account artifact — when the account is deleted its rollups go with it (A5
-- resource-lifecycle: a child table gets ON DELETE CASCADE). The `accounts` baseline
-- is cross-epic (CONS-B1-2) but already applied on this tree; the migration tree is
-- scanned by build.rs regardless of the `saas` build flag, so — like B2's billing
-- COLUMNS — this table exists in BOTH builds (empty + inert on desktop, where no
-- rollup loop runs; INV-5 gates the MODULE code, not the schema).
--
-- Prefix 202608260004: above the current server migration max (202608260003 = B2's
-- billing columns; T5 took 001/002). Sorts after accounts + the T5 meter migrations,
-- so `accounts`, `compute_meter` and `storage_meter` all exist when this applies.
-- (BASE.md / DEC per PLAN.)
CREATE TABLE usage_rollup (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    -- the tenant (INV-2). CASCADE: a derived child of the account.
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    -- the billing-period window [period_start, period_end) this row aggregates
    -- (DEC-1). `period_start` is the idempotency anchor.
    period_start timestamptz NOT NULL,
    period_end   timestamptz NOT NULL,

    -- == billable columns (INV-3) ==========================================
    -- Σ cpu_secs/3600 over CPU-class compute_meter rows finishing in the period.
    compute_core_hours double precision NOT NULL DEFAULT 0,
    -- Σ gpu_secs/3600 over GPU-class compute_meter rows finishing in the period.
    gpu_hours          double precision NOT NULL DEFAULT 0,
    -- the time-weighted GB-months integral of logical_bytes held over the period.
    storage_gb_months  double precision NOT NULL DEFAULT 0,
    -- egress GB. Column exists but is NOT populated in v1 (DEC-6 / design §2.4 Q6).
    egress_gb          double precision NOT NULL DEFAULT 0,

    -- == exactly-once bookkeeping (INV-1/INV-4) ============================
    -- MAX(compute_meter.finished_at) counted into this row — informational
    -- ("usage counted through …"). Compute is FULL-RECOMPUTE (a SET over the whole
    -- period, like storage), NOT a high-water-marked incremental sum: a strict-`>`
    -- watermark over a non-unique finished_at drops a boundary-tie / late-in-period
    -- row (exactly-once UNDERCOUNT — blind-audit F1), whereas a period recompute is
    -- idempotent by construction and picks up ties + late arrivals. NULL until the
    -- first compute row folds.
    last_meter_seen timestamptz,

    -- Per-resource REPORTED watermark (the exactly-once REPORT guard, guard 3). The
    -- report step pushes the DELTA (current − reported) to Stripe Billing Meters —
    -- NOT the cumulative figure: cumulative-under-changing-identifiers double-counts
    -- against a SUM-aggregation meter (blind-audit F2). A resource is "dirty" iff its
    -- current rollup figure exceeds its reported_* watermark; on a successful push the
    -- reported_* value advances to what was pushed. This makes the dirty test a value
    -- comparison (not a reported_at flag), which also removes the mark-reported
    -- lost-update race (F3).
    reported_compute_core_hours double precision NOT NULL DEFAULT 0,
    reported_gpu_hours          double precision NOT NULL DEFAULT 0,
    reported_storage_gb_months  double precision NOT NULL DEFAULT 0,
    -- when this row was last reported to Stripe (informational / audit).
    reported_at     timestamptz,
    -- the Stripe idempotency identifier last used to report this row (audit/trace).
    stripe_usage_ref text,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    -- the period IS the idempotency key: one rollup row per (account, period).
    CONSTRAINT uq_usage_rollup_account_period UNIQUE (account_id, period_start)
);

-- The account-scoped read (`GET /api/billing/usage`: WHERE account_id ORDER BY
-- period_start DESC) + the fold's per-(account,period) lookup (coding-guidelines §4
-- index-every-WHERE). The UNIQUE(account_id, period_start) constraint already backs
-- the fold's point lookup; this composite additionally serves the newest-first read.
CREATE INDEX idx_usage_rollup_account_period
    ON usage_rollup (account_id, period_start DESC);
