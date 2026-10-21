// Pure, headless picker logic for the project's dataset ATTACH panel (ITEM-3 FE).
// Extracted so it's node-testable (`attachOptions.test.ts`) — the `.tsx` panel
// maps these candidates onto kit <Select> options with a datatype tag. Type-only
// imports are erased under `--experimental-strip-types`, so this file pulls in no
// runtime alias.

import type { DatasetListItem } from '@/api-client/types'

/** Where a candidate came from — drives the picker's "My datasets" / "Shared with me" groups. */
export type AttachSource = 'owned' | 'shared'

/** One selectable dataset in the attach picker (share-aware). */
export interface AttachCandidate {
  id: string
  name: string
  /** The P2 datatype id (DEC-1 type-metadata; null until the dataset is typed). */
  datatype?: string
  source: AttachSource
  /**
   * The dataset's DERIVED primary-processing status — `pending` | `running` |
   * `completed` | `failed`, or undefined when it has no processing job at all.
   *
   * The list endpoints have carried this since the library table started badging it;
   * the picker used to map its candidates out of a bare `Dataset`, a type that does
   * not declare the field, and so threw it away. A candidate that is NOT ready is
   * still offered (see `notReadyNote`) — it is MARKED, never removed.
   */
  processingStatus?: string
  /** The failure reason, when the server surfaced one (owners only). */
  processingError?: string
}

const byName = (a: DatasetListItem, b: DatasetListItem) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

/**
 * The share-aware attach-picker candidate list: the user's OWNED ∪ SHARED datasets
 * (DEC-3 visibility = owner ∪ sharees), minus the ones already linked to THIS project
 * (`attachedIds`). M:N (DEC-4) means many-to-one is allowed — a dataset linked to
 * OTHER projects stays selectable; only this project's existing links are removed.
 * Deduped by id (owned wins a collision), each source sorted by name, owned first.
 *
 * Nothing is filtered on readiness: a dataset whose processing FAILED is a candidate
 * like any other, carrying its status so the row can say so.
 */
export function mergeAttachCandidates(
  owned: readonly DatasetListItem[],
  shared: readonly DatasetListItem[],
  attachedIds: ReadonlySet<string>,
): AttachCandidate[] {
  const seen = new Set<string>()
  const out: AttachCandidate[] = []
  const take = (list: readonly DatasetListItem[], source: AttachSource) => {
    for (const d of [...list].sort(byName)) {
      if (attachedIds.has(d.id) || seen.has(d.id)) continue
      seen.add(d.id)
      out.push({
        id: d.id,
        name: d.name,
        datatype: d.datatype ?? undefined,
        source,
        processingStatus: d.processing_status ?? undefined,
        processingError: d.processing_error ?? undefined,
      })
    }
  }
  take(owned, 'owned')
  take(shared, 'shared')
  return out
}

/** Is this candidate's ingest done? `undefined` (no processing job) counts as ready. */
export function isReady(c: Pick<AttachCandidate, 'processingStatus'>): boolean {
  return c.processingStatus == null || c.processingStatus === 'completed'
}

/**
 * The consequence of linking a not-ready dataset, in the user's terms — shown NEXT TO
 * the Attach button once such a candidate is selected, i.e. BEFORE the click.
 *
 * `null` for a ready candidate. Linking is never blocked (DEC-6): the link is
 * reversible, the failed import can be re-run afterwards with the link already in
 * place, and refusing the choice is not the same as explaining it.
 */
export function notReadyNote(c: Pick<AttachCandidate, 'processingStatus' | 'processingError'>): string | null {
  if (isReady(c)) return null
  const reason = c.processingError ? ` ${c.processingError}` : ''
  if (c.processingStatus === 'failed') {
    return `This dataset's processing failed, so it holds nothing to analyse yet. You can still link it — re-run the import afterwards and the link stays.${reason}`
  }
  return 'This dataset is still being processed. You can link it now; its contents appear when processing finishes.'
}

/**
 * What a search query is matched against for a candidate.
 *
 * The kit `Select` filters on `searchText`, falling back to a STRING label and then
 * to the option `value`. This picker's label is a node, so without this the fallback
 * is the option value — the dataset's uuid — and typing a name matches nothing. The
 * haystack is the name plus the datatype LABEL (the string the row actually shows),
 * so both of the row's visible words are reachable by typing.
 */
export function candidateSearchText(c: AttachCandidate, datatypeLabel: string): string {
  return [c.name, datatypeLabel].filter(Boolean).join(' ')
}
