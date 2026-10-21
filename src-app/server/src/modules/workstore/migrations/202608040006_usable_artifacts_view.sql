-- workstore — ONE definition of the **usable** artifact population.
--
-- There are exactly two defensible populations over `artifacts`, and which one a query
-- uses is what a number on screen MEANS:
--
--   * USABLE  — `status='ready' AND NOT hidden AND role='artifact'`. What a user can act
--               on: the conformance gate passed it, it is not a deliberately
--               out-of-listing alternate representation, and it is the promotable tier
--               rather than a viz-only intermediate (DEC-8). This view.
--   * PRESENT — every row. What is STORED, whatever state it reached. Correct for the
--               blob keep-set and the delete cascade (`all_blob_refs`,
--               `object_keys_for_project_in_tx`), which are about bytes on disk and not
--               about what a consumer may read. Those keep querying `artifacts`.
--
-- Before this view the USABLE predicate was hand-written in each place that needed it,
-- and the copies disagreed: the project-level footprint had no WHERE clause at all while
-- rendering its total as "N results", so a project holding a failed upload reported one
-- count and byte total on its project tag and a different one on its dataset rows, with
-- nothing saying they measured different sets. Two hand-written copies were already
-- enough to drift; a view cannot.
--
-- It is a view and not a predicate constant on purpose. Rust cannot share a fragment of
-- SQL between two `sqlx::query!` sites (the macro requires a string literal), so a
-- Rust-side constant would still leave the text duplicated. Putting the definition in the
-- database makes the choice of population a choice of FROM clause — visible in every
-- query, impossible to half-apply, and still compile-time verified by sqlx.
--
-- `SELECT *` is deliberate: the view is a POPULATION, not a projection. A column added to
-- `artifacts` is available to usable-population queries without a second migration, and
-- no caller has to learn that this view carries a narrower row than the table.
CREATE VIEW public.usable_artifacts AS
    SELECT * FROM public.artifacts
     WHERE status = 'ready'
       AND NOT hidden
       AND role = 'artifact';

COMMENT ON VIEW public.usable_artifacts IS
    'The USABLE artifact population: status=ready, not hidden, role=artifact. Any count or byte total a user reads as "what is in here" is computed over THIS, not over `artifacts`. `artifacts` itself is the PRESENT population (everything stored, whatever its state) and is what the blob keep-set and delete cascade must use. Do not hand-write this predicate.';
