-- 202608040010 — a MULTI-SOURCE gather must DECLARE its alignment (ITEM-2, §3.4-correction / DEC-8).
--
-- ── why this constraint exists: guard the STATE, not the syntax ────────────────────────────
--
-- `structure.gathered_from.alignment_artifact_id` became NULLABLE in this change: a single-
-- source FILTER carries no join — there is nothing to align a lone source to — so its row
-- selection rides a MASK (`mask_artifact_id`) and its alignment is legitimately absent. An
-- INTEGRATION fuses two or more sources, and the join ACROSS them is the AUTHORITY no reader
-- may re-derive (INV-3). So the two are not symmetric: `sources >= 2` REQUIRES an alignment,
-- `sources <= 1` does not.
--
-- A multi-source recipe with a null alignment would let the serve path re-derive the join from
-- the sources' columns — the exact re-derivation INV-3 forbids — returning rows from an
-- intersection nobody computed, with a plausible count and the wrong biology. That is a
-- property of the ROW, so it is refused on the row: a violating recipe cannot commit at all,
-- and it binds every writer including one that has never read this file.
--
-- This mirrors `artifacts_bytes_or_recipe` (`202608040004`) and
-- `datasets_integrate_declares_alignment` (`202608040008`): the invariant is structural, so it
-- is a CHECK rather than an application-layer validation that a new INSERT site could bypass.
-- `GatheredFrom::parse` re-asserts the same rule at the READ boundary, so a `structure` that
-- somehow reached a reader without passing this is refused rather than served — belt and
-- suspenders, with the database as the load-bearing guard.
--
-- ── the predicate ─────────────────────────────────────────────────────────────────────────
--
-- Applies ONLY to gathered rows (`jsonb_exists(structure, 'gathered_from')`), so a STORED
-- artifact — no recipe, hence no `sources`/`alignment_artifact_id` — passes untouched. Uses
-- `jsonb_exists`/the `->` `->>` operators (not `?`) for the same reason
-- `artifacts_bytes_or_recipe` does: a CHECK's text is re-parsed by anything inspecting the
-- schema, and `?` is a driver parameter placeholder.
--
-- `jsonb_array_length(... -> 'sources')` is NULL when `sources` is absent, and `NULL <= 1` is
-- NULL — but the leading `NOT jsonb_exists(...)` arm already admits every non-gathered row, and
-- `GatheredFrom::parse` refuses a gathered recipe with an empty/absent `sources`, so a committed
-- gathered row always has a `sources` array here.
--
-- `NOT VALID` + `VALIDATE`: no existing gathered row violates this (every one built to date is
-- an integration that names its alignment), so validation is a fast metadata pass; splitting it
-- out surfaces any surprise as a named constraint failure rather than a table-rewrite lock.

ALTER TABLE public.artifacts
    ADD CONSTRAINT artifacts_recipe_alignment_or_single_source CHECK (
        NOT jsonb_exists(structure, 'gathered_from')
        OR jsonb_array_length(structure -> 'gathered_from' -> 'sources') <= 1
        OR (structure -> 'gathered_from' ->> 'alignment_artifact_id') IS NOT NULL
    ) NOT VALID;

ALTER TABLE public.artifacts
    VALIDATE CONSTRAINT artifacts_recipe_alignment_or_single_source;

COMMENT ON CONSTRAINT artifacts_recipe_alignment_or_single_source ON public.artifacts IS
    'A gather over >= 2 sources must name an alignment_artifact_id; a single-source (filter) gather may have a null alignment and ride a mask instead (ITEM-2 / DEC-8). Refuses a multi-source recipe with no alignment, which would re-derive the join INV-3 forbids. Mirrors artifacts_bytes_or_recipe: a STATE guard, not a syntax guard.';
