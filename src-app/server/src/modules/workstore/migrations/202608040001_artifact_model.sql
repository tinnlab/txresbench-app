-- workstore — the artifact model: producer-declared structure + meta —
-- SQLite dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608040001_artifact_model.sql`.
--
-- Realizes the artifact-model design §0.3 "Postgres — 38 → 37 tables". Two
-- columns carry what a producer DECLARES about an artifact:
--
--   structure — how to decode the bytes
--   meta      — what it means, for display
--
-- Both are `NOT NULL` with **NO DEFAULT** — the design's second invariant
-- ("everything is explicit; there is no default fallback — absence is an
-- error"). The four columns this model replaces (dropped by the follow-up
-- migration) all carry `DEFAULT '{}' NOT NULL`. With no default, a producer
-- that omits either column gets a write error at ingest.
--
-- WHY THE WIPE IS IN *THIS* FILE: the same reason the Postgres file gives —
-- a NOT NULL/no-default column cannot be added to a table that has rows, on
-- either engine (SQLite additionally validates the existing rows against a
-- new column CHECK at ALTER time, so the wipe has to precede the ALTER
-- here exactly as in Postgres). The data is discarded rather than backfilled
-- because artifacts are immutable and content-addressed; pre-release, with no
-- shipped install to preserve, wiping is the honest option. Datasets must be
-- re-imported.
--
-- SQLite port note (DEC-8 type map): `jsonb` -> TEXT. Construct delta:
-- Postgres lands the columns with a NOT NULL and no DEFAULT; SQLite forbids
-- `ADD COLUMN … NOT NULL` without a non-NULL DEFAULT and has no DROP
-- DEFAULT, so the port's spelling is `CHECK (structure IS NOT NULL)` — the
-- identical post-add end state (absence is refused on every write; there is
-- no implicit value), with the CHECK name showing the expressions it
-- enforces. It is legal here and in Postgres for the same reason: the wipe
-- immediately above leaves the table empty when the ALTER runs. The old
-- `COMMENT ON COLUMN` directives become the comment block below.

-- 1. Discard every existing artifact. `representation_of` is a self-FK with
--    ON DELETE CASCADE, so representation rows go with their subjects.
DELETE FROM artifacts;

-- 2. `datasets.source_artifact_id` holds an artifact id but declares NO foreign
--    key, so step 1 cannot cascade into it and would leave every dataset
--    pointing at an id that no longer resolves. Clear it explicitly: a dangling
--    uuid with no constraint behind it is invisible until something dereferences
--    it and gets an empty row.
--    (`datasets` is the dataset module's table — ITEM-11's port; at this
--    staged-chain position the harness's stub parent stands in.)
UPDATE datasets SET source_artifact_id = NULL WHERE source_artifact_id IS NOT NULL;

-- 3. The declarations themselves, with the no-default invariant spelled as a
--    CHECK (see the port note). A NULL is impossible for a committed row;
--    omitting the column on a write is refused.
ALTER TABLE artifacts ADD COLUMN structure TEXT CHECK (structure IS NOT NULL);
ALTER TABLE artifacts ADD COLUMN meta TEXT CHECK (meta IS NOT NULL);

-- Producer-declared: how to decode the bytes. NOT NULL with no default —
-- absence is an error, never an implied empty declaration.
--
-- Producer-declared: what the artifact means, for display. NOT NULL with no
-- default.
--
-- NOTE: the object-store blobs backing the deleted rows are now
-- unreferenced. Reclaiming them is the existing `workstore::gc` sweep's job,
-- not this migration's — SQL cannot reach the object store, and doing it
-- here would put a filesystem side effect inside a transaction that can roll
-- back.
