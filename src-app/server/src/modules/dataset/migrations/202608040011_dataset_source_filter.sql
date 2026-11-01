-- 202608040011 — a dataset may be created by a FILTER, and a filter dataset is unique per run —
-- SQLite dialect port (ITEM-11, sqlite-store) of
-- `src/modules/dataset/migrations/202608040011_dataset_source_filter.sql`.
--
-- `datasets_source_check` was `source = ANY (ARRAY['upload','promote','integrate'])`
-- (`202608040005_dataset_source_integrate.sql:33-35`). A FILTER virtual dataset — the row a
-- successful filter run creates, whose columns are gathered through a per-source MASK
-- rather than an alignment (§11.3, ITEM-13 / DEC-6) — is none of those three: it was not
-- uploaded, it is not a byte-preserving promotion, and it is NOT an integration (a filter has
-- ONE source and no join). Widening the vocabulary is what makes the filter sink's row
-- representable at all. `integrate` (alignment→VD) and `filter` (mask→VD) are DISTINCT creation
-- paths — the mirror, not the same value.
--
-- The value is `filter`, matching the analysis that produces it (the filter processor) and the
-- vocabulary §11.3 uses for the operation.
--
-- ── the UNIQUE index is the idempotency guard, and it is here rather than in Rust ────────────
--
-- The sink runs from `finalize_analysis_with`, reached TWICE for one run in a real deployment:
-- the normal completion, and `scheduler::reconcile_orphaned_running`'s boot re-finalize after a
-- crash. A SELECT-then-INSERT in the sink is a TOCTOU: both passes would see no row and both
-- would insert, leaving two filter datasets for one run with nothing to say which is real. So
-- the invariant lives in the database, where it binds every writer: at most ONE `filter`
-- dataset per `filter_run_id`. The sink inserts optimistically and treats a unique violation as
-- "already created", the same shape as `datasets_one_per_alignment_run` (`202608040005`).
--
-- PARTIAL (`WHERE source = 'filter'`) so an `upload`/`promote`/`integrate` row — which carries
-- no `filter_run_id` at all, i.e. SQL NULL — is untouched by it. The sibling
-- `datasets_integrate_declares_alignment` CHECK (`202608040008`) only constrains
-- `source = 'integrate'` rows, so a `filter` row is exempt and legitimately carries no
-- `metadata.alignment` — its selection rides the mask, not an alignment.
--
-- SQLite port notes (ITEM-11):
--   * the CHECK widening + the JSON extract follow the REBUILD procedure
--     (`202608040005`'s/`202608040008`'s port notes): the table is
--     recreated with the widened named CHECK INLINE, the (empty) row copy
--     is positional, every index present at this position — the three
--     baseline indexes + `datasets_one_per_alignment_run` — is recreated,
--     then the new filter idempotency index is created.
--   * `metadata ->> 'filter_run_id'` -> `json_extract(metadata,
--     '$.filter_run_id')` (as in 202608040005).

-- The widened CHECK + the filter idempotency index, via the rebuild procedure.

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
    CONSTRAINT datasets_source_check CHECK (source IN ('upload','promote','integrate','filter')),
    CONSTRAINT datasets_integrate_declares_alignment CHECK (
        source <> 'integrate'
        OR (
            json_extract(metadata, '$.alignment.artifact_id') IS NOT NULL
            AND json_extract(metadata, '$.alignment.artifact_id') <> ''
        )
    ),
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

CREATE UNIQUE INDEX datasets_one_per_filter_run
    ON datasets (json_extract(metadata, '$.filter_run_id'))
    WHERE source = 'filter';
