-- mcp module — SQUASHED BASELINE — SQLite dialect port (ITEM-8, sqlite-store)
-- of `src/modules/mcp/migrations/202608030007_mcp_baseline.sql`.
--
-- The Postgres file carries the squash provenance (a VERBATIM `pg_dump
-- --schema-only` rendering of the pre-squash chain's schema). This port
-- preserves table/column NAMES, column ORDER, constraint NAMES and row
-- semantics in SQLite dialect (DEC-2/DEC-8).
--
-- SQLite port notes (DEC-8 type map): uuid -> BLOB, `text` -> TEXT,
-- `timestamp with time zone DEFAULT now()` -> TEXT RFC3339 UTC with
-- `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, no `public.` prefix, no `::`
-- casts, `USING btree` dropped; SQLite has no ALTER TABLE ADD CONSTRAINT,
-- so the UNIQUE, PK and FK are declared INLINE with the same names; the
-- `mcp_pairing_codes_user_id_fkey` parent (`users`, SDK-owner) is created
-- by the SDK auth baseline (version 202607140050) which sorts earlier.
-- `array_append` + `= ANY` -> `json_insert`/`json_each` (JSON1; the
-- permissions column is TEXT JSON array text).
--
-- Ordering: applies after the SDK auth schema (users).
-- CONSEQUENCE (unchanged from the Postgres file): a database created before
-- the squash MUST BE RECREATED — see the "SQUASHED BASELINE" section of
-- `src/database.rs`.

-- == tables ==============================================================

CREATE TABLE mcp_pairing_codes (
    id BLOB NOT NULL,
    code TEXT NOT NULL,
    user_id BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    CONSTRAINT mcp_pairing_codes_code_key UNIQUE (code),
    CONSTRAINT mcp_pairing_codes_pkey PRIMARY KEY (id),
    CONSTRAINT mcp_pairing_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- == indexes =============================================================

CREATE INDEX idx_mcp_pairing_codes_code ON mcp_pairing_codes (code);

-- == seed data + permission grants ====================================

-- Grant `mcp::use` to the default Users group (Administrators already hold
-- `*`) so every user can pair an AI assistant to drive the app on their own
-- behalf. Idempotent (skip if already present).
UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'mcp::use')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'mcp::use');
