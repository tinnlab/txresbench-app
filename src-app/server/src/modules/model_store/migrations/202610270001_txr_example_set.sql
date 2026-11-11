-- model_store module — `txr_example_set`: the single-row state of the
-- qa-fixes3 ITEM-3 example model set (POST /api/txr/models/example).
--
-- `id` is pinned to 1 by CHECK — the app is single-user, so ONE remembered
-- example-set creation is the whole surface (a second row would be a second
-- "Example models" set, which the set-name uniqueness already forbids).
-- `state` ∈ {creating, ready, failed}:
--   creating — a run is training the example models (`run_id` is the run);
--   ready    — the set exists (`set_id` is the saved set named "Example
--              models"); a caller that finds it missing (the user deleted the
--              set) resets to creating and re-creates it;
--   failed   — the last creation attempt ended failed (`error` is the honest
--              reason; the next call retries).
--
-- SQLite dialect per PROV-sqlite-store-4's type map: uuid BLOB 16 bytes,
-- timestamps TEXT RFC3339 UTC (the `strftime(...,'now')` default), state
-- TEXT, no AUTOINCREMENT.

CREATE TABLE txr_example_set (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL,
    run_id BLOB,
    set_id BLOB,
    error TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
