-- 202608040009 — a virtual dataset owns EXACTLY ONE mask, and it is hidden.
--
-- ── what a mask is (ITEM-1, §3.4 / DEC-1 / DEC-3) ──────────────────────────────────────────
--
-- A mask is the virtual dataset's per-source boolean ROW SELECTION: a packed boolean, one bit
-- per source row in that source's OWN order (`true` = kept), stored as ONE artifact OWNED by
-- the virtual dataset (`dataset_id = <VD>`). It is a `role='mask'`, `hidden=true` artifact
-- carrying REAL bytes — so it is a STORED artifact under `artifacts_bytes_or_recipe`
-- (`object_key IS NOT NULL`, no `gathered_from`); the gathered COLUMNS reference it through
-- `structure.gathered_from.mask_artifact_id`, the mask itself is not gathered.
--
-- `role='mask'` needs no CHECK amendment: `202608040003_artifact_role.sql` made `role` an
-- uncontrolled `text NOT NULL` column, so `mask` is representable already. It is auto-excluded
-- from the USABLE population by construction — `usable_artifacts` (`202608040006`) selects
-- `role='artifact'`, so a mask is never a first-class artifact a user can act on, over and
-- above the `hidden` flag that keeps it off the catalog listing.
--
-- ── the UNIQUE index is the exactly-one guard, in the database (DEC-3) ─────────────────────
--
-- "Exactly one mask per virtual dataset" is a property of the ROW SET, so it is enforced on
-- the rows, where it binds every writer — including a finalize sink that re-runs after a crash
-- (the same TOCTOU `datasets_one_per_alignment_run` guards for the alignment path). A
-- SELECT-then-INSERT in the sink would let two passes both see no mask and both insert, leaving
-- a virtual dataset with two masks and nothing to say which selects its rows. The sink instead
-- inserts optimistically and treats a unique violation as "already created".
--
-- PARTIAL (`WHERE role = 'mask'`) so it constrains ONLY masks: an ordinary `role='artifact'`
-- output of the same dataset — of which there are many (the gathered columns) — is untouched.
-- The mirror is `datasets_one_per_alignment_run` (`202608040005`): a partial unique index that
-- makes an idempotency key a database fact rather than an application convention.

CREATE UNIQUE INDEX artifacts_one_mask_per_dataset
    ON public.artifacts (dataset_id)
    WHERE role = 'mask';

COMMENT ON INDEX public.artifacts_one_mask_per_dataset IS
    'Exactly ONE mask per virtual dataset (ITEM-1 / DEC-3). Partial on role=''mask'' so only masks are constrained; the many role=''artifact'' gathered columns of the same dataset are untouched. The finalize sink inserts a mask optimistically and treats a violation here as "already created", the same idempotency shape as datasets_one_per_alignment_run.';
