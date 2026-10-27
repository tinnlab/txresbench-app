-- project module — SQUASHED BASELINE — SQLite dialect port (ITEM-10,
-- sqlite-store) of
-- `src/modules/project/migrations/202608030003_project_baseline.sql`.
--
-- The Postgres file carries the squash provenance (a VERBATIM `pg_dump
-- --schema-only` rendering of the schema the full chain produced — column
-- ORDER included). This port preserves that identity — table/column NAMES,
-- column ORDER, constraint NAMES, row semantics — expressed in SQLite
-- dialect (DEC-2/DEC-8): uuid -> BLOB, boolean -> INTEGER 0/1, `timestamp
-- with time zone DEFAULT now()` -> TEXT RFC3339 UTC with
-- `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, no `public.` prefix, no `::`
-- casts, `USING btree` dropped.
--
-- SQLite port notes (ITEM-10):
--   * SQLite has no `ALTER TABLE … ADD CONSTRAINT`: every PK, CHECK, FK and
--     unique constraint the Postgres file added by ALTER is declared INLINE
--     here with the SAME names (the ITEM-7/8/9 convention).
--   * the FK parents `users` (SDK auth schema, 202607140050) and `datasets`
--     (module baseline 202608030002 — ported at ITEM-11, a stub parent in
--     the staged chain) sort BEFORE this file's position; SQLite binds FK
--     parents lazily for the not-yet-ported `datasets`, so the CREATE
--     succeeds and a DML errors loudly until ITEM-11 lands (the DEC-9
--     staged-chain state).
--   * the app-side `notifications_user_id_fkey` the Postgres file adds to
--     the SDK-OWNED `notifications` table follows this file's REBUILD
--     procedure (the `sandbox_settings` 202609020020 precedent — SQLite
--     cannot ALTER a table to add a constraint): the table is recreated
--     with the FK declared INLINE, the row copy is positional, the two
--     SDK indexes are recreated. Safe here: the SDK notification schema
--     has no inbound FKs, no triggers, no seed rows, and nothing inserts
--     into `notifications` before this file's position in the chain.
--
-- Ordering: applies after the SDK notification schema + auth seed and
-- before the workstore baseline (202608030004 — the `artifacts` FK parent
-- `projects`). CONSEQUENCE (unchanged from the Postgres file): a database
-- created before the squash MUST BE RECREATED — see the "SQUASHED
-- BASELINE" section of `src/database.rs`.

-- == tables (PKs/FKs/CHECKs inline; the ALTER … ADD CONSTRAINT sections of
-- == the Postgres file are folded in here) ==============================

CREATE TABLE project_datasets (
    dataset_id BLOB NOT NULL,
    project_id BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT project_datasets_pkey PRIMARY KEY (project_id, dataset_id),
    CONSTRAINT project_datasets_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
    CONSTRAINT project_datasets_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE project_settings (
    singleton INTEGER DEFAULT 1 NOT NULL,
    transfer_enabled INTEGER DEFAULT 1 NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT project_settings_pkey PRIMARY KEY (singleton),
    -- The Postgres `CHECK (singleton)` (a boolean column; `CHECK (singleton)`
    -- rejects false just as it rejects NULL) is the `= 1` pin here — the
    -- ITEM-8 `job_settings_singleton CHECK (id = 1)` precedent. It is
    -- what makes the rowid-alias PK on the INTEGER column enforce exactly
    -- one TRUE row (SQLite's INTEGER PRIMARY KEY is the rowid — a PK alone
    -- would admit `singleton = 2` with a fresh rowid, a shape the boolean
    -- domain cannot hold; the pin closes it).
    CONSTRAINT project_settings_singleton_check CHECK (singleton = 1)
);

CREATE TABLE project_shares (
    id BLOB NOT NULL,
    project_id BLOB NOT NULL,
    owner_id BLOB NOT NULL,
    recipient_id BLOB NOT NULL,
    permission_level TEXT NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT project_shares_pkey PRIMARY KEY (id),
    CONSTRAINT project_shares_permission_level_check CHECK (permission_level IN ('viewer','editor')),
    CONSTRAINT project_shares_status_check CHECK (status IN ('pending','accepted','declined')),
    CONSTRAINT project_shares_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT project_shares_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    CONSTRAINT project_shares_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE project_transfers (
    id BLOB NOT NULL,
    project_id BLOB NOT NULL,
    from_user_id BLOB NOT NULL,
    to_user_id BLOB NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT project_transfers_pkey PRIMARY KEY (id),
    CONSTRAINT project_transfers_status_check CHECK (status IN ('pending','accepted','declined')),
    CONSTRAINT project_transfers_from_user_id_fkey FOREIGN KEY (from_user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT project_transfers_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    CONSTRAINT project_transfers_to_user_id_fkey FOREIGN KEY (to_user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE projects (
    id BLOB NOT NULL,
    owner_id BLOB NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '' NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT projects_pkey PRIMARY KEY (id),
    CONSTRAINT projects_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
);

-- == indexes =============================================================

CREATE INDEX idx_project_datasets_dataset ON project_datasets (dataset_id);

CREATE INDEX idx_project_datasets_project ON project_datasets (project_id, created_at DESC);

CREATE INDEX idx_project_shares_recipient_status ON project_shares (recipient_id, status);

CREATE INDEX idx_project_transfers_to_status ON project_transfers (to_user_id, status);

CREATE INDEX idx_projects_owner_created ON projects (owner_id, created_at DESC);

CREATE UNIQUE INDEX uq_project_shares_project_recipient ON project_shares (project_id, recipient_id);

CREATE UNIQUE INDEX uq_project_transfers_pending ON project_transfers (project_id) WHERE (status = 'pending');

-- == the SDK `notifications` FK (REBUILD) ================================
--
-- The Postgres file's `ALTER TABLE ONLY public.notifications ADD CONSTRAINT
-- notifications_user_id_fkey …` — SQLite has no such ALTER, so the table is
-- rebuilt with the FK inline (see the header note). Full column list in the
-- SDK port's order; the copy is positional; the two SDK indexes recreated.

CREATE TABLE notifications_fk_rebuild (
    id BLOB NOT NULL,
    user_id BLOB NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    interrupt INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL DEFAULT '{}',
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT notifications_pkey PRIMARY KEY (id),
    CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

INSERT INTO notifications_fk_rebuild (id, user_id, kind, title, body, interrupt, payload, read_at, created_at)
SELECT id, user_id, kind, title, body, interrupt, payload, read_at, created_at
FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_fk_rebuild RENAME TO notifications;

CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at DESC);

CREATE INDEX idx_notifications_user_unread ON notifications (user_id) WHERE read_at IS NULL;

-- == seed data + permission grants ====================================

-- Seed the singleton (default: transfer enabled — an admin can disable).
INSERT INTO project_settings (singleton, transfer_enabled)
    VALUES (1, 1)
    ON CONFLICT (singleton) DO NOTHING;

-- Grant the permissions to the default Users group (Administrators already hold
-- `*`). `projects::use` gates all project CRUD; `notifications::read` gates the
-- SDK notification inbox. Idempotent (skip if already present) — the JSON1
-- port of `array_append` + `NOT (p = ANY (permissions))` (DEC-8: the
-- `groups.permissions` text[] is JSON-array text).
UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'projects::use')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'projects::use');

UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'notifications::read')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'notifications::read');
