-- 202608040008 — an `integrate` dataset must DECLARE the alignment it was produced by.
--
-- ── why this constraint exists: it replaces a comment that could not notice a new INSERT ──────
--
-- `workstore/detach_guard.rs` refuses to detach a dataset that a virtual dataset is built from.
-- Its transitive arm (`D -> V1 -> V2`) was deliberately deferred on a MEASURED premise: at the
-- time, nothing minted a `datasets` row for a gathered artifact, so `V1` did not exist and a
-- one-level refusal was complete.
--
-- The premise was true when written and false ~45 minutes later, when
-- `virtual_dataset.rs::create_for_run` became a fourth `INSERT INTO datasets` site. Nothing
-- failed. The guard silently became incomplete, and stayed that way, because the thing holding
-- the premise was PROSE.
--
-- The walk is now written. This constraint is the part that keeps it correct against the NEXT
-- writer. The walk traverses exactly one edge to discover a virtual dataset:
--
--     datasets.metadata -> 'alignment' ->> 'artifact_id'
--
-- A future site that mints a `source = 'integrate'` row without that edge would be invisible to
-- the guard in precisely the way the fourth site was — a chain constructible at the data layer
-- that the refusal cannot see. It now cannot commit such a row at all.
--
-- **This is a STATE guard, not a syntax guard, and that is the point.** Counting
-- `INSERT INTO datasets` occurrences in the source would be a text scan a writer can evade by
-- accident (a different SQL spelling, a helper, a `COPY`) and would fire on harmless additions.
-- The invariant that actually matters is a property of the ROW, so it is enforced on the row,
-- where it binds every writer including one that has never read the guard.
--
-- ── scope ────────────────────────────────────────────────────────────────────────────────────
--
-- PARTIAL by construction: `upload` / `promote` rows carry no alignment and are untouched. It
-- asserts the KEY IS PRESENT AND NON-EMPTY, not that it resolves — a FK is impossible here
-- (the value is JSON text inside `metadata`, and `artifacts` rows can be deleted independently),
-- and "present" is the property the walk needs. A dangling id makes an alignment contribute no
-- identity, which is the same safe outcome as an alignment that produced nothing.
--
-- No backfill clause is needed and none is written: the only producer of `integrate` rows is
-- the creator, which has always written `metadata.alignment.artifact_id`. `NOT VALID` +
-- `VALIDATE` is used anyway so an existing deployment carrying a row this rejects surfaces it as
-- a migration failure naming the constraint, rather than as a table-rewrite lock.

ALTER TABLE public.datasets
    ADD CONSTRAINT datasets_integrate_declares_alignment
    CHECK (
        source <> 'integrate'
        OR (
            metadata -> 'alignment' ->> 'artifact_id' IS NOT NULL
            AND metadata -> 'alignment' ->> 'artifact_id' <> ''
        )
    ) NOT VALID;

ALTER TABLE public.datasets
    VALIDATE CONSTRAINT datasets_integrate_declares_alignment;
