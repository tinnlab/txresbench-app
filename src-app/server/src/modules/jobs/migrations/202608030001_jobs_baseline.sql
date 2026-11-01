-- jobs module — SQUASHED BASELINE — SQLite dialect port (ITEM-8, sqlite-store)
-- of `src/modules/jobs/migrations/202608030001_jobs_baseline.sql`.
--
-- The Postgres file carries the squash provenance: it is a VERBATIM
-- `pg_dump --schema-only` rendering of the schema the pre-squash chain
-- produced (column ORDER included) so the end state is identical to the
-- pre-squash schema. This port preserves that identity — table/column NAMES,
-- column ORDER, constraint NAMES, row semantics — expressed in the SQLite
-- dialect; a `pg_dump`-style file is PG syntax by construction, so the
-- dialect is the deliberate, reviewed change (DEC-2/DEC-8).
--
-- SQLite port notes (DEC-8 type map):
--   * uuid -> BLOB (16 raw bytes; sqlx's sqlite `Uuid` mapping; the app binds
--     `Uuid::new_v4()` — there is no SQL-side `gen_random_uuid()`).
--   * jsonb -> TEXT JSON text; boolean -> INTEGER 0/1; `real` -> REAL;
--     `bigint` -> INTEGER; `character varying`/`text` -> TEXT; `timestamp
--     with time zone DEFAULT now()` -> TEXT RFC3339 UTC with
--     `strftime('%Y-%m-%dT%H:%M:%fZ','now')` (lexicographic == chronological).
--   * no `public.` schema prefix; no `::` casts; `USING btree` dropped
--     (SQLite indexes are B-trees); `x = ANY (ARRAY['a','b'])` -> `x IN
--     ('a','b')`; the unqualified constraint names are kept verbatim.
--   * SQLite has no ALTER TABLE ADD CONSTRAINT: every primary key, UNIQUE,
--     FK and CHECK the Postgres chain delivered by `ALTER TABLE … ADD
--     CONSTRAINT` is declared INLINE here with the SAME constraint name.
--     The `jobs_owner_id_fkey` parent (`users`) is the SDK's table — its
--     auth baseline (202607140050) sorts BEFORE this file, so the FK
--     resolves at apply time; the `job_dependencies`/`jobs` self-references
--     are declared in-table in the same file (SQLite binds FK parents
--     lazily, so forward references are legal at CREATE and become live as
--     the parents appear).
--   * `array_append(permissions, p)` + `p = ANY (permissions)` ->
--     `json_insert(permissions, '$[#]', p)` guarded by a JSON1 `json_each`
--     membership check (the permissions column is TEXT JSON array text).
--
-- Ordering: applies after the SDK auth schema + seed (users, groups).
-- CONSEQUENCE (unchanged from the Postgres file): a database created before
-- the squash MUST BE RECREATED — see the "SQUASHED BASELINE" section of
-- `src/database.rs`.

-- == tables ==============================================================

CREATE TABLE job_dependencies (
    job_id BLOB NOT NULL,
    depends_on_job_id BLOB NOT NULL,
    CONSTRAINT job_dependencies_check CHECK (job_id <> depends_on_job_id),
    CONSTRAINT job_dependencies_pkey PRIMARY KEY (job_id, depends_on_job_id),
    CONSTRAINT job_dependencies_depends_on_job_id_fkey FOREIGN KEY (depends_on_job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    CONSTRAINT job_dependencies_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE job_logs (
    id BLOB NOT NULL,
    job_id BLOB NOT NULL,
    seq INTEGER NOT NULL,
    stream TEXT NOT NULL DEFAULT 'stdout',
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT job_logs_pkey PRIMARY KEY (id),
    CONSTRAINT job_logs_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE job_metrics (
    id BLOB NOT NULL,
    job_id BLOB NOT NULL,
    sampled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    cpu_pct REAL NOT NULL,
    mem_bytes INTEGER NOT NULL,
    mem_peak_bytes INTEGER,
    pids_current INTEGER,
    CONSTRAINT job_metrics_pkey PRIMARY KEY (id),
    CONSTRAINT job_metrics_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE job_milestones (
    id BLOB NOT NULL,
    job_id BLOB NOT NULL,
    milestone_id TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT job_milestones_pkey PRIMARY KEY (id),
    CONSTRAINT job_milestones_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE job_scope (
    job_id BLOB NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id BLOB NOT NULL,
    CONSTRAINT job_scope_scope_kind_check CHECK (scope_kind IN ('project', 'dataset')),
    CONSTRAINT job_scope_pkey PRIMARY KEY (job_id),
    CONSTRAINT job_scope_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE job_settings (
    id INTEGER NOT NULL DEFAULT 1,
    max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    reserved_interactive_slots INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT job_settings_max_concurrent_jobs_check CHECK (max_concurrent_jobs BETWEEN 1 AND 64),
    CONSTRAINT job_settings_reserved_slots_check CHECK (reserved_interactive_slots BETWEEN 0 AND max_concurrent_jobs - 1),
    CONSTRAINT job_settings_singleton CHECK (id = 1),
    CONSTRAINT job_settings_pkey PRIMARY KEY (id)
);

CREATE TABLE jobs (
    id BLOB NOT NULL,
    owner_id BLOB NOT NULL,
    job_type TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    params TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at TEXT,
    finished_at TEXT,
    exit_code INTEGER,
    error TEXT,
    pid INTEGER,
    priority_class TEXT NOT NULL DEFAULT 'normal',
    resource_class TEXT NOT NULL DEFAULT 'cpu-sandbox',
    req_cpu INTEGER,
    req_mem_bytes INTEGER,
    run_id BLOB,
    CONSTRAINT jobs_priority_class_check CHECK (priority_class IN ('interactive', 'normal', 'batch')),
    CONSTRAINT jobs_resource_class_check CHECK (resource_class IN ('cpu-sandbox', 'gpu', 'highmem', 'cluster-batch')),
    CONSTRAINT jobs_pkey PRIMARY KEY (id),
    CONSTRAINT jobs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- == indexes =============================================================

CREATE INDEX idx_job_deps_depends_on ON job_dependencies (depends_on_job_id);

CREATE INDEX idx_job_logs_job_seq ON job_logs (job_id, seq);

CREATE INDEX idx_job_metrics_job_time ON job_metrics (job_id, sampled_at);

CREATE INDEX idx_job_milestones_job_id ON job_milestones (job_id);

CREATE INDEX idx_job_scope_kind_id ON job_scope (scope_kind, scope_id);

CREATE INDEX idx_jobs_owner_created ON jobs (owner_id, created_at DESC);

CREATE INDEX idx_jobs_status_created ON jobs (status, created_at);

CREATE INDEX idx_jobs_status_priority_created ON jobs (status, priority_class, created_at);

-- == seed data + permission grants ====================================

-- Seed the singleton so the scheduler + GET always find a value. The seeded
-- `reserved_interactive_slots` = 1 is the net of the original seed plus the
-- later clamp UPDATE (both squashed in here). `ON CONFLICT DO NOTHING` is
-- SQLite-legal and keeps the seed idempotent (TEST-15 pins it).
INSERT INTO job_settings (id, max_concurrent_jobs, reserved_interactive_slots)
VALUES (1, 2, 1)
ON CONFLICT (id) DO NOTHING;

-- Grant the job permission to the default Users group (Administrators already
-- hold `*`). `jobs::use` gates job create / list-own / stop-own. The admin-only
-- `jobs::settings::{read,manage}` are NOT granted here. Idempotent.
UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'jobs::use')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'jobs::use');
