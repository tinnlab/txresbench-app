-- storage_meter — append-only per-blob byte-delta ledger (epic compute-storage, T2 / PROV-T2-2).
--
-- T2 EMITS the raw signal; the deferred T5 aggregates it into per-account GB-months and maps
-- project_id -> account (§7.3 / DEC-5). Each row is ONE byte-delta event:
--   +stored_bytes at INGEST (recorded in the artifact-insert txn, INV-6),
--   -len          at GC unlink (recorded at the refcount-gated delete).
-- The signed sum over a content_hash is the physical footprint that hash still occupies.
--
-- Deliberately NO foreign key on project_id: this is a metering LEDGER that must OUTLIVE the
-- project it accounts for. The GC -delta is emitted DURING a project delete, so an
-- ON DELETE cascade would erase the very rows T5's rollup needs. Retention is T5's rollup
-- concern (consume + compact), mirroring an audit-log lifecycle rather than a child table.
--
-- Prefix 202608050001: above the current server max (202608040011) and the LOWEST of the
-- three compute-epic migrations assigned bottom-up (T2 storage_meter < T3 compute_meter <
-- T4 multiworker_claim) — DEC-6 / SEAMS build-time carry-forward.
CREATE TABLE storage_meter (
    id           BIGSERIAL PRIMARY KEY,
    -- nullable: a dataset-scoped or bare artifact has no owning project.
    project_id   UUID,
    -- sha256:<hex> — the artifact's content identity at ingest; the freed blob's hash at GC.
    content_hash TEXT        NOT NULL,
    -- signed: +stored_bytes on ingest, -len on GC unlink.
    delta_bytes  BIGINT      NOT NULL,
    reason       TEXT        NOT NULL CHECK (reason IN ('ingest', 'gc')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index both WHERE columns the rollup filters on (coding-guidelines §4): per-hash physical
-- accounting, and per-project time-ordered rollup.
CREATE INDEX idx_storage_meter_content_hash ON storage_meter (content_hash);
CREATE INDEX idx_storage_meter_project ON storage_meter (project_id, created_at DESC);
