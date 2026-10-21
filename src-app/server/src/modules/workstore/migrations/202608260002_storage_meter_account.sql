-- storage_meter — T5 account-keying (epic compute-storage, T5 / PROV-compute-metering-1).
--
-- T2 shipped the raw per-byte-delta signal keyed by content_hash + project_id. T5 adds the two
-- columns billing's usage-rollup (B1) binds via the SHARPENED contract PROV-compute-metering-1:
--   account_id    — the tenant, resolved as account_of(project|dataset) at the ingest/GC emit
--                   sites (§9 / DEC-2). NULLABLE: a scope-less / unresolvable delta lands NULL
--                   rather than failing ingest (fail-safe, DEC-1). B1 folds the +/- deltas per
--                   account, in created_at order, into the time-weighted GB-months integral.
--   logical_bytes — what the account is BILLED on (billing §2.2). At INGEST this is the
--                   artifact's stored_bytes (it owns its bytes); at a GC -delta it is NULL (a
--                   reclaim carries no positive logical size — the delta_bytes sign accounts it),
--                   DEC-9.
--
-- storage exactly-once is structural (INV-4): the ingest +delta commits ATOMICALLY inside the
-- artifact-insert txn (one row per ingest); the GC -delta is a single best-effort INSERT — no
-- dedup key needed, the append-only ledger IS the signal. project_id is KEPT (T5 resolves the
-- account FROM it; project stays as provenance). Deliberately NO FK on account_id (DEC-3, the
-- ledger must outlive the account).
--
-- Prefix 202608260002: above the true server max (202608240003) — DEC-7 / BASE.md.
ALTER TABLE storage_meter ADD COLUMN account_id    UUID;
ALTER TABLE storage_meter ADD COLUMN logical_bytes BIGINT;

-- The (account_id, created_at) ordered index B1's per-account time-weighted fold walks
-- (design §8 verbatim; coding-guidelines §4).
CREATE INDEX idx_storage_meter_account_time ON storage_meter (account_id, created_at);
