-- 202608040008 — an `integrate` dataset must DECLARE the alignment it was produced by —
-- SQLite dialect port (ITEM-11, sqlite-store) of
-- `src/modules/dataset/migrations/202608040008_integrate_declares_alignment.sql`.
--
-- ── why this constraint exists: it replaces a comment that could not notice a new INSERT ──────
--
-- `workstore/detach_guard.rs` refuses to detach a dataset that a virtual dataset is built from.
-- Its transitive arm (`D -> V1 -> V2`) was deliberately deferred on a MEASURED premise: at the
-- time, nothing minted a `datasets` row for a gathered artifact, so `V1` did not exist and a
-- one-level refusal was complete.
--
-- The premise was true when written and false ~45 minutes later, when
-- `virtual_dataset.rs::create_for_run` became a fourth `INSERT INTO datasets` site. Nothing
-- failed. The guard silently became incomplete, and stayed that way, because the thing holding
-- the premise was PROSE.
--
-- The walk is now written. This constraint is the part that keeps it correct against the NEXT
-- writer. The walk traverses exactly one edge to discover a virtual dataset:
--
--     datasets.metadata -> 'alignment' ->> 'artifact_id'
--
-- A future site that mints a `source = 'integrate'` row without that edge would be invisible to
-- the guard in precisely the way the fourth site was — a chain constructible at the data layer
-- that the refusal cannot see. It now cannot commit such a row at all.
--
-- **This is a STATE guard, not a syntax guard, and that is the point.** Counting
-- `INSERT INTO datasets` occurrences in the source would be a text scan a writer can evade by
-- accident (a different SQL spelling, a helper, a `COPY`) and would fire on harmless additions.
-- The invariant that actually matters is a property of the ROW, so it is enforced on the row,
-- where it binds every writer including one that has never read the guard.
--
-- ── scope ────────────────────────────────────────────────────────────────────────────────────
--
-- PARTIAL by construction: `upload` / `promote` rows carry no alignment and are untouched. It
-- asserts the KEY IS PRESENT AND NON-EMPTY, not that it resolves — a FK is impossible here
-- (the value is JSON text inside `metadata`, and `artifacts` rows can be deleted independently),
-- and "present" is the property the walk needs. A dangling id makes an alignment contribute no
-- identity, which is the same safe outcome as an alignment that produced nothing.
--
-- No backfill clause is needed and none is written: the only producer of `integrate` rows is
-- the creator, which has always written `metadata.alignment.artifact_id`. `NOT VALID` +
-- `VALIDATE` is used anyway so an existing deployment carrying a row this rejects surfaces it as
-- a migration failure naming the constraint, rather than as a table-rewrite lock.
--
-- SQLite port notes (ITEM-11):
--   * the CHECK follows the REBUILD procedure (`202608040005`'s port notes):
--     SQLite cannot ADD a constraint, so the table is recreated with the
--     named check INLINE (the empty row copy is positional, every index
--     present at this position — the three baseline indexes + the
--     `datasets_one_per_alignment_run` partial unique — is recreated).
--   * the Postgres `metadata -> 'alignment' ->> 'artifact_id'` text-extract ->
--     `json_extract(metadata, '$.alignment.artifact_id')`. Critically NOT
--     `json_type(…, path) IS NOT NULL` (the ITEM-9 existence-test port):
--     a JSON-NULL `artifact_id` (`{"artifact_id": null}`) is SQL NULL from
--     `json_extract` — both `IS NOT NULL` legs then say "not declared" and
--     the row is REFUSED, matching Postgres (`->>` on a JSON null yields
--     SQL NULL -> `IS NOT NULL` false). `json_type` would report 'null' as
--     present and a JSON-null artifact_id would be admitted — the exact
--     invisible-edge failure this guard exists to prevent. Probed truth
--     table: JSON null / "" / absent / missing object all -> refused,
--     non-empty string -> admitted (3.37 probe; pinned by the 3.46
--     harness).
--   * `NOT VALID`/`VALIDATE` have no SQLite equivalent — the CHECK is
--     enforced from the table's birth; the fresh-file chain has no
--     pre-existing rows, so the state the PG `VALIDATE` would surface is
--     unrepresentable (the same empty-table justification every rebuild in
--     this chain carries).

-- The declared-alignment CHECK, via the rebuild procedure.

CREATE TABLE datasets_rebuild (
    id BLOB NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    owner_id BLOB NOT NULL,
    datatype TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    source TEXT DEFAULT 'upload' NOT NULL,
    source_artifact_id BLOB,
    content_hash TEXT,
    processing_job_id BLOB,
    CONSTRAINT datasets_pkey PRIMARY KEY (id),
    CONSTRAINT datasets_source_check CHECK (source IN ('upload','promote','integrate')),
    CONSTRAINT datasets_integrate_declares_alignment CHECK (
        source <> 'integrate'
        OR (
            json_extract(metadata, '$.alignment.artifact_id') IS NOT NULL
            AND json_extract(metadata, '$.alignment.artifact_id') <> ''
        )
    ),
    CONSTRAINT datasets_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT datasets_processing_job_id_fkey FOREIGN KEY (processing_job_id) REFERENCES jobs (id) ON DELETE SET NULL
);

INSERT INTO datasets_rebuild (id, name, created_at, updated_at, owner_id, datatype, metadata, source, source_artifact_id, content_hash, processing_job_id)
SELECT id, name, created_at, updated_at, owner_id, datatype, metadata, source, source_artifact_id, content_hash, processing_job_id
FROM datasets;

DROP TABLE datasets;

ALTER TABLE datasets_rebuild RENAME TO datasets;

CREATE INDEX idx_datasets_created_at ON datasets (created_at DESC);

CREATE INDEX idx_datasets_owner ON datasets (owner_id, created_at DESC);

CREATE INDEX idx_datasets_processing_job ON datasets (processing_job_id);

CREATE UNIQUE INDEX datasets_one_per_alignment_run
    ON datasets (json_extract(metadata, '$.alignment_run_id'))
    WHERE source = 'integrate';
