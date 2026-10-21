-- 202608040011 — a dataset may be created by a FILTER, and a filter dataset is unique per run.
--
-- `datasets_source_check` was `source = ANY (ARRAY['upload','promote','integrate'])`
-- (`202608040005_dataset_source_integrate.sql:33-35`). A FILTER virtual dataset — the row a
-- successful filter run creates, whose columns are gathered through a per-source MASK
-- rather than an alignment (§11.3, ITEM-13 / DEC-6) — is none of those three: it was not
-- uploaded, it is not a byte-preserving promotion, and it is NOT an integration (a filter has
-- ONE source and no join). Widening the vocabulary is what makes the filter sink's row
-- representable at all. `integrate` (alignment→VD) and `filter` (mask→VD) are DISTINCT creation
-- paths — the mirror, not the same value.
--
-- The value is `filter`, matching the analysis that produces it (the filter processor) and the
-- vocabulary §11.3 uses for the operation.
--
-- ── the UNIQUE index is the idempotency guard, and it is here rather than in Rust ────────────
--
-- The sink runs from `finalize_analysis_with`, reached TWICE for one run in a real deployment:
-- the normal completion, and `scheduler::reconcile_orphaned_running`'s boot re-finalize after a
-- crash. A SELECT-then-INSERT in the sink is a TOCTOU: both passes would see no row and both
-- would insert, leaving two filter datasets for one run with nothing to say which is real. So
-- the invariant lives in the database, where it binds every writer: at most ONE `filter`
-- dataset per `filter_run_id`. The sink inserts optimistically and treats a unique violation as
-- "already created", the same shape as `datasets_one_per_alignment_run` (`202608040005`).
--
-- PARTIAL (`WHERE source = 'filter'`) so an `upload`/`promote`/`integrate` row — which carries
-- no `filter_run_id` at all, i.e. SQL NULL — is untouched by it. The sibling
-- `datasets_integrate_declares_alignment` CHECK (`202608040008`) only constrains
-- `source = 'integrate'` rows, so a `filter` row is exempt and legitimately carries no
-- `metadata.alignment` — its selection rides the mask, not an alignment.

ALTER TABLE public.datasets
    DROP CONSTRAINT datasets_source_check;

ALTER TABLE public.datasets
    ADD CONSTRAINT datasets_source_check
    CHECK ((source = ANY (ARRAY['upload'::text, 'promote'::text, 'integrate'::text, 'filter'::text])));

CREATE UNIQUE INDEX datasets_one_per_filter_run
    ON public.datasets ((metadata ->> 'filter_run_id'))
    WHERE source = 'filter';
