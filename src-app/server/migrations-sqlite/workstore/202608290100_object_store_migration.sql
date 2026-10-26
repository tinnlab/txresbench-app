-- Object-store data MIGRATION state (#61 §2) — persists a copy+verify
-- migration so it survives a restart and is resumable, and so the admin
-- surface can show live progress + the verify status + the
-- confirm-before-retire step — SQLite dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608290100_object_store_migration.sql`.
--
-- DATA-SAFETY note (unchanged): this table records the STATE of a
-- migration; it never itself moves or deletes a blob. The engine
-- (`migration_engine.rs`) only ever COPIES source→dest and content-hash-
-- VERIFIES; the SOURCE is deleted only by the separate,
-- explicitly-confirmed retire step, after a full re-verify. The `phase`
-- lifecycle and the "at most ONE RUNNING migration" partial-unique index
-- (with `verified` deliberately not counted as running): see the Postgres
-- file.
--
-- SQLite port notes (ITEM-9, DEC-8 type map): `uuid` -> BLOB, `bigint` ->
-- INTEGER, `boolean` -> INTEGER 0/1, `timestamptz DEFAULT now()` -> TEXT
-- RFC3339 UTC (`strftime(...)` default), no `public.` prefix. Construct
-- deltas:
--   * `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` -> `id BLOB PRIMARY
--     KEY` with NO default — the DEC-12 rule (SQLite has no UUID generator;
--     the app binds `Uuid::new_v4()`), so every insert must bind the id
--     (pinned by the harness);
--   * the anonymous phase CHECK (Postgres auto-names it
--     `object_store_migration_phase_check` — the name `202608290130` drops
--     and re-adds) is declared INLINE with that name;
--   * `ON … ((true)) WHERE phase IN (…)` — Postgres's constant-expression
--     unique index — ports to `((1))` (the boolean literal spelling is
--     SQLite-compatible but the constant 1 form is the convention of the
--     type map's boolean → INTEGER 0/1 rule); the partial predicate stays
--     verbatim. `IF NOT EXISTS` kept (harmless on SQLite, matching the
--     CREATE TABLE IF NOT EXISTS file contract).
--   * `pgcrypto (gen_random_uuid)` comment references dropped (D02/DEC-10 —
--     see `202608290090`'s port note for the full finding).

CREATE TABLE object_store_migration (
    id             BLOB PRIMARY KEY,
    -- The two ends (non-secret descriptors, for display + the estimate/cost-gate).
    src_backend    TEXT NOT NULL,               -- 'local' | 's3'
    src_provider   TEXT,                         -- 's3' | 'gcs' | NULL (local)
    src_bucket     TEXT,
    dst_backend    TEXT NOT NULL,
    dst_provider   TEXT,
    dst_bucket     TEXT,
    -- Lifecycle.
    phase          TEXT NOT NULL DEFAULT 'pending'
        CONSTRAINT object_store_migration_phase_check
        CHECK (phase IN ('pending','copying','verifying','verified','failed','retired')),
    -- Progress (bounded counters, not a per-blob list).
    blobs_total    INTEGER NOT NULL DEFAULT 0,
    blobs_done     INTEGER NOT NULL DEFAULT 0,
    bytes_total    INTEGER NOT NULL DEFAULT 0,
    bytes_done     INTEGER NOT NULL DEFAULT 0,
    -- Cost-gate (INV-7): a large cross-cloud move requires an explicit operator go-ahead.
    cross_cloud    INTEGER NOT NULL DEFAULT 0,
    cost_ack       INTEGER NOT NULL DEFAULT 0,
    -- A fixed-vocabulary failure category (NEVER a raw error / credential).
    verify_error   TEXT,
    -- Whether this migration was started automatically (a config switch) or manually.
    auto_started   INTEGER NOT NULL DEFAULT 0,
    -- Audit.
    created_by     BLOB,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- At most ONE RUNNING migration at a time — a second start cannot race a
-- copy in flight. `verified` is NOT counted as running: it is a completed
-- copy awaiting the operator's manual retire of the old store, so it must
-- not block a fresh migration indefinitely. `failed`/`retired` are
-- unconstrained history.
CREATE UNIQUE INDEX IF NOT EXISTS object_store_migration_one_active
    ON object_store_migration ((1))
    WHERE phase IN ('pending','copying','verifying');

-- Newest-first lookup for "the current migration" the status endpoint shows.
CREATE INDEX IF NOT EXISTS object_store_migration_created_at_idx
    ON object_store_migration (created_at DESC);
