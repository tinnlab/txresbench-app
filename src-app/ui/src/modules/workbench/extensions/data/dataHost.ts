// The REAL `data` plane (ITEM-10) — lifted verbatim out of the old
// `workbench/host/createHost.ts`, which used to build seven unrelated things in
// one file. Maps `ApiClient.Workstore` responses onto the published contract's
// shapes. This is the only file in `extensions/data` that touches the app's
// ApiClient, so `dataCapability.ts` stays pure + node-testable.

import { ApiClient } from '@/api-client'
import type { Artifact, ListedArtifact, ProjectCatalog as ApiProjectCatalog } from '@/api-client/types'
import { fetchColumn } from '@/core/datatypes'
import {
  fetchArtifactRange,
  parseStructure,
  previewableColumn,
  previewColumnValues,
} from '@/core/workstore'
import type { ArtifactQuery, ArtifactRow, AxisSummary, DataHost, ProjectCatalog } from './contract.ts'

/** The per-ROW half of the wire→row mapping. Exported alongside {@link toProjectCatalog}
 *  so the shipped-form conformance tier can model BOTH project reads — the overview
 *  (`Artifact`, no provenance) and the list (`ListedArtifact`, with it) — from one
 *  fixture, and hold shut which of the two an input picker resolves against. */
export function toArtifactRow(a: Artifact | ListedArtifact): ArtifactRow {
  // The derived source-dataset fields are present only on the LIST endpoint
  // (`ListedArtifact`); the catalog overview returns a bare `Artifact` (undefined here).
  const listed = a as Partial<ListedArtifact>
  return {
    id: a.id,
    // `Artifact.project_id` is nullable since ITEM-23 (a run may be dataset-scoped);
    // the workbench catalog is project-scoped, so these rows always carry one — fall
    // back to '' for the type contract.
    project_id: a.project_id ?? '',
    datatype: a.datatype,
    // ITEM-25: the producer's decode contract rides the row, so a consumer never
    // re-fetches the artifact just to learn how to read its bytes.
    structure: a.structure,
    // The producer's display metadata, carried through so a picker can NAME its options
    // (see `ArtifactRow.meta`). Dropping it made every single-column candidate read "values".
    meta: a.meta,
    // The artifact's CONTENT IDENTITY. An axis IS its key artifact and `AxisSummary`
    // identifies it by exactly this hash, so without carrying it the wire delivers the
    // axis's identity and the row it belongs to and leaves nothing to join them BY —
    // which forces a consumer back onto the axis LABEL, the one thing INV-3 says is
    // never a key. Both wire row types declare it, so neither read loses it.
    content_hash: a.content_hash,
    // The object's STORAGE length (#159) — declared by both wire row types, so neither read
    // loses it, and carried for the range reader that opens a pyramidal raster. See
    // `ArtifactRow.stored_bytes` for why a range reader cannot work without it.
    stored_bytes: a.stored_bytes,
    created_at: a.created_at,
    // The artifact's own TENANCY SCOPE (ITEM-23), which BOTH wire row types declare — unlike
    // the derived lineage below, which only the list endpoint can answer. Carried because it
    // is the scope a layout's declared component columns are resolved in (ITEM-13): a
    // narrowing inserts every gathered artifact under the new dataset's id
    // (`virtual_dataset.rs:1725`), so this equality is what says two rows came out of the
    // SAME narrowing. Dropping it here would have left that join unanswerable on the
    // overview read — the only read the canvas performs — which is the same shape of latent
    // inertness the `meta` line above records.
    dataset_id: a.dataset_id ?? null,
    // The SET is the authoritative lineage fact; the singular pair beside it is the wire's
    // exactly-one convenience and is null for an integration of two datasets — carry both,
    // so a scoping consumer can intersect sets while a label can still take the short path.
    source_dataset_ids: listed.source_dataset_ids ?? null,
    source_dataset_names: listed.source_dataset_names ?? null,
    source_dataset_id: listed.source_dataset_id ?? null,
    source_dataset_name: listed.source_dataset_name ?? null,
    // WHO PRODUCED IT. Derived server-side (the producing run's `generator_id`) and, like
    // the two fields above, present only on the LIST row — the overview returns a bare
    // `Artifact`, so this is `null` there. A consumer that needs to tell its own previous
    // output from another producer's must therefore resolve against `artifacts.query`,
    // which is the same conclusion `source_dataset_id` already forces.
    generator_id: listed.generator_id ?? null,
  }
}

