-- demo module — the boot-seeded example runs (demo-mode ITEM-4: retention).
--
-- `txr_demo_seeded_runs`: ONE row per recorded configuration the demo
-- seeded at boot. A run with a row here is PINNED — never evicted by the
-- shared-pool retention and NOT counted in the limit (a first-time visitor
-- always finds the example setup in History). The row is the idempotency
-- record too: the configuration id is the primary key, so a restart never
-- seeds a second run for the same setup; the pin mark and the seed record
-- are the same row, never two sources of truth.
--
-- The demo's example MODEL SET is pinned by derivation (the `txr_example_set`
-- ready row's set id) — the ONE example set of a deployment, never evicted
-- either; no second pin table exists for it.
--
-- SQLite dialect per PROV-sqlite-store-4: uuid BLOB 16 bytes, timestamps
-- TEXT RFC3339 UTC, ids assigned app-side.

CREATE TABLE txr_demo_seeded_runs (
    configuration_id TEXT NOT NULL,
    run_id BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT txr_demo_seeded_runs_pkey PRIMARY KEY (configuration_id),
    CONSTRAINT txr_demo_seeded_runs_run_fkey FOREIGN KEY (run_id) REFERENCES txr_runs(id) ON DELETE CASCADE
);
