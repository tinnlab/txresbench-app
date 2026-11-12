import type { TagTone } from '@txresbench/kit'

/**
 * The artifact-status VOCABULARY, in one place (ITEM-41).
 *
 * ── THE DISTINCTION THIS MODULE EXISTS TO PROTECT ─────────────────────────────────
 *
 * `failed` and `unresolvable` are both "you cannot read this", and they carry OPPOSITE
 * remedies. The server separated them deliberately — two `status` values and two 409
 * error codes — precisely so a client would not have to guess:
 *
 * - **`failed`** — the post-ingest conformance gate found the BYTES disagree with the
 *   `structure` their producer declared. The DATA is wrong. Remedy: delete it, or re-run
 *   its producer.
 * - **`unresolvable`** — the artifact's own declaration is intact and nothing about it is
 *   wrong; the SOURCES it reads through are gone or changed. Remedy: restore the source.
 *   **Deleting is NOT the fix here**, and a surface that blurs the two offers to destroy
 *   work that is perfectly good.
 *
 * That is the whole reason this is a vocabulary and not an inline ternary: a UI that
 * renders both as a red "failed" chip is actively harmful, and the way that happens is
 * someone adding one more branch at one more call site.
 *
 * ── WHY EVERY VALUE IS SPELLED OUT, INCLUDING THE BORING ONES ─────────────────────
 *
 * `pending` and `ready` are here so the map is EXHAUSTIVE over what the server can send.
 * An exhaustive map is what makes {@link describeArtifactStatus}'s fallback mean
 * "the server sent something this build has never heard of" rather than "one of the
 * cases nobody bothered to write down".
 */

/** A status the server is known to send. Mirrors `workstore/consume.rs`. */
export const KNOWN_ARTIFACT_STATUSES = ['ready', 'pending', 'failed', 'unresolvable'] as const

export type KnownArtifactStatus = (typeof KNOWN_ARTIFACT_STATUSES)[number]

export interface ArtifactStatusDescriptor {
  /** The raw server value. */
  status: string
  /** What a human calls it. */
  label: string
  /** Semantic kit tone — never a raw colour. */
  tone: TagTone
  /** Is this row readable? Only `ready` is. */
  usable: boolean
  /** WHAT THE USER SHOULD DO. Empty for the two states that need no action. */
  remedy: string
  /** True when this build does not recognise the value (see the fallback below). */
  unrecognised: boolean
}

const DESCRIPTORS: Record<KnownArtifactStatus, Omit<ArtifactStatusDescriptor, 'status' | 'unrecognised'>> = {
  ready: { label: 'Ready', tone: 'success', usable: true, remedy: '' },
  pending: { label: 'Pending', tone: 'info', usable: false, remedy: '' },
  failed: {
    label: 'Failed',
    tone: 'error',
    usable: false,
    // Says the DATA is wrong, and that deleting is a legitimate fix — which is exactly
    // what must NOT be said about `unresolvable` below.
    remedy: 'Its data does not match what its producer declared. Delete it, or re-run the analysis that made it.',
  },
  unresolvable: {
    label: 'Source missing',
    // WARNING, not ERROR, and the choice is deliberate: nothing about this artifact is
    // wrong. Rendering it in the same destructive red as `failed` is the visual half of
    // the conflation this module exists to prevent — it reads as "broken, delete it".
    tone: 'warning',
    usable: false,
    remedy: 'This is built from other datasets and one of them is missing or has changed. Restore or re-attach that source — deleting this will not fix it.',
  },
}

/**
 * Describe a status value for display.
 *
 * **The fallback is LOUD, not silent, and that is the point.** An unrecognised value gets
 * a `warning` tone and says plainly that this build does not recognise it, rather than
 * being rendered as a neutral grey word that looks like a normal state. The failure mode
 * being closed is a server that grows a fifth status while an older client renders it as
 * unremarkable — the same shape as the bug this item fixes, one version later. It is
 * never treated as usable: absence of a decision is not a privilege.
 */
export function describeArtifactStatus(status: string): ArtifactStatusDescriptor {
  const known = DESCRIPTORS[status as KnownArtifactStatus]
  if (known) return { status, ...known, unrecognised: false }
  return {
    status,
    label: status || 'Unknown',
    tone: 'warning',
    usable: false,
    remedy: `This version of the app does not recognise the state "${status}". Reload, or ask an administrator whether the server is newer than this client.`,
    unrecognised: true,
  }
}

/** Is `status` one this build knows about? Exported for the guard test — a new server
 *  value should be a deliberate addition here, not a surprise in the fallback. */
export function isKnownArtifactStatus(status: string): status is KnownArtifactStatus {
  return (KNOWN_ARTIFACT_STATUSES as readonly string[]).includes(status)
}

/**
 * WHICH source went missing, from the row's producer-declared `meta` (INV-9).
 *
 * **This is the half of INV-9 that a tone and a label cannot carry.** The invariant is not
 * "say it is unreadable" — it is *"invalidate loudly, **naming the missing or changed
 * source**"*. A user with forty datasets who is told only "source missing" has been given
 * a search, not an answer.
 *
 * The server writes `meta.unresolved_source` when it detects the invalidation and reads
 * the same key back for its 409 message, so this is the same fact through the catalog
 * rather than a second spelling of it.
 *
 * Returns `null` when the key is absent or not a non-empty string. **Absence must render
 * as an explicit "which source is not recorded", never as a plausible-looking blank** —
 * the server takes exactly that care in its own message, and a UI that silently omits the
 * name turns "we do not know" into "there is nothing to say".
 */
export function unresolvedSourceOf(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return null
  const value = (meta as Record<string, unknown>).unresolved_source
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** The sentence naming the missing source, for a row whose status is `unresolvable`.
 *  Never returns an empty string: an unrecorded source says so. */
export function missingSourceNote(meta: unknown): string {
  const name = unresolvedSourceOf(meta)
  return name
    ? `Missing source: ${name}`
    : 'Missing source: not recorded by the invalidation'
}
