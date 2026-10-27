-- drafts module — BASELINE — SQLite dialect port (ITEM-11, sqlite-store) of
-- `src/modules/drafts/migrations/202608240001_drafts_baseline.sql`.
--
-- A `draftable entity` is a domain-free, mutable, project-scoped working document
-- (`drafts` row) a package can EDIT declaratively and FREEZE into a content-addressed
-- immutable artifact. Core interprets NOTHING about a draft's `kind` or `data`
-- (INV-1): it owns the table, the freeze transition, the sync contract and the
-- `$state`↔draft binding; the package owns the schema, the edit view and the freeze
-- producer.
--
-- `status` is a BARE text column with the vocabulary in a `const` (like
-- `artifacts.status` / `project_shares.status`) — never `unwrap()`ed as an enum from
-- the DB. `open | frozen`.
--
-- Ordering: applies after the project baseline (the `project_id` FK) and the
-- workstore artifact baseline (the `frozen_artifact_id` FK) — both sort
-- earlier in the chain (202608030003 / 202608030004), unchanged.
--
-- SQLite port notes (ITEM-11):
--   * DEC-8 map: uuid -> BLOB (no `gen_random_uuid()` DEFAULT — the runtime
--     binds `Uuid::new_v4()`, DEC-12), jsonb -> TEXT JSON (`'{}'` default
--     text), `timestamp with time zone DEFAULT now()` -> TEXT RFC3339 UTC
--     with `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; the vocabulary CHECK ->
--     `IN ('open','frozen')`; the FKs inline with the same names;
--     `USING btree` dropped.
--   * the grant `array_append` + `NOT (p = ANY (permissions))` -> JSON1
--     `json_insert(permissions, '$[#]', …)` + `NOT EXISTS (… json_each …
--     WHERE value = …)` (the ITEM-7/8 convention; DEC-8: the
--     `groups.permissions` text[] is JSON-array text).

-- == tables (PKs/FKs/CHECKs inline; the ALTER … ADD CONSTRAINT sections of
-- == the Postgres file are folded in here) ==============================

CREATE TABLE drafts (
    id BLOB NOT NULL,
    kind TEXT NOT NULL,
    project_id BLOB NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    status TEXT DEFAULT 'open' NOT NULL,
    frozen_artifact_id BLOB,
    created_by BLOB,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT drafts_pkey PRIMARY KEY (id),
    CONSTRAINT drafts_status_check CHECK (status IN ('open','frozen')),
    CONSTRAINT drafts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    CONSTRAINT drafts_frozen_artifact_id_fkey FOREIGN KEY (frozen_artifact_id) REFERENCES artifacts (id) ON DELETE SET NULL,
    CONSTRAINT drafts_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
);

-- == indexes =============================================================

-- The one list index: drafts of a given kind within a project, newest-touched
-- first (the `list?project_id&kind` query shape).
CREATE INDEX drafts_project_idx ON drafts (project_id, kind, updated_at DESC);

-- == permission grants ===================================================

-- Grant `drafts::use` to the default Users group (Administrators already hold `*`).
-- Idempotent (skip if already present) — the JSON1 port of `array_append`
-- (DEC-8: the `groups.permissions` text[] is JSON-array text).
UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'drafts::use')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'drafts::use');
