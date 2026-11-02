-- 202608040010 — a MULTI-SOURCE gather must DECLARE its alignment (ITEM-2,
-- §3.4-correction / DEC-8) — SQLite dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608040010_recipe_alignment_or_single_source.sql`.
--
-- Why this constraint exists (guard the STATE, not the syntax): a
-- multi-source recipe with a null alignment would let the serve path
-- re-derive the join from the sources' columns — the exact re-derivation
-- INV-3 forbids — so a violating recipe cannot commit at all, binding every
-- writer including one that has never read this file (the mirror of
-- `artifacts_bytes_or_recipe` and `datasets_integrate_declares_alignment`).
-- `GatheredFrom::parse` re-asserts the same rule at the READ boundary (belt
-- and suspenders, DB as the load-bearing guard). Full rationale: the
-- Postgres file.
--
-- SQLite port notes (ITEM-9, DEC-8 type map): `jsonb` -> TEXT, no
-- `public.` prefix. Construct deltas:
--   * SQLite has no `ALTER TABLE … ADD CONSTRAINT … NOT VALID` /
--     `VALIDATE CONSTRAINT`, so this file follows the documented REBUILD
--     procedure again (the `…0004` precedent in this same chain): new
--     table with the full 20-column list in the chain's order, copy, drop,
--     rename, recreate the 9 indexes. The `NOT VALID` + `VALIDATE` split of
--     the Postgres file exists to make validation a fast metadata pass
--     there; the SQLite rebuild's copy is empty (nothing inserts
--     `artifacts` rows between `…0001`'s wipe and this file — the chain
--     never writes the table), so validation is trivially satisfied, and
--     the PG premise ("no existing gathered row violates this") holds on
--     this engine for the same reason it holds there.
--   * `jsonb_exists`/`jsonb_array_length`/`->`/`->>` become the JSON1
--     functions of the bundled engine: `json_type(…, path) IS NOT NULL`
--     (SQLite's JSON1 has NO `json_exists` — the existence test is the
--     type probe, which also returns `'null'` for a JSON-null value,
--     exactly PG's `jsonb_exists` truth table) /
--     `json_array_length(json_extract(…))` / `json_extract(…)`. The
--     truth-table shape is preserved exactly: the SQLite CHECK, like the
--     Postgres one, PASSES on a NULL result (a gathered recipe with an
--     absent `sources` is admitted by the CHECK in both dialects and
--     refused by `GatheredFrom::parse` — the PG file documents this
--     division of labor).
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
    stored_bytes INTEGER NOT NULL DEFAULT 0,
    created_by BLOB,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    dataset_id BLOB,
    hidden INTEGER NOT NULL DEFAULT 0,
    representation_of BLOB,
    structure TEXT NOT NULL,
    meta TEXT NOT NULL,
    role TEXT NOT NULL,
    logical_bytes INTEGER,
    CONSTRAINT artifacts_pkey PRIMARY KEY (id),
    CONSTRAINT artifacts_bytes_or_recipe CHECK (
        (object_key IS NOT NULL AND NOT (json_type(structure, '$.gathered_from') IS NOT NULL))
     OR (object_key IS NULL     AND     json_type(structure, '$.gathered_from') IS NOT NULL)
    ),
    CONSTRAINT artifacts_recipe_alignment_or_single_source CHECK (
        NOT (json_type(structure, '$.gathered_from') IS NOT NULL)
        OR json_array_length(json_extract(structure, '$.gathered_from.sources')) <= 1
        OR (json_extract(structure, '$.gathered_from.alignment_artifact_id')) IS NOT NULL
    ),
    CONSTRAINT artifacts_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
    CONSTRAINT artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    CONSTRAINT artifacts_representation_of_fkey FOREIGN KEY (representation_of) REFERENCES artifacts (id) ON DELETE CASCADE
);

INSERT INTO artifacts_new (id, project_id, run_id, output_id, datatype,
    object_key, is_multifile, content_hash, status, stored_bytes,
    created_by, created_at, updated_at, dataset_id, hidden,
    representation_of, structure, meta, role, logical_bytes)
SELECT id, project_id, run_id, output_id, datatype,
    object_key, is_multifile, content_hash, status, stored_bytes,
    created_by, created_at, updated_at, dataset_id, hidden,
    representation_of, structure, meta, role, logical_bytes
FROM artifacts;

-- The `usable_artifacts` view (…0006/…0007) references `artifacts` by name:
-- SQLite re-parses a VIEW's definition when a RENAME passes over its
-- schema text, and at that point the dropped table does not exist yet —
-- so the view is dropped here and recreated below (the …0007 file already
-- established the drop-on-column-change idiom for this view).
DROP VIEW usable_artifacts;

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

CREATE UNIQUE INDEX artifacts_one_mask_per_dataset
    ON artifacts (dataset_id)
    WHERE role = 'mask';

-- The USABLE population view, recreated verbatim (its definition is the
-- …0006 comment's reference; recreated here because the rebuild dropped it
-- — same as the …0007 file's drop-before-column-rename pattern).
CREATE VIEW usable_artifacts AS
    SELECT * FROM artifacts
     WHERE status = 'ready'
       AND NOT hidden
       AND role = 'artifact';

-- A gather over >= 2 sources must name an alignment_artifact_id; a
-- single-source (filter) gather may have a null alignment and ride a mask
-- instead (ITEM-2 / DEC-8). Refuses a multi-source recipe with no
-- alignment, which would re-derive the join INV-3 forbids. Mirrors
-- artifacts_bytes_or_recipe: a STATE guard, not a syntax guard.
