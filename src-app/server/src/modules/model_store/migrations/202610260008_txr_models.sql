-- model_store module — `txr_models`: one row per saved model (PROV-MS-11).
-- A row is a REFERENCE to an immutable, content-addressed tree:
-- `tree_sha256` (the engine's own PROV-SS-3 digest over the exact bytes —
-- INV-2) is the word the row is trusted on, `dir` is the tree's host path
-- under `<data_root>/models/trees/<tree_sha256>/` (the sandbox-bindable
-- plain-dir layout, DEC-2), and several rows (saved into a second set,
-- imported twice) may reference one dir — the refcount helper's prune rule
-- (DEC-3). The recorded requirements (`features`, `required_markers`,
-- `marker_facts`, `covariates`, `decision_day` / `endpoint` / `horizon`) are
-- save-time facts, never re-derived (DEC-6); `trained_at` is the run's
-- `finished_at`; `size_bytes` / `own_auc` / `trained_on_patients` are the
-- engine's recorded fields (GAP-B/C — the store computes no metrics).
--
-- `set_id` is nullable on purpose: an imported model may land without a set
-- (the J board's "opened from breast-panel.txr"), and the UNIQUE is then
-- per-method-per-tree (SQLite treats NULLs as distinct in a UNIQUE
-- constraint). `"group"` is deliberately double-quoted: GROUP is a SQLite
-- keyword and the column name is the plan's wire `group` (PROV-MS-11) — the
-- repository quotes it the same way in every query (the `txr_run_methods`
-- precedent).
--
-- `pretrained_catalogue_version` records the asset version of a pretrained
-- install (PROV-MS-2's strict id+version match for GAP-PC-3's
-- `installed_model_id`; NULL for the user's own run/imported rows). The JSON
-- columns are TEXT holding the wire shapes verbatim: `features` is always the
-- JSON array, `required_markers` is NULL only when a container carried no
-- recorded requirements (the `MODEL_REQUIREMENTS_UNRECORDED` fact — never a
-- silent empty), `marker_facts` + `covariates` always present.
--
-- SQLite dialect per PROV-sqlite-store-4's type map (see the sets migration).
-- `txr_models_set_id_fkey` is the same ON DELETE CASCADE the engine's
-- per-run method rows use: deleting a set removes its model rows (DEC-10/D14
-- — the I board's "Delete the run's models"), and `keep_files=true` is the
-- files-stay escape at the route layer (rows only).

CREATE TABLE txr_models (
    id BLOB NOT NULL,
    set_id BLOB,
    name TEXT NOT NULL,
    method_id TEXT NOT NULL,
    method_version TEXT NOT NULL,
    "group" TEXT NOT NULL,
    group_label TEXT NOT NULL,
    task TEXT,
    provenance TEXT NOT NULL,
    imported_from TEXT,
    pretrained_catalogue_id TEXT,
    pretrained_catalogue_version TEXT,
    licence TEXT,
    tree_sha256 TEXT NOT NULL,
    dir TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    contract TEXT NOT NULL,
    env_base_digest TEXT,
    env_layer_digest TEXT,
    trained_on_patients INTEGER,
    trained_at TEXT,
    decision_day REAL NOT NULL,
    endpoint TEXT NOT NULL,
    horizon REAL NOT NULL,
    features TEXT NOT NULL,
    required_markers TEXT,
    marker_facts TEXT NOT NULL,
    covariates TEXT NOT NULL,
    embeds_training_data INTEGER NOT NULL,
    own_auc REAL,
    own_c REAL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT txr_models_pkey PRIMARY KEY (id),
    CONSTRAINT txr_models_set_id_fkey FOREIGN KEY (set_id) REFERENCES txr_model_sets(id) ON DELETE CASCADE,
    CONSTRAINT txr_models_tree_method_set_key UNIQUE (tree_sha256, method_id, set_id)
);

-- The list filter (J's per-set view) and the cascade walk (the FK's prune
-- re-check is per-row, but a set's model rows are read as one group) plus
-- the refcount helper's read — the two read paths of this table.
CREATE INDEX txr_models_set_id_idx ON txr_models(set_id);
CREATE INDEX txr_models_tree_sha256_idx ON txr_models(tree_sha256);
