// The `data` capability IMPLEMENTATION (ITEM-10) — a thin, PURE bind of the
// published `DataApi` contract onto a project-bound `DataHost` plane.
//
// Deliberately dependency-light (no React, no ApiClient): the real plane wiring
// lives in `./dataHost.ts`, which `./index.ts` composes in. That split is what
// keeps this unit directly runnable in the `node --test` runner.

import type { TypeSelector } from '@/modules/workbench/core'
import type { ColumnarTableData } from '@/core/workstore'
import type {
  ArtifactQuery,
  ColumnarFrameOnChunk,
  ColumnarFrameRead,
  DataApi,
  DataHost,
} from './contract.ts'

/** The columnar reader this bind is given (ITEM-42). INJECTED rather than imported so this unit
 *  stays IO-free and directly runnable in the `node --test` runner — the real one
 *  (`./columnarRead.ts`) reaches the project's streaming source and the workstore, neither of
 *  which belongs in a pure bind. */
export type ColumnarFrameReader = (
  read: ColumnarFrameRead,
  onChunk?: ColumnarFrameOnChunk,
) => Promise<ColumnarTableData>

function toQuery(sel: ArtifactQuery | TypeSelector): ArtifactQuery {
  if ('type' in sel || 'subtypesOf' in sel || 'capability' in sel || 'onAxis' in sel)
    return sel as ArtifactQuery
  const ts = sel as TypeSelector
  // NOTE: the catalog endpoint filters by a SINGLE `capability`; a selector with
  // multiple capabilities is narrowed by the first here and the rest are enforced
  // client-side by the caller (the picker) — an explicit limitation, not a silent
  // drop (audit MAINT-3). Widen `ArtifactQuery.capability` to `string[]` when the
  // backend endpoint gains multi-capability filtering.
  return {
    type: ts.type_id ?? undefined,
    subtypesOf: ts.subtypes_of ?? undefined,
    capability: ts.capabilities?.[0],
  }
}

/**
 * Bind the published contract to a plane + a project.
 *
 * `deps.readColumnarFrame` is what the ONE-byte-route read (ITEM-42) is served by. It is
 * OPTIONAL here and REQUIRED in practice: `createDataCapability` — the only production creator,
 * and the one the gallery/e2e fake host goes through too — always supplies it. Absent, the read
 * REFUSES by name rather than quietly falling back to a second byte route, which is the whole
 * failure DEC-20 forbids and would be invisible if it were a fallback (same fail-loud rule
 * DEC-15 applied to the transport).
 */
export function createDataApi(
  host: DataHost,
  projectId: string,
  deps: { readColumnarFrame?: ColumnarFrameReader } = {},
): DataApi {
  return {
    catalog: () => host.catalog(projectId),
    artifacts: {
      query: sel => host.listArtifacts(projectId, toQuery(sel)),
    },
    readColumn: read => host.readColumn(read),
    read: read => host.readArtifact(read),
    readOpaque: ({ artifactId }) => host.readOpaque(artifactId),
    readColumnarFrame: (read, onChunk) => {
      const reader = deps.readColumnarFrame
      if (!reader) {
        return Promise.reject(
          new Error(
            'the data capability was created without a columnar reader, so there is no byte ' +
              'route for readColumnarFrame — createDataCapability supplies one; a bare ' +
              'createDataApi bind does not',
          ),
        )
      }
      // `onChunk` (incremental-landing ITEM-7) is forwarded verbatim: a progressive consumer gets
      // each prefix; a plain caller (no `onChunk`) gets exactly the wholesale frame.
      return reader(read, onChunk)
    },
    previewValues: request => host.previewValues(request),
  }
}
