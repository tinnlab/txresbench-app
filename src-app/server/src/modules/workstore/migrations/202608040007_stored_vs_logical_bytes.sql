-- workstore — split the ONE byte column into the TWO quantities it was
-- answering — SQLite dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608040007_stored_vs_logical_bytes.sql`.
--
-- `size_bytes` was written at ingest as *bytes handed to the object store*
-- and read at six places; exactly ONE (the provenance export cap + fetch.txt
-- transfer manifest) asked a STORAGE question, the other five asked a
-- LOGICAL one. A GATHERED artifact is where they come apart (stored 0,
-- logical rows × width); both readings spelled `size_bytes`, so the two
-- quantities become two columns with two names: `stored_bytes` (NOT NULL,
-- the STORAGE answer) and `logical_bytes` (NULL = genuinely UNKNOWN — the
-- honest answer where no width is derivable; nullable on purpose so every
-- consumer has to decide what to render instead of fabricating `0 Bytes`).
-- The backfill rule: an artifact with a blob has `logical_bytes =
-- stored_bytes`; a pre-existing gathered row stays NULL. Full rationale: the
-- Postgres file.
--
-- SQLite port notes (ITEM-9, DEC-8 type map): `bigint` -> INTEGER, no
-- `public.` prefix. Construct deltas:
--   * SQLite has supported `ALTER TABLE … RENAME COLUMN` since 3.25; the
--     rename is legal because the `usable_artifacts` view (the only
--     reference to the old name) is dropped in this file BEFORE the rename
--     — the same order the Postgres file uses — and no index or trigger
--     references `size_bytes`;
--   * the logical-bytes column lands as a plain nullable ADD COLUMN (no
--     default — NULL is the state the column exists to record); the
--     backfill UPDATE is verbatim;
--   * `COMMENT ON` directives become the comment block below.

DROP VIEW usable_artifacts;

ALTER TABLE artifacts RENAME COLUMN size_bytes TO stored_bytes;

ALTER TABLE artifacts ADD COLUMN logical_bytes INTEGER;

UPDATE artifacts SET logical_bytes = stored_bytes WHERE object_key IS NOT NULL;

CREATE VIEW usable_artifacts AS
    SELECT * FROM artifacts
     WHERE status = 'ready'
       AND NOT hidden
       AND role = 'artifact';

-- The USABLE artifact population (verbatim from 202608040006, whose comment
-- is the reference for why it is a view; recreated because the expanded
-- `SELECT *` held the OLD column name — a base-table rename does not reach
-- a view).
--
-- Bytes written to the object store. 0 for a GATHERED artifact, which owns
-- no blob — and that 0 is the correct storage answer. Read ONLY where the
-- question is genuinely about bytes on disk (the provenance export size cap
-- and fetch.txt). NEVER render this as "Size": use logical_bytes.
--
-- The size the data REPRESENTS when materialised, for display and for any
-- byte total a user reads. Equals stored_bytes for an artifact with a blob;
-- rows x element width for a gathered one. NULL means genuinely unknown (no
-- derivable element width) — render it as unknown, never as 0.
