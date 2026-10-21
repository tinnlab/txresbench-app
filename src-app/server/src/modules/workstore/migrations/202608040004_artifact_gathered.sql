-- workstore — an artifact row that can say it has NO STORED BYTES (ITEM-16).
--
-- Stamped after `202608040003_artifact_role.sql` (DEC-9's ordering rule: the schema is
-- never ahead of the code, and this column's readers change in the same commit).
--
-- ## What this is for
--
-- A VIRTUAL artifact — one of the fused columns of an integrated dataset — is an ordinary
-- `artifacts` row with the same id, datatype, axis and producer-declared `structure` as any
-- other, and NO blob behind it. The serve path resolves it through an alignment and gathers
-- the bytes on demand. Everything above the data plane is untouched; only the server knows.
--
-- ## Why there is NO `storage_kind` column (DEC-8, corrected)
--
-- The obvious shape is a discriminant column — `storage_kind = 'blob' | 'gathered'`. It was
-- decided against, and the reason is in `202608040002_artifact_model_drop.sql`, which removed
-- `storage_layout` for exactly this:
--
--     "Duplicated on the row a layout the DATATYPE already declares … and the manifest entry
--      already carries. Two sources for one value is the ambiguity INV-2 forbids."
--
-- and removed all four of its columns because
--
--     "Each was the SERVER holding an opinion about bytes it does not open."
--
-- A virtual artifact's defining fact is not a boolean. It is the presence of a RESOLUTION
-- RECIPE — `structure.gathered_from`, naming the alignment, its sources and the column
-- selector — which the serve path has to read anyway, in the same row read. A flag beside
-- that recipe would be two sources for one value, and unlike `storage_layout` the two could
-- DISAGREE:
--
--   * flagged gathered, no recipe  → unreadable; nothing says how to produce the bytes.
--   * recipe present, flag unset   → served as a blob that is not there.
--
-- The recipe cannot disagree with itself. So the recipe IS the discriminant, and the CHECK
-- below makes the incoherent row UNREPRESENTABLE rather than merely discouraged.
--
-- ## Why `object_key` becomes NULLABLE rather than `''`
--
-- A gathered artifact has no storage address. The three candidate spellings:
--
--   object_key = ''      REFUSED. This is "absence silently becomes an empty value" — the
--                        exact antipattern `…0002` names and removes, where four columns
--                        carried `DEFAULT '{}' NOT NULL` so an omitted declaration became an
--                        empty one with nothing to distinguish them. An empty object key is a
--                        valid-looking address that resolves to nothing.
--   the alignment id     REFUSED. Overloads one column with two meanings, which is the same
--                        ambiguity in a new place.
--   NULL                 CHOSEN. Absence is the fact being recorded, and NULL is how a
--                        relation records it.
--
-- Note this does NOT reintroduce what `…0002` criticised. Its complaint was about columns
-- with DEFAULTS, where absence became an empty value SILENTLY and unobservably. Here the
-- column has no default, NULL has one declared meaning, and the CHECK constraint below makes
-- that meaning enforceable rather than conventional. `structure`/`meta` landed `NOT NULL with
-- NO default` for the same underlying reason: absence must never be ambiguous. For this
-- column, absence is the information.
--
-- `content_hash` stays NOT NULL and is deliberately untouched: a gathered artifact HAS one,
-- over its DEFINITION (alignment id + source ids + column selector) rather than over bytes.
-- That is what keeps it deterministic and immutable, so the existing
-- `private, max-age=31536000, immutable` response header stays valid and a browser caches a
-- gathered chunk like any other.

ALTER TABLE public.artifacts ALTER COLUMN object_key DROP NOT NULL;

-- The pairing, stated as a constraint so it cannot be violated by any writer — including a
-- future one that has never read this file.
--
-- `jsonb_exists(structure, 'gathered_from')` rather than the `?` operator: `?` is a
-- parameter placeholder in several drivers and query tools, and a CHECK constraint's text is
-- re-parsed by anything that inspects the schema. The function form has no such ambiguity.
--
-- Exhaustive by construction — exactly one of the two arms holds for every row:
--   * a stored artifact  : object_key IS NOT NULL, no recipe.
--   * a gathered artifact: object_key IS NULL,     recipe present.
-- The two incoherent combinations (both, or neither) are what this refuses.
ALTER TABLE public.artifacts
    ADD CONSTRAINT artifacts_bytes_or_recipe CHECK (
        (object_key IS NOT NULL AND NOT jsonb_exists(structure, 'gathered_from'))
     OR (object_key IS NULL     AND     jsonb_exists(structure, 'gathered_from'))
    );

COMMENT ON COLUMN public.artifacts.object_key IS
    'The object-store address of this artifact''s bytes, or NULL when it has none. NULL is not "unknown" and not "empty": it means the row is GATHERED, and `structure.gathered_from` carries the recipe that produces the bytes on demand. The `artifacts_bytes_or_recipe` CHECK enforces that exactly one of the two is present, so a reader may treat a NULL key as a guarantee that the recipe is there.';

COMMENT ON CONSTRAINT artifacts_bytes_or_recipe ON public.artifacts IS
    'Stored-xor-gathered. Refuses a row that has both an object key and a gather recipe (which source wins?) and a row that has neither (unreadable by every path). Deliberately a constraint rather than a convention: the discriminant is the recipe itself, so the two can never disagree, and this is what makes that structural instead of aspirational.';
