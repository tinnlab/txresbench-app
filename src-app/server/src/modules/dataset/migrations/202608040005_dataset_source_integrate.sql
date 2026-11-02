-- 202608040005 — a dataset may be INTEGRATED, and an integrated dataset is unique per run —
-- SQLite dialect port (ITEM-11, sqlite-store) of
-- `src/modules/dataset/migrations/202608040005_dataset_source_integrate.sql`.
--
-- `datasets_source_check` was `source = ANY (ARRAY['upload','promote'])`
-- (`202608030002_dataset_baseline.sql:80`). A virtual dataset — the row a successful
-- integration run creates, whose columns are gathered THROUGH an alignment rather
-- than stored — is neither: it was not uploaded and it is not a byte-preserving promotion of
-- one artifact. Widening the vocabulary is what makes the creator's row representable at all.
--
-- The value is `integrate`, matching the analysis that produces it and the vocabulary the
-- rest of the tree already uses for that operation (`is_integrate_job`, `IntegrationSink`).
--
-- ── the UNIQUE index is the idempotency guard, and it is here rather than in Rust ────────
--
-- The creator runs from `finalize_analysis_with`, which is reached TWICE for one run in a
-- real deployment: the normal completion, and `scheduler::reconcile_orphaned_running`'s boot
-- re-finalize after a crash. A SELECT-then-INSERT in the creator is a TOCTOU: both passes
-- would see no row and both would insert, leaving two virtual datasets for one alignment
-- with nothing to say which is real. `insert_artifact`'s own idempotency key
-- (project/dataset/run/output) cannot help, because the second pass would mint a SECOND
-- dataset id and therefore a disjoint key.
--
-- So the invariant lives in the database, where it binds every writer including one that has
-- not read the creator: at most ONE `integrate` dataset per `alignment_run_id`. The creator
-- inserts optimistically and treats a unique violation as "already created", which is the
-- correct outcome rather than an error.
--
-- PARTIAL (`WHERE source = 'integrate'`) so an `upload`/`promote` row — which carries no
-- `alignment_run_id` at all, i.e. SQL NULL — is untouched by it.
--
-- SQLite port notes (ITEM-11):
--   * the CHECK widening + the JSON extract follow the REBUILD procedure (the
--     sandbox `202609020020` / ITEM-9 `…0010` / ITEM-10 `202609040003`
--     precedent): SQLite cannot alter a CHECK, so the table is recreated
--     with the widened named CHECK INLINE, the (empty — nothing inserts
--     before this position) row copy is positional, and every index present
--     at this position is recreated. The `datasets` table is an FK PARENT
--     (dataset_files / artifacts / project_datasets / provenance_run_repro
--     reference it) — probed: with empty children a DROP TABLE of the
--     parent succeeds and the children's FKs RE-BIND by name after the
--     RENAME (3.37 probe + the 3.46 harness pins it through the chain
--     apply).
--   * `metadata ->> 'alignment_run_id'` -> `json_extract(metadata,
--     '$.alignment_run_id')` (the JSON1 spelling; deterministic, so the
--     expression index is legal); `'{}'::jsonb` has no SQLite spelling —
--     the metadata DEFAULT is the JSON text `'{}'` (DEC-8).

-- The widened CHECK + the idempotency index, via the rebuild procedure.

CREATE TABLE datasets_rebuild (
    id BLOB NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    owner_id BLOB NOT NULL,
    datatype TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    source TEXT DEFAULT 'upload' NOT NULL,
    source_artifact_id BLOB,
    content_hash TEXT,
    processing_job_id BLOB,
    CONSTRAINT datasets_pkey PRIMARY KEY (id),
    CONSTRAINT datasets_source_check CHECK (source IN ('upload','promote','integrate')),
    CONSTRAINT datasets_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT datasets_processing_job_id_fkey FOREIGN KEY (processing_job_id) REFERENCES jobs (id) ON DELETE SET NULL
);

INSERT INTO datasets_rebuild (id, name, created_at, updated_at, owner_id, datatype, metadata, source, source_artifact_id, content_hash, processing_job_id)
SELECT id, name, created_at, updated_at, owner_id, datatype, metadata, source, source_artifact_id, content_hash, processing_job_id
FROM datasets;

DROP TABLE datasets;

ALTER TABLE datasets_rebuild RENAME TO datasets;

CREATE INDEX idx_datasets_created_at ON datasets (created_at DESC);

CREATE INDEX idx_datasets_owner ON datasets (owner_id, created_at DESC);

CREATE INDEX idx_datasets_processing_job ON datasets (processing_job_id);

CREATE UNIQUE INDEX datasets_one_per_alignment_run
    ON datasets (json_extract(metadata, '$.alignment_run_id'))
    WHERE source = 'integrate';
