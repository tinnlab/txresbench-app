-- workstore — an artifact row that can say it has NO STORED BYTES (ITEM-16)
-- — SQLite dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608040004_artifact_gathered.sql`.
--
-- Stamped after `202608040003_artifact_role.sql` (DEC-9). What this is for,
-- why there is NO `storage_kind` column (DEC-8, corrected), why `object_key`
-- becomes NULLABLE rather than `''`, why `content_hash` stays NOT NULL: see
-- the Postgres file — the condensed reading is: a VIRTUAL artifact is an
-- ordinary `artifacts` row with no blob behind it; the discriminant is the
-- resolution RECIPE (`structure.gathered_from`), which cannot disagree with
-- itself; NULL records absence with one declared meaning.
--
-- SQLite port notes (ITEM-9, DEC-8 type map): `jsonb` -> TEXT, boolean ->
-- INTEGER 0/1, no `public.` prefix. Construct deltas:
--   * SQLite has no `ALTER COLUMN … DROP NOT NULL` and no `ALTER TABLE …
--     ADD CONSTRAINT`, so this file follows the SQLite-documented rebuild
--     procedure (the sandbox `202609020020` precedent): create the new
--     table with the full column list in the chain's order, copy
--     positionally, drop the old, rename. Safe here for the same reasons
--     the sandbox rebuild was: nothing references `artifacts` inbound
--     (`datasets.source_artifact_id` deliberately carries NO FK — the
--     `…0001` comment), no triggers exist in this chain, and the
--     `usable_artifacts` view does not exist yet (…0006 creates it). The
--     eight indexes from the baseline + `…0003` are recreated (a rename
--     does not carry them).
--   * `jsonb_exists(structure, 'gathered_from')` has no SQLite spelling:
--     SQLite's JSON1 has NO `json_exists` function, so the existence test
--     is `json_type(structure, '$.gathered_from') IS NOT NULL` (returns
--     the value's type when the path exists — 'null' included, matching
--     PG's `jsonb_exists` truth table where a JSON-null value still
--     "exists" — and NULL when absent).
--   * `COMMENT ON` directives become the comment block below.
--
-- The pairing, stated as a constraint so it cannot be violated by any writer
-- — including a future one that has never read this file. Exhaustive by
-- construction: stored = object_key NOT NULL + no recipe; gathered =
-- object_key NULL + recipe present; both/neither refused.
CREATE TABLE artifacts_new (
    id BLOB NOT NULL,
    project_id BLOB,
    run_id BLOB,
    output_id TEXT NOT NULL,
    datatype TEXT NOT NULL,
    object_key TEXT,
    is_multifile INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_by BLOB,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    dataset_id BLOB,
    hidden INTEGER NOT NULL DEFAULT 0,
    representation_of BLOB,
    structure TEXT NOT NULL,
    meta TEXT NOT NULL,
    role TEXT NOT NULL,
    CONSTRAINT artifacts_pkey PRIMARY KEY (id),
    CONSTRAINT artifacts_bytes_or_recipe CHECK (
        (object_key IS NOT NULL AND NOT (json_type(structure, '$.gathered_from') IS NOT NULL))
     OR (object_key IS NULL     AND     json_type(structure, '$.gathered_from') IS NOT NULL)
    ),
    CONSTRAINT artifacts_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
    CONSTRAINT artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    CONSTRAINT artifacts_representation_of_fkey FOREIGN KEY (representation_of) REFERENCES artifacts (id) ON DELETE CASCADE
);

INSERT INTO artifacts_new (id, project_id, run_id, output_id, datatype,
    object_key, is_multifile, content_hash, status, size_bytes, created_by,
    created_at, updated_at, dataset_id, hidden, representation_of,
    structure, meta, role)
SELECT id, project_id, run_id, output_id, datatype,
    object_key, is_multifile, content_hash, status, size_bytes, created_by,
    created_at, updated_at, dataset_id, hidden, representation_of,
    structure, meta, role
FROM artifacts;

DROP TABLE artifacts;

ALTER TABLE artifacts_new RENAME TO artifacts;

CREATE INDEX artifacts_dataset_datatype ON artifacts (dataset_id, datatype);

CREATE INDEX artifacts_dataset_id ON artifacts (dataset_id);

CREATE UNIQUE INDEX artifacts_natural_key ON artifacts (COALESCE(project_id, X'00000000000000000000000000000000'), COALESCE(dataset_id, X'00000000000000000000000000000000'), COALESCE(run_id, X'00000000000000000000000000000000'), output_id);

CREATE INDEX artifacts_object_key ON artifacts (object_key);

CREATE INDEX artifacts_project_datatype ON artifacts (project_id, datatype);

CREATE INDEX artifacts_project_run ON artifacts (project_id, run_id);

CREATE INDEX idx_artifacts_representation_of ON artifacts (representation_of);

CREATE INDEX artifacts_role ON artifacts (role);

-- The object-store address of this artifact's bytes, or NULL when it has
-- none. NULL is not "unknown" and not "empty": it means the row is
-- GATHERED, and `structure.gathered_from` carries the recipe that produces
-- the bytes on demand. The `artifacts_bytes_or_recipe` CHECK enforces that
-- exactly one of the two is present, so a reader may treat a NULL key as a
-- guarantee that the recipe is there.
--
-- Stored-xor-gathered. Refuses a row that has both an object key and a
-- gather recipe (which source wins?) and a row that has neither (unreadable
-- by every path). Deliberately a constraint rather than a convention: the
-- discriminant is the recipe itself, so the two can never disagree.
