-- provenance module — SQUASHED BASELINE — SQLite dialect port (ITEM-11,
-- sqlite-store) of
-- `src/modules/provenance/migrations/202608030005_provenance_baseline.sql`.
--
-- The Postgres file carries the squash provenance (a VERBATIM `pg_dump
-- --schema-only` rendering of the schema the full chain produced — column
-- ORDER included). This port preserves that identity — table/column NAMES,
-- column ORDER, constraint NAMES, row semantics — expressed in SQLite
-- dialect (DEC-2/DEC-8): uuid -> BLOB (16 raw bytes, no `gen_random_uuid()`
-- DEFAULT — the runtime binds `Uuid::new_v4()`, DEC-12), jsonb -> TEXT JSON,
-- bigint -> INTEGER, `double precision` -> REAL, boolean -> INTEGER 0/1,
-- `timestamp with time zone DEFAULT now()` -> TEXT RFC3339 UTC with
-- `strftime('%Y-%m-%dT%H:%M:%fZ','now')`.
--
-- SQLite port notes (ITEM-11):
--   * SQLite has no `ALTER TABLE … ADD CONSTRAINT`: every PK, CHECK, FK and
--     unique constraint the Postgres file added by ALTER is declared INLINE
--     here with the SAME names (the ITEM-7/8/9/10 convention).
--   * `provenance_settings.id` is the boolean singleton (PG: `boolean
--     DEFAULT true` PK + `CHECK (id = true)`) — the port is `INTEGER
--     DEFAULT 1` PK + the `= 1` pin (the ITEM-8 `job_settings` / ITEM-10
--     `project_settings` precedents): SQLite's `INTEGER PRIMARY KEY` is the
--     rowid alias, so the PK alone would admit `id = 2` with a fresh rowid —
--     a shape the boolean domain cannot hold. The seed's `ON CONFLICT (id)
--     DO NOTHING` keeps its upsert target.
--   * the FK parents `projects` (202608030003) and `datasets`
--     (202608030002 — this module's sibling baseline, ported at ITEM-11
--     before this file's position) sort earlier in the chain; SQLite binds
--     FK parents lazily by name, so the CREATEs succeed and DML is enforced
--     against the real tables.
--   * `COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid)`
--     in the dedup unique index -> `COALESCE(project_id, X'00…')` (the
--     16-byte zero BLOB — the uuid-blob equivalent; probed: the COALESCE
--     expression is deterministic and index-legal, the NULL-project dedup
--     is enforced, a project-scoped row is distinct).
--
-- Ordering: applies after the project + dataset baselines (unchanged).
-- CONSEQUENCE (unchanged from the Postgres file): a database created before
-- the squash MUST BE RECREATED — see the "SQUASHED BASELINE" section of
-- `src/database.rs`.

-- == tables (PKs/FKs/CHECKs inline; the ALTER … ADD CONSTRAINT sections of
-- == the Postgres file are folded in here) ==============================

CREATE TABLE provenance_code_blobs (
    sha256 TEXT NOT NULL,
    language TEXT NOT NULL,
    source TEXT NOT NULL,
    byte_len INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT provenance_code_blobs_pkey PRIMARY KEY (sha256)
);

CREATE TABLE provenance_reference_resources (
    id BLOB NOT NULL,
    project_id BLOB,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT DEFAULT '' NOT NULL,
    accession TEXT,
    doi TEXT,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT provenance_reference_resources_pkey PRIMARY KEY (id),
    CONSTRAINT provenance_reference_resources_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE provenance_run_repro (
    run_id BLOB NOT NULL,
    project_id BLOB,
    kind TEXT NOT NULL,
    status TEXT DEFAULT 'recorded' NOT NULL,
    generator_id TEXT DEFAULT '' NOT NULL,
    generator_version TEXT DEFAULT '' NOT NULL,
    code_sha256 TEXT,
    env_rootfs_sha256 TEXT,
    lockfile_json TEXT,
    seed INTEGER,
    params TEXT NOT NULL DEFAULT '{}',
    inputs_json TEXT NOT NULL DEFAULT '[]',
    acting_user BLOB,
    started_at TEXT,
    finished_at TEXT,
    captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    rerun_spec_json TEXT,
    dataset_id BLOB,
    CONSTRAINT provenance_run_repro_pkey PRIMARY KEY (run_id),
    CONSTRAINT provenance_run_repro_code_sha256_fkey FOREIGN KEY (code_sha256) REFERENCES provenance_code_blobs (sha256),
    CONSTRAINT provenance_run_repro_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
    CONSTRAINT provenance_run_repro_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE provenance_settings (
    id INTEGER DEFAULT 1 NOT NULL,
    export_bundle_max_bytes INTEGER DEFAULT 1073741824 NOT NULL,
    export_retention_days INTEGER DEFAULT 30 NOT NULL,
    methods_llm_polish_enabled INTEGER DEFAULT 0 NOT NULL,
    verify_default_tolerance REAL DEFAULT 0.99 NOT NULL,
    verify_time_budget_secs INTEGER DEFAULT 3600 NOT NULL,
    verify_size_budget_bytes INTEGER DEFAULT 4294967296 NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    capture_code_max_bytes INTEGER DEFAULT 262144 NOT NULL,
    CONSTRAINT provenance_settings_pkey PRIMARY KEY (id),
    CONSTRAINT provenance_settings_id_check CHECK (id = 1),
    CONSTRAINT provenance_settings_capture_code_max_bytes_check CHECK (capture_code_max_bytes BETWEEN 4096 AND 16777216),
    CONSTRAINT provenance_settings_export_bundle_max_bytes_check CHECK (export_bundle_max_bytes BETWEEN 1048576 AND 68719476736),
    CONSTRAINT provenance_settings_export_retention_days_check CHECK (export_retention_days BETWEEN 0 AND 3650),
    CONSTRAINT provenance_settings_verify_default_tolerance_check CHECK (verify_default_tolerance BETWEEN 0.0 AND 1.0),
    CONSTRAINT provenance_settings_verify_size_budget_bytes_check CHECK (verify_size_budget_bytes BETWEEN 1048576 AND 274877906944),
    CONSTRAINT provenance_settings_verify_time_budget_secs_check CHECK (verify_time_budget_secs BETWEEN 1 AND 86400)
);

CREATE TABLE provenance_verifications (
    id BLOB NOT NULL,
    target_run_id BLOB NOT NULL,
    project_id BLOB NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    tolerance_mode TEXT DEFAULT 'tolerant' NOT NULL,
    diff_report TEXT NOT NULL DEFAULT '{}',
    rootfs_digest TEXT,
    cert_json TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT provenance_verifications_pkey PRIMARY KEY (id),
    CONSTRAINT provenance_verifications_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

-- == indexes =============================================================

CREATE UNIQUE INDEX provenance_reference_dedup ON provenance_reference_resources (kind, content_hash, COALESCE(project_id, X'00000000000000000000000000000000'));

CREATE INDEX provenance_reference_resources_hash ON provenance_reference_resources (content_hash);

CREATE INDEX provenance_reference_resources_project ON provenance_reference_resources (project_id);

CREATE INDEX provenance_run_repro_dataset_captured ON provenance_run_repro (dataset_id, captured_at DESC);

CREATE INDEX provenance_run_repro_project_captured ON provenance_run_repro (project_id, captured_at DESC);

CREATE INDEX provenance_verifications_project ON provenance_verifications (project_id, created_at DESC);

CREATE INDEX provenance_verifications_run ON provenance_verifications (target_run_id, created_at DESC);

-- == seed data + permission grants ====================================

INSERT INTO provenance_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- `provenance::read` + `provenance::export` are granted to the Users group (every
-- projects user may read the lineage of, and export, projects they can access; the
-- per-project role via effective_permission gates the specific project). The admin
-- perms `provenance::settings::{read,manage}` get NO grant — Administrators hold
-- them via the `*` wildcard / is_admin short-circuit. Idempotent — the JSON1 port
-- of `array_append` (DEC-8: the `groups.permissions` text[] is JSON-array text).
UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'provenance::read')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'provenance::read');

UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'provenance::export')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'provenance::export');