/**
 * The WIRE → ROW mapper. Exported because it is a SEAM worth pinning: what a picker can
 * resolve is decided here, by which fields the endpoint's response type can carry, and a
 * test that hand-builds `ArtifactRow`s cannot see that. The shipped-form conformance tier
 * (`core/render/shippedFormConformance.test.tsx`) drives its catalog through this function
 * from a fixture typed as the generated wire type, so the fixture cannot express a field
 * the endpoint does not deliver.
 */
export function toProjectCatalog(c: ApiProjectCatalog): ProjectCatalog {
  return {
    project_id: c.project_id,
    // The wire already speaks the open axis set; carry it through unchanged (the
    // server orders `axes` by the declared axis order of the project's datatypes).
    //
    // `content_hash` rides along because it is the axis's IDENTITY (INV-3) and this map
    // is the ONLY hop between the wire and every workbench axis consumer. Projecting to
    // `{name,length}` here — as this line did — put the identity on the wire and then
    // threw it away one function later, leaving every consumer with nothing but the
    // label to key on, i.e. upholding the invariant on the server and violating it
    // everywhere the axes are actually used.
    axes: (c.axes ?? []).map(a => ({
      content_hash: a.content_hash,
      name: a.name,
      length: a.length,
      // ITEM-31 — the axis's ordered key sequence, carried across for the same reason
      // `content_hash` is: projecting it away here would put it on the wire and throw it
      // away one function later, leaving the membership question unaskable without a full
      // artifact fetch.
      key_sequence_digest: a.key_sequence_digest ?? undefined,
    })),
    artifacts: c.artifacts.map(toArtifactRow),
  }
}

export function createDataHost(): DataHost {
  return {
    catalog: async projectId => toProjectCatalog(await ApiClient.Workstore.getCatalog({ project_id: projectId })),
    listArtifacts: async (projectId, query: ArtifactQuery) => {
      const rows = await ApiClient.Workstore.listArtifacts({
        project_id: projectId,
        datatype: query.type,
        subtypes_of: query.subtypesOf,
        capability: query.capability,
        on_axis: query.onAxis,
      })
      return rows.map(toArtifactRow)
    },
    // Typed-array column read. A feature column needs a name→index map the feature axis owns
    // (P1/P8); a non-numeric selector is that DEFERRED case → an intentional empty
    // column (not an error). But a genuine read FAILURE (404 / 500 / permission /
    // malformed) is NOT silently swallowed into an empty column (which the canvas can't
    // distinguish from "no data" — a blank canvas with no trace): it is LOGGED and
    // rethrown so the caller (a live consumer surfaces it) can react instead of
    // painting blank silently.
    readColumn: async read => {
      const art = await ApiClient.Workstore.getArtifact({ id: read.artifactId })
      const ref = {
        id: art.id,
        datatype: art.datatype,
        structure: art.structure,
      }
      // `selector` as a numeric column index (obs/categorical fast path); feature columns need
      // the var lookup (deferred), so a non-numeric selector yields an empty column.
      const col = read.selector != null ? Number(read.selector) : 0
      if (!Number.isFinite(col)) return { values: new Float32Array() }
      try {
        const sparse = await fetchColumn(ref, col)
        return { values: sparse.value }
      } catch (e) {
        console.error('[workbench] readColumn failed', read.artifactId, e)
        throw e
      }
    },
    // Opaque artifact bytes (e.g. a `report/qc` obs.json) — served by the real,
    // Range-capable `GET /api/artifacts/{id}/data` (`serve_artifact_data`) via the
    // existing `fetchArtifactRange` client.
    //
    // ── IT USED TO SWALLOW, AND THAT WAS AN INV-9 VIOLATION (ITEM-41) ──────────────
    //
    // This was `catch { return new Uint8Array() }`, justified as "degrades to empty on
    // failure (a viewer treats an empty payload as 'no data yet'), mirroring
    // `readColumn`". Two things were wrong with that, and the second is why it survived:
    //
    //   1. It did NOT mirror `readColumn`. Read the sibling twenty lines above: it logs
    //      and RETHROWS, and its comment says why in as many words — a genuine failure is
    //      "NOT silently swallowed into an empty column (which the canvas can't
    //      distinguish from 'no data' — a blank canvas with no trace)". This arm did the
    //      exact thing its own comment claimed parity with refusing.
    //   2. A blank surface passes every health check there is. No console error, no
    //      failed assertion, no crash — just a pane showing nothing. That is precisely
    //      how it lasted: nothing that watches for breakage can see this break.
    //
    // With the server now refusing an unusable artifact with 409 +
    // `ARTIFACT_NOT_CONFORMING` / `ARTIFACT_UNRESOLVABLE`, swallowing is worse than
    // silent — it discards the ONE message that tells the user which remedy applies, and
    // renders "the source this was built from is gone" as an empty pane.
    //
    // So it throws, like its sibling. INV-9: never render short or empty.
    readOpaque: async (artifactId: string) => {
      try {
        return new Uint8Array(await fetchArtifactRange(artifactId))
      } catch (e) {
        console.error('[workbench] readOpaque failed', artifactId, e)
        throw e
      }
    },
    // Multi-column artifact bytes. A consumer that wants a DECODED table calls
    // `@/core/workstore` `readTable` with the row's `structure` (ITEM-25); this raw arm
    // has no in-tree caller and degrades to empty rather than guessing a member path.
    readArtifact: async () => new Uint8Array(),
    // A bounded value EXCERPT. A straight pass-through to the shipped reader — the whole
    // dispatch (declared encoding → level set from metadata, or a windowed byte range) is
    // `@/core/workstore`'s, because that module owns the stored-structure vocabulary and a
    // second copy here would be a second place for the "which member, decoded how"
    // decision to drift from the bytes.
    //
    // `structure` is the CALLER's — it rides the catalog row the picker already holds — so
    // unlike `readColumn` above this issues no `getArtifact` round trip just to learn how
    // to decode. `parseStructure` throws on an undeclared row and the throw PROPAGATES: a
    // failed preview is the caller's to absorb (it renders nothing, DEC-4), and swallowing
    // it here would take the distinction between "nothing to show" and "I could not find
    // out" away from the only layer that can act on it.
    previewValues: async ({ artifactId, structure, member, limit }) =>
      previewColumnValues(artifactId, parseStructure(artifactId, structure), { member, limit }),
  }
}

