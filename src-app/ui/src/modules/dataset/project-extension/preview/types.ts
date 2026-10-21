// The dataset-preview CONTRIBUTION contract.
//
// ── What the app may say, and what it may not ───────────────────────────────────
//
// The app can COUNT (arithmetic) and it can repeat a datatype's declared display
// title. It cannot say what a dataset IS: nothing in the stored declarations connects
// a producer's `meta`/`structure` key to a display word, and inventing that mapping
// in app code is the domain leak INV-1/INV-2/INV-3 forbid.
//
// The first version of this seam let a contribution APPEND facts to a line the app
// composed — `65 artifacts · 41.5 MB · 1 <declared title> (<contributed facts>)`.
// That is the same leak one level up: the app was still deciding what a dataset row
// leads with, and it led with its own storage vocabulary and a byte total nobody
// chooses a dataset by. So a contribution no longer supplies facts to decorate a
// sentence — it supplies THE SENTENCE.
//
// ── The composition model ───────────────────────────────────────────────────────
//
// One contribution owns one complete PHRASE about the dataset, drawn from the group
// of artifacts of its own datatype, and declares WHERE that phrase sits in the line.
// The app's whole remaining job is to sort the phrases by their declared order and
// join them. A dataset summary is therefore assembled from every group that has
// something to say:
//
//     <phrase from package A> · <phrase from package B> · <phrase from package C>
//
// The alternative — one DATASET-level declaration owning the whole line — was
// rejected: a dataset can hold datatypes contributed by several packages, so a
// dataset-level declaration needs an anchor rule that picks ONE winner and silently
// drops what every other package had to say. Composition adds; arbitration discards.
//
// See `docs/design/dataset-attach-readiness-and-preview.md`.
//
// Type-only declarations: erased at build, so this file pulls in no runtime alias.

import type { DatasetArtifactGroup } from '@/api-client/types'

/**
 * What one package contributes about ITS OWN datatype.
 *
 * `phrase` receives the server's per-datatype group: the count, the size, and ONE
 * representative member's manifest slot name + BOTH producer declarations (`meta`,
 * what the bytes mean; `structure`, how to decode them). It is PURE and MUST NOT
 * THROW — a contribution that throws is caught and treated as silence, because a
 * picker must not be takeable down by a package's display code.
 *
 * It ALSO receives `title`: the display title of THIS GROUP's datatype, as that
 * datatype's own package declared it. It is passed IN rather than read here for the
 * reason the whole seam exists — the app is the only party that can resolve a group's
 * id against the datatype registry, and a contribution registered on a supertype must
 * state the SUBTYPE's name when it answers for one. The app supplies the word and
 * never edits it; the sentence it goes in remains the package's. A contribution is
 * free to ignore it (a phrase built from a count already names the thing).
 *
 * Returning `null` says "I cannot describe this group" (the declarations it reads are
 * not there). The app then shows its own count-and-title fallback for that group,
 * which is the honest floor: true, and made only of a number and a declared title.
 */
export interface DatasetPreviewContribution {
  /**
   * The datatype id this describes. Matched EXACTLY first, then up the `is_a`
   * lattice — so a contribution registered on a supertype covers every subtype that
   * has none of its own.
   */
  datatype: string
  /**
   * Where this phrase sits WHEN SEVERAL ARE SHOWN TOGETHER, ascending. It is part of
   * what the package decides: the headline fact about a body of artifacts is rarely
   * its most NUMEROUS group, and leaving the order to the app would hand back the very
   * decision this seam exists to move out of it.
   *
   * It used to be worded "where this phrase sits in the dataset's LINE", because the
   * dataset-attach picker was the only consumer and it joins the phrases into one
   * sentence. The artifacts pane is the second, and it stacks them as SECTIONS — the
   * same ranking question, a different geometry. Nothing about a declaration changes:
   * a package that put one of its phrases ahead of another meant "lead with this one",
   * and that reads correctly as a first clause and as a first heading. The narrower
   * wording was the only thing that was ever surface-specific.
   */
  order: number
  phrase: (group: DatasetArtifactGroup, title: string) => string | null
}

/** A contribution's answer for one group: where it sorts, and what it says (`null`
 *  when it declined). Distinguishing "no contribution at all" (the resolver answers
 *  `null`) from "a contribution that declined" matters: the second keeps its declared
 *  position in the line, so a dataset does not visibly re-order when one producer
 *  omitted a declaration. */
export interface ResolvedPhrase {
  order: number
  text: string | null
}

/**
 * The slice of the datatype lattice the resolver needs: proper supertypes of an id,
 * NEAREST FIRST. Injected rather than imported so the registry stays pure and is
 * directly testable against a hand-built lattice.
 *
 * `datatypeRegistry.ancestors` satisfies this as-is.
 */
export interface PreviewLattice {
  ancestors: (id: string) => string[]
}
