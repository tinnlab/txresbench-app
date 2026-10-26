-- Abandon a verified object-store migration (#65) — add the `abandoned`
-- terminal phase — SQLite dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608290130_object_store_abandon.sql`.
--
-- THE GAP (#65) and the semantics of `abandoned` (the operator abandoned a
-- verified migration and reverted the primary to the intact OLD store via
-- an atomic `swap_object_store`; `verify_error` carries a fixed-vocabulary
-- reason; NO blob is deleted on this path; EXCLUDED from `latest_unretired`
-- so the store is reconfigurable; `failed` is deliberately INCLUDED there —
-- a genuine copy-failure's config already advanced to NEW while OLD still
-- holds data, so it MUST keep the dual-read fallback): see the Postgres
-- file. DATA-SAFETY note (unchanged): this only WIDENS the phase CHECK; it
-- changes no existing row and deletes nothing; backward-compatible.
--
-- SQLite port note (ITEM-9, DEC-8 type map): `boolean` -> INTEGER 0/1, no
-- `public.` prefix. Construct delta: SQLite has no `ALTER TABLE … DROP
-- CONSTRAINT` / `ADD CONSTRAINT`, so the widen is the documented REBUILD
-- procedure again (the `202609020020` sandbox precedent; the `…0004` and
-- `…0010` precedents in this chain): new table with the full 21-column list
-- in the chain's order, copy, drop, rename, recreate the THREE indexes.
-- Safe here for the same reasons as the earlier rebuilds: nothing inbound
-- references `object_store_migration` (its `created_by` carries no FK — an
-- audit id, per the file's own contract), no triggers, no views. The phase
-- CHECK is redeclared with the PostgreSQL auto-generated name
-- (`object_store_migration_phase_check` — the name the PG file drops and
-- re-adds), now with the widened 7-value set.

CREATE TABLE object_store_migration_new (
    id                    BLOB PRIMARY KEY,
    src_backend           TEXT NOT NULL,
    src_provider          TEXT,
    src_bucket            TEXT,
    dst_backend           TEXT NOT NULL,
    dst_provider          TEXT,
    dst_bucket            TEXT,
    phase                 TEXT NOT NULL DEFAULT 'pending'
        CONSTRAINT object_store_migration_phase_check
        CHECK (phase IN ('pending','copying','verifying','verified','failed','retired','abandoned')),
    blobs_total           INTEGER NOT NULL DEFAULT 0,
    blobs_done            INTEGER NOT NULL DEFAULT 0,
    bytes_total           INTEGER NOT NULL DEFAULT 0,
    bytes_done            INTEGER NOT NULL DEFAULT 0,
    cross_cloud           INTEGER NOT NULL DEFAULT 0,
    cost_ack              INTEGER NOT NULL DEFAULT 0,
    verify_error          TEXT,
    auto_started          INTEGER NOT NULL DEFAULT 0,
    created_by            BLOB,
    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    cutover               INTEGER NOT NULL DEFAULT 0,
    src_config_ciphertext BLOB
);

INSERT INTO object_store_migration_new (id, src_backend, src_provider,
    src_bucket, dst_backend, dst_provider, dst_bucket, phase, blobs_total,
    blobs_done, bytes_total, bytes_done, cross_cloud, cost_ack,
    verify_error, auto_started, created_by, created_at, updated_at,
    cutover, src_config_ciphertext)
SELECT id, src_backend, src_provider, src_bucket, dst_backend, dst_provider,
    dst_bucket, phase, blobs_total, blobs_done, bytes_total, bytes_done,
    cross_cloud, cost_ack, verify_error, auto_started, created_by,
    created_at, updated_at, cutover, src_config_ciphertext
FROM object_store_migration;

DROP TABLE object_store_migration;

ALTER TABLE object_store_migration_new RENAME TO object_store_migration;

CREATE UNIQUE INDEX IF NOT EXISTS object_store_migration_one_active
    ON object_store_migration ((1))
    WHERE phase IN ('pending','copying','verifying');

CREATE INDEX IF NOT EXISTS object_store_migration_created_at_idx
    ON object_store_migration (created_at DESC);

CREATE INDEX IF NOT EXISTS object_store_migration_cutover_idx
    ON object_store_migration (created_at DESC)
    WHERE phase = 'verified' AND cutover = 1;
