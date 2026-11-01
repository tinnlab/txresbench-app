-- dataset module — SQUASHED BASELINE — SQLite dialect port (ITEM-11,
-- sqlite-store) of
-- `src/modules/dataset/migrations/202608030002_dataset_baseline.sql`.
--
-- The Postgres file carries the squash provenance (a VERBATIM `pg_dump
-- --schema-only` rendering of the schema the full chain produced — column
-- ORDER included). This port preserves that identity — table/column NAMES,
-- column ORDER, constraint NAMES, row semantics — expressed in SQLite
-- dialect (DEC-2/DEC-8): uuid -> BLOB, `timestamp with time zone DEFAULT
-- now()` -> TEXT RFC3339 UTC with
-- `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, jsonb -> TEXT JSON, no `public.`
-- prefix, no `::` casts, `USING btree` dropped.
--
-- SQLite port notes (ITEM-11):
--   * SQLite has no `ALTER TABLE … ADD CONSTRAINT`: every PK, CHECK, FK and
--     unique constraint the Postgres file added by ALTER is declared INLINE
--     here with the SAME names (the ITEM-7/8/9/10 convention).
--   * the FK parents `files` (SDK file store, 202607140125), `jobs`
--     (202608030001) and `users` (SDK auth schema, 202607140050) sort
--     BEFORE this file's position; `datasets` is the parent of this
--     module's own children (declared inline above them) and of
--     `artifacts`/`project_datasets` (later baselines) — SQLite binds FK
--     parents lazily by name, so those CREATEs succeed and DML is enforced
--     against the real tables.
--   * the `source` vocabulary starts at the Postgres baseline's two values
--     (`upload`, `promote`); `202608040005`/`202608040011` widen it (each
--     via the documented rebuild procedure — SQLite cannot ALTER a CHECK).
--
-- Ordering: applies after the SDK file store (files) and the jobs baseline
-- (unchanged from the Postgres file). CONSEQUENCE (unchanged from the
-- Postgres file): a database created before the squash MUST BE RECREATED —
-- see the "SQUASHED BASELINE" section of `src/database.rs`.

-- == tables (PKs/FKs/CHECKs inline; the ALTER … ADD CONSTRAINT sections of
-- == the Postgres file are folded in here) ==============================

CREATE TABLE dataset_files (
    dataset_id BLOB NOT NULL,
    file_id BLOB NOT NULL,
    ordinal INTEGER DEFAULT 0 NOT NULL,
    role TEXT DEFAULT 'primary' NOT NULL,
    kind TEXT,
    integration_status TEXT,
    integration_summary TEXT,
    integration_job_id BLOB,
    CONSTRAINT dataset_files_pkey PRIMARY KEY (dataset_id, file_id),
    CONSTRAINT dataset_files_integration_status_check CHECK (
        integration_status IS NULL
        OR integration_status IN ('pending','running','integrated','failed')
    ),
    CONSTRAINT dataset_files_role_check CHECK (role IN ('primary','supporting')),
    CONSTRAINT dataset_files_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
    CONSTRAINT dataset_files_file_id_fkey FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE,
    CONSTRAINT dataset_files_integration_job_id_fkey FOREIGN KEY (integration_job_id) REFERENCES jobs (id) ON DELETE SET NULL
);

CREATE TABLE dataset_folder_members (
    folder_id BLOB NOT NULL,
    dataset_id BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT dataset_folder_members_pkey PRIMARY KEY (folder_id, dataset_id),
    CONSTRAINT dataset_folder_members_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
    CONSTRAINT dataset_folder_members_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES dataset_folders (id) ON DELETE CASCADE
);

CREATE TABLE dataset_folders (
    id BLOB NOT NULL,
    owner_id BLOB NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT dataset_folders_pkey PRIMARY KEY (id),
    CONSTRAINT dataset_folders_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE dataset_shares (
    id BLOB NOT NULL,
    dataset_id BLOB NOT NULL,
    principal_type TEXT NOT NULL,
    principal_id BLOB NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT dataset_shares_pkey PRIMARY KEY (id),
    CONSTRAINT dataset_shares_principal_type_check CHECK (principal_type IN ('user','group')),
    CONSTRAINT dataset_shares_role_check CHECK (role IN ('view','edit')),
    CONSTRAINT dataset_shares_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE
);

CREATE TABLE datasets (
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
    CONSTRAINT datasets_source_check CHECK (source IN ('upload','promote')),
    CONSTRAINT datasets_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT datasets_processing_job_id_fkey FOREIGN KEY (processing_job_id) REFERENCES jobs (id) ON DELETE SET NULL
);

-- == indexes =============================================================

CREATE INDEX idx_dataset_files_file ON dataset_files (file_id);

CREATE INDEX idx_dataset_files_integration_job ON dataset_files (integration_job_id);

CREATE INDEX idx_dataset_files_role ON dataset_files (dataset_id, role);

CREATE INDEX idx_dataset_folder_members_dataset ON dataset_folder_members (dataset_id);

CREATE INDEX idx_dataset_folders_owner ON dataset_folders (owner_id, created_at DESC);

CREATE INDEX idx_dataset_shares_principal ON dataset_shares (principal_type, principal_id);

CREATE INDEX idx_datasets_created_at ON datasets (created_at DESC);

CREATE INDEX idx_datasets_owner ON datasets (owner_id, created_at DESC);

CREATE INDEX idx_datasets_processing_job ON datasets (processing_job_id);

CREATE UNIQUE INDEX uq_dataset_shares ON dataset_shares (dataset_id, principal_type, principal_id);
