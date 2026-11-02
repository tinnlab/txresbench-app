-- workstore module — SQUASHED BASELINE — SQLite dialect port (ITEM-9,
-- sqlite-store) of
-- `src/modules/workstore/migrations/202608030004_workstore_baseline.sql`.
--
-- The Postgres file is the squash provenance: a VERBATIM `pg_dump
-- --schema-only` rendering of the schema the pre-squash chain produced
-- (column ORDER included), so the end state is identical to the pre-squash
-- schema. This port preserves that identity — table/column NAMES, column
-- ORDER, constraint NAMES, row semantics — expressed in the SQLite dialect;
-- the dialect is the deliberate, reviewed change (DEC-2/DEC-8). The
-- per-statement DESIGN RATIONALE the retired files carried lived in git
-- history (see the PG file) and is not reproduced here.
--
-- SQLite port notes (DEC-8 type map):
--   * uuid -> BLOB (16 raw bytes; sqlx's sqlite `Uuid` mapping; the app binds
--     `Uuid::new_v4()` — there is no SQL-side UUID generator).
--   * jsonb -> TEXT JSON text (defaults `'{}'` kept verbatim — they are
--     dropped by `…0002`, not by this port); boolean -> INTEGER 0/1;
--     bigint -> INTEGER; `timestamp with time zone DEFAULT now()` -> TEXT
--     RFC3339 UTC with `strftime('%Y-%m-%dT%H:%M:%fZ','now')`.
--   * no `public.` schema prefix; no `::` casts; `USING btree` dropped
--     (SQLite indexes are B-trees); the zero-uuid `COALESCE` literal becomes
--     the 16-byte blob X'00000000000000000000000000000000'.
--   * SQLite has no ALTER TABLE ADD CONSTRAINT: the primary keys and the
--     three artifact FKs + one axis-entry FK the Postgres file added by
--     `ALTER TABLE … ADD CONSTRAINT` are declared INLINE here WITH THE SAME
--     constraint names (the ITEM-7/8 precedent). The FK parents
--     (`datasets` 202608030002, `projects` 202608030003) sort BEFORE this
--     file in the full chain; in the staged chain they are ITEM-10/11 ports
--     that do not exist yet — SQLite binds FK parents lazily, so the CREATE
--     succeeds and a DML errors with `no such table` (the correct
--     staged-chain state; the apply harness stands in the stub parents).
--
-- Ordering: applies after the project + dataset baselines.
-- CONSEQUENCE (unchanged from the Postgres file): a database created before
-- the squash MUST BE RECREATED — see the "SQUASHED BASELINE" section of
-- `src/database.rs`.

-- == tables (PKs and FKs declared inline; the ALTER … ADD CONSTRAINT
-- == sections of the Postgres file are folded in here) ====================

CREATE TABLE artifacts (
    id BLOB NOT NULL,
    project_id BLOB,
    run_id BLOB,
    output_id TEXT NOT NULL,
    datatype TEXT NOT NULL,
    storage_layout TEXT NOT NULL,
    object_key TEXT NOT NULL,
    is_multifile INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    shape TEXT NOT NULL DEFAULT '{}',
    params TEXT NOT NULL DEFAULT '{}',
    covered_axes TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_by BLOB,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    dataset_id BLOB,
    hidden INTEGER NOT NULL DEFAULT 0,
    representation_of BLOB,
    CONSTRAINT artifacts_pkey PRIMARY KEY (id),
    CONSTRAINT artifacts_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
    CONSTRAINT artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    CONSTRAINT artifacts_representation_of_fkey FOREIGN KEY (representation_of) REFERENCES artifacts (id) ON DELETE CASCADE
);

CREATE TABLE workstore_axis_entry (
    project_id BLOB NOT NULL,
    axis_name TEXT NOT NULL,
    entry_index INTEGER NOT NULL,
    entry_key TEXT,
    group_id BLOB,
    group_local_index INTEGER,
    CONSTRAINT workstore_axis_entry_pkey PRIMARY KEY (project_id, axis_name, entry_index),
    CONSTRAINT workstore_axis_entry_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

-- == indexes =============================================================

CREATE INDEX artifacts_dataset_datatype ON artifacts (dataset_id, datatype);

CREATE INDEX artifacts_dataset_id ON artifacts (dataset_id);

CREATE UNIQUE INDEX artifacts_natural_key ON artifacts (COALESCE(project_id, X'00000000000000000000000000000000'), COALESCE(dataset_id, X'00000000000000000000000000000000'), COALESCE(run_id, X'00000000000000000000000000000000'), output_id);

CREATE INDEX artifacts_object_key ON artifacts (object_key);

CREATE INDEX artifacts_project_datatype ON artifacts (project_id, datatype);

CREATE INDEX artifacts_project_run ON artifacts (project_id, run_id);

CREATE INDEX idx_artifacts_representation_of ON artifacts (representation_of);

CREATE INDEX workstore_axis_entry_group ON workstore_axis_entry (project_id, axis_name, group_id);

CREATE UNIQUE INDEX workstore_axis_entry_group_identity ON workstore_axis_entry (project_id, axis_name, group_id, group_local_index) WHERE (group_id IS NOT NULL);

CREATE UNIQUE INDEX workstore_axis_entry_key ON workstore_axis_entry (project_id, axis_name, entry_key) WHERE (entry_key IS NOT NULL);
