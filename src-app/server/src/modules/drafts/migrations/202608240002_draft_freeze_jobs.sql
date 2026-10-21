-- drafts module — the freeze-job ↔ draft mapping (DEC-2 final: async job-dependency
-- auto-freeze).
--
-- The async auto-freeze mechanism enqueues a freeze PRODUCER job per open draft and
-- makes the consuming job `blocked` on it (a `job_dependencies` edge). When the freeze
-- job completes, the jobs completion hook must resolve WHICH draft that job froze, so it
-- can stamp the draft `frozen` and substitute the minted `artifact_ref` into every
-- dependent consumer's persisted params BEFORE unblocking them. This table is that
-- mapping (one row per freeze producer job). It is ALSO the dedup index: a second
-- consumer of the same still-open draft reuses the in-flight freeze job rather than
-- enqueuing a duplicate.
--
-- Ordering: applies after the drafts baseline (202608240001, the `draft_id` FK) and the
-- jobs baseline (the `job_id` FK). Both FK targets exist by this prefix.

-- `content_hash` is the CONTENT-AWARE dedup key: a hash of the `draft.data` this freeze
-- captured at create time (draftable-entity DEC-2, round-3). Dedup reuses an in-flight
-- freeze ONLY when its `content_hash` matches the draft's CURRENT content — so a draft
-- edited mid-freeze (an earlier freeze froze snapshot S1; the draft now holds S2) does
-- NOT reuse the S1 freeze and consume a stale snapshot; a fresh producer freezes S2.
CREATE TABLE public.draft_freeze_jobs (
    job_id uuid NOT NULL,
    draft_id uuid NOT NULL,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT draft_freeze_jobs_pkey PRIMARY KEY (job_id)
);

-- The completion hook + the in-flight dedup both look up by draft_id.
CREATE INDEX draft_freeze_jobs_draft_idx ON public.draft_freeze_jobs USING btree (draft_id);

-- A freeze job deleted (job GC) drops its mapping; a draft deleted (project cascade)
-- drops it too — the mapping never outlives either endpoint.
ALTER TABLE ONLY public.draft_freeze_jobs
    ADD CONSTRAINT draft_freeze_jobs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.draft_freeze_jobs
    ADD CONSTRAINT draft_freeze_jobs_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.drafts(id) ON DELETE CASCADE;
