-- model_store module — `txr_model_sets`: one row per user-named save set
-- (PROV-MS-11; DEC-10's set semantics — the L board's "Name of this set"
-- creates a row, L2's "into an existing set" reuses one, and "Delete the
-- run's models" is the cascade of this row's models).
--
-- `name` is UNIQUE under COLLATE NOCASE: set names are case-insensitive
-- identities on the screens (the store's `SET_NAME_TAKEN` detection is the
-- NOCASE comparison window — "CRC cohort" and "crc cohort" are the same
-- set). `source_run_id` + `source_label` record where the set came from (the
-- I board's "trained on patients.csv" provenance — DEC-12, engine-truth when
-- GAP-D's `input_summary.file_names` lands). `keep_training_files` mirrors
-- the L dialog's checkbox; a false row keeps no training dir (NULL).
--
-- SQLite dialect per PROV-sqlite-store-4's type map: uuid BLOB 16 bytes,
-- timestamps TEXT RFC3339 UTC (the `strftime(...,'now')` default), bool
-- INTEGER 0/1, ids assigned app-side (`Uuid::new_v4()` bind — no
-- AUTOINCREMENT / SQL default), REAL floats.

CREATE TABLE txr_model_sets (
    id BLOB NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    source_run_id BLOB,
    source_label TEXT,
    keep_training_files INTEGER NOT NULL,
    training_dir TEXT,
    updated_at TEXT,
    CONSTRAINT txr_model_sets_pkey PRIMARY KEY (id)
);
