-- workstore — the artifact model: producer-declared structure + meta.
--
-- Realizes the artifact-model design §0.3 "Postgres — 38 → 37 tables". Two
-- columns carry what a producer DECLARES about an artifact:
--
--   structure — how to decode the bytes
--   meta      — what it means, for display
--
-- Both are `NOT NULL` with **NO DEFAULT**, and that is the point rather than an
-- oversight. The design's second invariant is "everything is explicit; there is
-- no default fallback — absence is an error". The four columns this model
-- replaces (`shape`/`params`/`covered_axes`/`storage_layout`, dropped in the
-- follow-up migration) all carry `DEFAULT '{}'::jsonb NOT NULL`, i.e. the schema
-- currently does exactly what the invariant forbids: an omitted declaration
-- silently becomes an empty object, and every reader downstream has to guess
-- whether `{}` means "nothing to declare" or "the producer forgot". With no
-- default, a producer that omits either column gets a write error at ingest.
--
-- WHY THE WIPE IS IN *THIS* FILE AND NOT THE LATER DROP MIGRATION
-- Postgres cannot add a NOT NULL column with no default to a table that has
-- rows — there is no value to give them. So the wipe cannot be deferred to the
-- drop migration; it has to precede the constraint it makes satisfiable. The
-- data is discarded rather than backfilled because artifacts are immutable and
-- content-addressed: a "converted" artifact hashes differently, so it is a NEW
-- artifact, not a migrated one, and a compat decoder in the server is precisely
-- what the first invariant (the server never opens a byte for meaning) forbids.
-- Pre-release, with no shipped install to preserve, wiping is the honest option.
-- Datasets must be re-imported.

-- 1. Discard every existing artifact. `representation_of` is a self-FK with
--    ON DELETE CASCADE, so representation rows go with their subjects.
DELETE FROM public.artifacts;

-- 2. `datasets.source_artifact_id` holds an artifact id but declares NO foreign
--    key, so step 1 cannot cascade into it and would leave every dataset
--    pointing at an id that no longer resolves. Clear it explicitly: a dangling
--    uuid with no constraint behind it is invisible until something dereferences
--    it and gets an empty row.
UPDATE public.datasets SET source_artifact_id = NULL WHERE source_artifact_id IS NOT NULL;

-- 3. The declarations themselves.
ALTER TABLE public.artifacts ADD COLUMN structure jsonb NOT NULL;
ALTER TABLE public.artifacts ADD COLUMN meta jsonb NOT NULL;

COMMENT ON COLUMN public.artifacts.structure IS
    'Producer-declared: how to decode the bytes. NOT NULL with no default — absence is an error, never an implied empty declaration.';
COMMENT ON COLUMN public.artifacts.meta IS
    'Producer-declared: what the artifact means, for display. NOT NULL with no default.';

-- NOTE: the object-store blobs backing the deleted rows are now unreferenced.
-- Reclaiming them is the existing `workstore::gc` sweep's job, not this
-- migration's — SQL cannot reach the object store, and doing it here would put a
-- filesystem side effect inside a transaction that can roll back.