/** The seeded FAKE plane the gallery + unit-style e2e seams run against (no backend).
 *  Lifted verbatim from `makeFakeHost`'s inline `DataHost` literal — it moves WITH the
 *  real plane, or the gallery loses its data surface. */
export function makeFakeDataHost(opts: {
  projectId: string
  artifacts: ArtifactRow[]
  /** the synthetic DECLARED axes this fake plane reports (open axis set — the fake
   *  names no domain axis of its own; the caller seeds whatever its surface needs). */
  axes: AxisSummary[]
  isA(sub: string, sup: string): boolean
}): DataHost {
  const { projectId, artifacts, axes } = opts
  // The synthetic column length = the FIRST declared axis (the position axis).
  const nPositions = axes[0]?.length ?? 0
  return {
    catalog: async () => ({ project_id: projectId, axes, artifacts }),
    listArtifacts: async (_s, q) =>
      artifacts.filter(a => {
        if (q.type) return a.datatype === q.type
        if (q.subtypesOf) return opts.isA(a.datatype, q.subtypesOf)
        return true
      }),
    // A deterministic synthetic per-position column so the gallery's dimension-selector
    // preview shows a real, non-zero live count against the fake plane (no backend).
    readColumn: async () => {
      const values = new Float32Array(nPositions)
      for (let i = 0; i < nPositions; i++) values[i] = (i % 100) / 100
      return { values }
    },
    readArtifact: async () => new Uint8Array(),
    readOpaque: async () => new Uint8Array(),
    // A SYNTHETIC value excerpt, gated by the SAME encoding rule the real reader uses
    // (`previewableColumn`) so the fake refuses exactly what the real plane refuses — a
    // fake that previewed a numeric column would make DEC-3 unobservable in every suite
    // that runs against it.
    //
    // The values name their own artifact on purpose. This plane backs the shipped-form
    // conformance tier, which asserts that a bound control's preview is drawn from THAT
    // column and is REPLACED when the selection changes; an excerpt that did not identify
    // its source could satisfy both assertions while showing the wrong column's values.
    // They are also unmistakably synthetic, which is what a fake plane owes its reader.
    previewValues: async ({ artifactId, structure, limit }) => {
      const column = previewableColumn(structure)
      if (!column) return undefined
      const name = column.name ?? column.path
      const n = Math.max(0, Math.min(Math.trunc(limit), 3))
      if (n === 0) return undefined
      return {
        values: Array.from({ length: n }, (_, k) => `${name}-${artifactId}-${k + 1}`),
        source: column.kind === 'categorical' ? 'levels' : 'rows',
      }
    },
  }
}
