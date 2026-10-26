-- workstore — ONE definition of the **usable** artifact population — SQLite
-- dialect port (ITEM-9, sqlite-store) of
-- `src/modules/workstore/migrations/202608040006_usable_artifacts_view.sql`.
--
-- The two defensible populations (USABLE vs PRESENT), why the USABLE
-- predicate used to be hand-written in N places and why a VIEW (not a
-- Rust-side constant) is the answer, and why `SELECT *` is deliberate: see
-- the Postgres file — the view makes the choice of population a choice of
-- FROM clause, visible in every query, impossible to half-apply, still
-- compile-time verified by sqlx.
--
-- SQLite port notes (ITEM-9, DEC-8 type map): no `public.` prefix; the
-- `hidden` boolean column is INTEGER 0/1, and `NOT hidden` is kept verbatim
-- — SQLite's `NOT` over 0/1 is exact and the spelling stays byte-close to
-- the Postgres file. `COMMENT ON VIEW` becomes the comment below.

CREATE VIEW usable_artifacts AS
    SELECT * FROM artifacts
     WHERE status = 'ready'
       AND NOT hidden
       AND role = 'artifact';

-- The USABLE artifact population: status=ready, not hidden, role=artifact.
-- Any count or byte total a user reads as "what is in here" is computed over
-- THIS, not over `artifacts`. `artifacts` itself is the PRESENT population
-- (everything stored, whatever its state) and is what the blob keep-set and
-- delete cascade must use. Do not hand-write this predicate.
