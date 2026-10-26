-- storage_meter — T5 account-keying (epic compute-storage, T5 /
-- PROV-compute-metering-1) — SQLite dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608260002_storage_meter_account.sql`.
--
-- T2 shipped the raw per-byte-delta signal keyed by content_hash +
-- project_id. T5 adds the two columns billing's usage-rollup (B1) binds via
-- the SHARPENED contract PROV-compute-metering-1: `account_id` (the tenant,
-- resolved as account_of(project|dataset) at the emit sites; NULLABLE —
-- a scope-less delta lands NULL rather than failing ingest, fail-safe
-- DEC-1) and `logical_bytes` (what the account is BILLED on; at INGEST the
-- artifact's stored_bytes, at a GC −delta NULL — the sign of delta_bytes
-- accounts it, DEC-9). Exactly-once is structural (INV-4); project_id is
-- kept as provenance; deliberately NO FK on account_id (the ledger must
-- outlive the account). Full rationale: the Postgres file.
--
-- SQLite port notes (ITEM-9, DEC-8 type map): `UUID` -> BLOB, `BIGINT` ->
-- INTEGER, plain ADD COLUMNs (the `ADD COLUMN IF NOT EXISTS` batch of the
-- PG file softens only partial re-runs, which cannot exist — each migration
-- file runs in its own transaction; the ITEM-8 convention).
ALTER TABLE storage_meter ADD COLUMN account_id    BLOB;
ALTER TABLE storage_meter ADD COLUMN logical_bytes INTEGER;

-- The (account_id, created_at) ordered index B1's per-account time-weighted
-- fold walks (design §8 verbatim; coding-guidelines §4).
CREATE INDEX idx_storage_meter_account_time ON storage_meter (account_id, created_at);
