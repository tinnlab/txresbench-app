-- history_store module — `txr_history_preferences`: the K footer's
-- "Copies are kept with this run so it can be repeated" preference
-- (PROV-HS-4, DEC-5 / D25). One persisted global default row; the
-- conservative default is `true` — a user's uploaded file copies are kept
-- until the explicit "Do not keep copies of my files" action, and the
-- destructive half of that action is always the deliberate clear call
-- (INV-2: the module never silently deletes a file copy).
--
-- The row is a SINGLETON (`CHECK (id = 1)`); it is created by THIS
-- migration, never by an INSERT in code (a code INSERT is a test failure).
-- `keep_file_copies` is the wire bool as INTEGER 0/1 (PROV-sqlite-store-4's
-- type map); `updated_at` is the RFC3339 UTC stamp of the last write
-- (migration time for the seed row; the PUT's stamp later). The ui-run node
-- reads this row at create time and passes the value into the engine's
-- per-run `keep_copies` field (DEC-13), so one row stays the single source
-- of truth.

CREATE TABLE txr_history_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    keep_file_copies INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

INSERT INTO txr_history_preferences (id, keep_file_copies, updated_at)
VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
