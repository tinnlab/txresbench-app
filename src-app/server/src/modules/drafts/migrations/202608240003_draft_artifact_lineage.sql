-- drafts module — the FROZEN-ARTIFACT VERSION LINEAGE (INV-7 / GS-INV-6) —
-- SQLite dialect port (ITEM-11, sqlite-store) of
-- `src/modules/drafts/migrations/202608240003_draft_artifact_lineage.sql`.
--
-- A draftable entity freezes into an immutable content-addressed artifact. Editing a
-- FROZEN draft re-opens it (DEC-3) and the next freeze FORKS a new artifact — the past
-- is never mutated (INV-1/INV-6). This table records the fork EDGE between the prior
-- frozen artifact and the new one, plus a monotone `version`, so the frozen view can
-- render the version chain (`v3←v2←v1`) and a per-version membership delta.
--
-- The fork-edge is a DRAFTABLE concern, so it lives HERE (a drafts-module table) and NOT
-- as a column on the shared `artifacts` catalog (DEC-11): core interprets nothing about a
-- draft's `kind`, and the artifact catalog stays domain- and draftable-agnostic. One row
-- per frozen artifact that a draft was stamped to.
--
-- Ordering: applies after the drafts baseline (202608240001, the `draft_id` FK) and the
-- workstore artifact baseline (the `artifact_id` / `parent_artifact_id` FKs). All FK
-- targets exist by this prefix (unchanged).
--
-- SQLite port notes (ITEM-11): DEC-8 map (uuid -> BLOB, timestamptz -> TEXT RFC3339
-- UTC), the composite PK + named CHECK + FKs inline with the same names (the
-- `version >= 1` port), `USING btree` dropped.

CREATE TABLE draft_artifact_lineage (
    -- The frozen artifact this lineage row describes (the CHILD / this version). PK: an
    -- artifact is stamped to at most one draft-version.
    artifact_id BLOB NOT NULL,
    -- The draft whose freeze minted `artifact_id` (owner/audience scoping rides through it).
    draft_id BLOB NOT NULL,
    -- The PRIOR frozen artifact this version forked FROM. NULL for a first freeze (version 1).
    parent_artifact_id BLOB,
    -- Monotone version number within a lineage chain: a first freeze = 1, each re-freeze after
    -- an edit = parent.version + 1.
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT draft_artifact_lineage_pkey PRIMARY KEY (artifact_id),
    CONSTRAINT draft_artifact_lineage_version_positive CHECK (version >= 1),
    CONSTRAINT draft_artifact_lineage_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES artifacts (id) ON DELETE CASCADE,
    CONSTRAINT draft_artifact_lineage_parent_artifact_id_fkey FOREIGN KEY (parent_artifact_id) REFERENCES artifacts (id) ON DELETE SET NULL,
    CONSTRAINT draft_artifact_lineage_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES drafts (id) ON DELETE CASCADE
);

-- The chain-walk + per-draft lookup index (child → parent is the PK; parent → children here).
CREATE INDEX draft_artifact_lineage_parent_idx
    ON draft_artifact_lineage (parent_artifact_id);
CREATE INDEX draft_artifact_lineage_draft_idx
    ON draft_artifact_lineage (draft_id);
