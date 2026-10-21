// How a binding was CHOSEN — the one vocabulary, so the four sites that bind and the
// wire that carries them cannot come to disagree about it.
//
// Until this existed, a value the system picked was byte-identical to one a human
// selected: `RunInput` was `{slot, artifactId}`, the wire `{slot, artifact_ref}`, the
// recorded edge `{slot, kind, ref_id, content_hash}`. Nothing past the control could
// tell them apart, which is why two rules already in force could not hold — R2's
// *"that is a DECLARED affordance … so the form shows what it bound"* and R8's *"an
// unverified assumption travels as far as the code can carry it … a marker seen only
// at the moment of choosing is not a marker"*. See `docs/design/binding-origin.md`.
//
// Exported as a RULE rather than a local convention for the same reason
// `autoBindVerdict` is: a vocabulary observable only through one module's behaviour is
// one the next caller re-derives slightly differently.

/**
 * How a binding came to hold its value.
 *
 * TWO values, deliberately. A declared `default:` in a view spec is a third thing and
 * is NOT in this vocabulary (DEC-3): it is authored by the package and visible in the
 * form before anyone touches it, which is precisely the consent R2 asks for. Sole
 * candidacy is not consent; a declared default is.
 */
export type BindingOrigin = 'user' | 'auto'

/** A human chose this value. The DEFAULT of every write — the only way to record
 *  `auto` is to ask for it, so a site that forgets cannot silently under-report. */
export const ORIGIN_USER: BindingOrigin = 'user'

/** The system chose this value, from sole candidacy, under a DECLARED
 *  `auto_bind_sole_candidate`. Nobody has reviewed it. */
export const ORIGIN_AUTO: BindingOrigin = 'auto'

/**
 * Fold two origins into the one that must be reported.
 *
 * **`auto` wins.** A slot fed by several references is unreviewed if ANY of them is:
 * the reviewed half does not launder the unreviewed one. The fold is conservative in
 * the direction where being wrong is a false ALARM rather than a false all-clear.
 *
 * Two undefineds stay `undefined` — absence is a real answer here, not a value to be
 * defaulted (INV-4). One defined side wins over an undefined one for the same reason:
 * "we know this much" beats "we know nothing".
 */
export function strongerOrigin(
  a: BindingOrigin | undefined,
  b: BindingOrigin | undefined,
): BindingOrigin | undefined {
  if (a === ORIGIN_AUTO || b === ORIGIN_AUTO) return ORIGIN_AUTO
  if (a === ORIGIN_USER || b === ORIGIN_USER) return ORIGIN_USER
  return undefined
}

/**
 * The user-facing wording of the ORIGIN mark — ONE object, for every surface that shows it.
 *
 * It lives HERE, beside the vocabulary rather than beside any one control, because four
 * surfaces render it: the declared `artifact_ref` widget's sole-candidate summary, the
 * fallback form's artifact-ref control, the run panel's inputs summary, and (in its own
 * prose form) the pane anchor. Two of those are in `core` and two are in `extensions`, so
 * the only place all four can reach without a layer-boundary violation is the `core`
 * barrel — and the alternative, a literal per surface, is the same fact waiting to drift
 * into four slightly different claims. That drift is the shape of the defect this whole
 * change exists to fix, so reproducing it in the copy would be a poor joke.
 *
 * "Chosen for you" rather than "auto-bound": it names what happened to the reader, not the
 * mechanism that did it. R8's corollary is that markers stay rare or they stop being read,
 * so it is short.
 */
export const BINDING_ORIGIN_COPY = {
  /** On the control itself. Present without hover and without focus — a mark a reader has
   *  to uncover is the disclaimer R8 refuses to count as a marker. */
  autoBound: 'Chosen for you',
  /** Mid-sentence, where it qualifies a slot NAME rather than labelling a control. */
  autoBoundSummary: 'chosen for you',
} as const
