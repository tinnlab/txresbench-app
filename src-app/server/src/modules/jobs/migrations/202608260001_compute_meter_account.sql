-- compute_meter — T5 account-keying (epic compute-storage, T5 / PROV-compute-metering-1).
--
-- T2/T3 shipped the raw per-job compute signal keyed by job_id + project_id. T5 turns it into
-- the ACCOUNT-keyed, exactly-once raw ledger that billing's usage-rollup (B1) folds. B1 binds
-- the SHARPENED cross-epic contract PROV-compute-metering-1, which requires these columns:
--   account_id     — the tenant, resolved as account_of(project|dataset) at FINALIZE (§9 / DEC-2).
--                    NULLABLE: a scope-less job (no project/dataset) or an unresolvable account
--                    lands NULL rather than failing the finalize (fail-safe, DEC-1). B1 folds
--                    only rows with a resolvable account.
--   resource_class — the run's class string ("cpu-sandbox", …); B1 splits CPU-class seconds ->
--                    core-hours vs GPU-class -> gpu-hours on this value (billing §2.2 / DEC-8).
--   finished_at    — the run's terminal time; MONOTONE, the high-water mark B1's fold advances
--                    (usage_rollup.last_meter_seen over compute_meter.finished_at, billing §2.3).
--
-- job_id stays the PRIMARY KEY (=> UNIQUE) — the exactly-once natural key is UNTOUCHED (INV-1):
-- the LIVE finalize and a BOOT re-finalize of the same job still collapse via
-- INSERT ... ON CONFLICT (job_id) DO NOTHING. Deliberately NO foreign key on account_id: this
-- is a metering LEDGER that must OUTLIVE the account it accounts for — an ON DELETE cascade
-- would erase the very rows B1's rollup needs (DEC-3, mirroring the shipped no-FK rationale).
--
-- Prefix 202608260001: above the true server migration max (202608240003 = drafts) per the
-- migration rule (sort above the max, NOT above the meter block) — DEC-7 / BASE.md.
ALTER TABLE compute_meter ADD COLUMN account_id     UUID;
ALTER TABLE compute_meter ADD COLUMN resource_class TEXT;
ALTER TABLE compute_meter ADD COLUMN finished_at    TIMESTAMPTZ;

-- The (account_id, finished_at) index B1's per-account, time-windowed fold filters on
-- (design §8 verbatim; coding-guidelines §4 index-every-WHERE). DESC to match the sibling
-- project index and the fold's newest-first high-water scan.
CREATE INDEX idx_compute_meter_account_time ON compute_meter (account_id, finished_at DESC);
