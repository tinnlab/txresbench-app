-- features module — SQUASHED BASELINE (runtime feature-flags subsystem, #40) —
-- SQLite dialect port (ITEM-8, sqlite-store) of
-- `src/modules/features/migrations/202608280002_features_baseline.sql`.
--
-- Adds a runtime, admin-togglable feature-flag layer on top of the compile-time
-- gating the app already has (cargo `saas`, MODULE_ENTRIES, CORE_MODULE_BLOCKLIST,
-- the `seed_only_enabled` env). A flag has a GLOBAL default (account_id IS NULL)
-- plus optional PER-ACCOUNT overrides. The compiled `FlagRegistry`
-- (src/modules/features/registry.rs) is the source of truth for WHICH flags exist
-- and their fallback default; this table only records deviations from that default,
-- so it is seeded EMPTY.
--
-- Resolution (src/modules/features/guard.rs `is_feature_enabled`):
--   per-account override row  →  global row  →  compiled registry default.
--
-- SQLite port notes (ITEM-8, DEC-8 type map): uuid -> BLOB, boolean ->
-- INTEGER 0/1, `timestamp with time zone DEFAULT now()` -> TEXT RFC3339 UTC
-- (`strftime(...)` default), no `public.` prefix. Construct deltas:
--   * `id uuid DEFAULT gen_random_uuid()` -> `id BLOB NOT NULL` with NO
--     default: the DEC-12 rule (`gen_random_uuid()` -> app-side
--     `Uuid::new_v4()` bind; SQLite has no UUID generator), so every insert
--     binds the id;
--   * the `account_id` FK references `accounts` — the account module's
--     baseline (ITEM-10 ports it; version 202608030009 or later sorts
--     after this file, so the parent table does not exist yet at THIS
--     file's position). SQLite binds FK parents lazily: the CREATE succeeds
--     and the constraint becomes live once `accounts` exists (a DML on this
--     table before then errors with `no such table` — the correct
--     staged-chain state);
--   * the two UNIQUE indexes keep their exact shapes: the composite
--     `(flag_key, account_id)` treats NULLs as DISTINCT (as Postgres does),
--     and the partial `WHERE account_id IS NULL` index enforces exactly one
--     global row per flag_key (the `ON CONFLICT (flag_key) WHERE
--     account_id IS NULL` target the global upsert uses); the partial
--     predicate drops the `IS NULL` parenthesization only.
--
-- Ordering: applies after the account baseline (accounts table, the FK target).
--
-- == tables ==============================================================

CREATE TABLE feature_flags (
    id BLOB NOT NULL,
    -- The flag identifier (matches a compiled `FlagRegistry` key, e.g.
    -- 'demo.runtime_flag'). A row for a key not in the registry is inert (the
    -- guard falls back to fail-closed for an unknown key).
    flag_key TEXT NOT NULL,
    -- NULL  = the GLOBAL default row for this flag.
    -- non-NULL = a PER-ACCOUNT override for this flag (FK to accounts).
    account_id BLOB,
    enabled INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT feature_flags_pkey PRIMARY KEY (id),
    CONSTRAINT feature_flags_account_id_fkey FOREIGN KEY (account_id)
        REFERENCES accounts (id) ON DELETE CASCADE
);

-- == unique constraints / indexes ========================================

-- At most one row per (flag_key, account_id). SQLite (like Postgres) treats
-- NULLs as DISTINCT in a UNIQUE index, so this composite index does NOT bound
-- the GLOBAL rows (account_id IS NULL) — the partial index below does that.
CREATE UNIQUE INDEX feature_flags_key_account_uk
    ON feature_flags (flag_key, account_id);

-- Exactly one GLOBAL row per flag_key (the composite index cannot enforce this
-- because NULLs are distinct). This is the ON CONFLICT target the global upsert
-- uses (`ON CONFLICT (flag_key) WHERE account_id IS NULL`).
CREATE UNIQUE INDEX feature_flags_key_global_uk
    ON feature_flags (flag_key) WHERE account_id IS NULL;

-- Per-account lookup path (the guard reads (flag_key, account_id) on the hot path).
CREATE INDEX idx_feature_flags_account ON feature_flags (account_id);

-- == seed data + permission grants =======================================

-- No seed rows: the compiled `FlagRegistry` supplies every flag's default, and
-- this table records only deviations from it.
--
-- No group grant: `features::manage` is an ADMIN-ONLY key (like `admin::accounts`
-- and `jobs::settings::manage`). The Administrators group holds it via its `*`
-- wildcard / the `is_admin` short-circuit; it is deliberately NOT granted to the
-- Users group (a Users-group grant would let any user toggle deployment features).
