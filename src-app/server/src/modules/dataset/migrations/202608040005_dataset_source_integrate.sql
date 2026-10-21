-- 202608040005 — a dataset may be INTEGRATED, and an integrated dataset is unique per run.
--
-- `datasets_source_check` was `source = ANY (ARRAY['upload','promote'])`
-- (`202608030002_dataset_baseline.sql:80`). A virtual dataset — the row a successful
-- integration run creates, whose columns are gathered THROUGH an alignment rather
-- than stored — is neither: it was not uploaded and it is not a byte-preserving promotion of
-- one artifact. Widening the vocabulary is what makes the creator's row representable at all.
--
-- The value is `integrate`, matching the analysis that produces it and the vocabulary the
-- rest of the tree already uses for that operation (`is_integrate_job`, `IntegrationSink`).
--
-- ── the UNIQUE index is the idempotency guard, and it is here rather than in Rust ────────
--
-- The creator runs from `finalize_analysis_with`, which is reached TWICE for one run in a
-- real deployment: the normal completion, and `scheduler::reconcile_orphaned_running`'s boot
-- re-finalize after a crash. A SELECT-then-INSERT in the creator is a TOCTOU: both passes
-- would see no row and both would insert, leaving two virtual datasets for one alignment
-- with nothing to say which is real. `insert_artifact`'s own idempotency key
-- (project/dataset/run/output) cannot help, because the second pass would mint a SECOND
-- dataset id and therefore a disjoint key.
--
-- So the invariant lives in the database, where it binds every writer including one that has
-- not read the creator: at most ONE `integrate` dataset per `alignment_run_id`. The creator
-- inserts optimistically and treats a unique violation as "already created", which is the
-- correct outcome rather than an error.
--
-- PARTIAL (`WHERE source = 'integrate'`) so an `upload`/`promote` row — which carries no
-- `alignment_run_id` at all, i.e. SQL NULL — is untouched by it.

ALTER TABLE public.datasets
    DROP CONSTRAINT datasets_source_check;

ALTER TABLE public.datasets
    ADD CONSTRAINT datasets_source_check
    CHECK ((source = ANY (ARRAY['upload'::text, 'promote'::text, 'integrate'::text])));

CREATE UNIQUE INDEX datasets_one_per_alignment_run
    ON public.datasets ((metadata ->> 'alignment_run_id'))
    WHERE source = 'integrate';
