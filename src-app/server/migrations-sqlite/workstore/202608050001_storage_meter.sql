-- storage_meter — append-only per-blob byte-delta ledger (epic
-- compute-storage, T2 / PROV-T2-2) — SQLite dialect port (ITEM-9,
-- sqlite-store) of
-- `src/modules/workstore/migrations/202608050001_storage_meter.sql`.
--
-- T2 EMITS the raw signal; the deferred T5 aggregates it into per-account
-- GB-months and maps project_id -> account (§7.3 / DEC-5). Each row is ONE
-- byte-delta event: +stored_bytes at INGEST (recorded in the artifact-insert
-- txn, INV-6), −len at GC unlink. The signed sum over a content_hash is the
-- physical footprint that hash still occupies. Deliberately NO foreign key
-- on project_id: a metering LEDGER must OUTLIVE the project it accounts for
-- (the GC −delta is emitted DURING a project delete). Full rationale: the
-- Postgres file.
--
-- SQLite port notes (ITEM-9, DEC-8 type map): `BIGSERIAL` -> `INTEGER
-- PRIMARY KEY AUTOINCREMENT` (monotonic, no rowid reuse — the SERIAL
-- semantic; the ledger's `id` is never bound by the writers, it is the
-- surrogate the sequence owns), `UUID` -> BLOB, `BIGINT` -> INTEGER,
-- `TIMESTAMPTZ` -> TEXT RFC3339 UTC
-- (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), the inline `reason` CHECK is
-- kept verbatim, no `public.` prefix (none in the PG file either), indexes
-- as btree.
CREATE TABLE storage_meter (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    -- nullable: a dataset-scoped or bare artifact has no owning project.
    project_id   BLOB,
    -- sha256:<hex> — the artifact's content identity at ingest; the freed blob's hash at GC.
    content_hash TEXT        NOT NULL,
    -- signed: +stored_bytes on ingest, -len on GC unlink.
    delta_bytes  INTEGER     NOT NULL,
    reason       TEXT        NOT NULL CHECK (reason IN ('ingest', 'gc')),
    created_at   TEXT        NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Index both WHERE columns the rollup filters on (coding-guidelines §4):
-- per-hash physical accounting, and per-project time-ordered rollup.
CREATE INDEX idx_storage_meter_content_hash ON storage_meter (content_hash);
CREATE INDEX idx_storage_meter_project ON storage_meter (project_id, created_at DESC);
