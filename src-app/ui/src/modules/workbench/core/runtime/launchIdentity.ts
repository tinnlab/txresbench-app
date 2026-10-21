// launchIdentity — what makes two launches THE SAME launch.
//
// A run's identity is the pair it actually receives: its analysis, and the `(inputs, params)`
// it was submitted with (DEC-1). Not the analysis alone — that would refuse two legitimate
// different-parameter runs — and not a free-form label, which names nothing the run consumed.
//
// The identity has ONE job: telling an accidental second click apart from a deliberate re-run.
// So it must be stable under things that do not change what the compute receives — key order
// above all. An identity that varies with key order is worse than none, because the guard then
// fires intermittently and gets blamed on something else.

/**
 * Canonical JSON: objects emit their keys SORTED, at every depth. Arrays keep their order,
 * because an array's order is data (a slot list, a criteria list) rather than an accident of
 * how the object was built.
 *
 * `JSON.stringify` alone is not enough — it preserves insertion order, so `{a:1,b:2}` and
 * `{b:2,a:1}` serialize differently while describing the same submission.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members are absent from a JSON body, so they must not change the identity —
    // otherwise a form that sets a field back to `undefined` reads as a different submission.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
}

/**
 * The identity of one launch: `<analysisId>::<canonical (inputs, params)>`.
 *
 * Returned as the canonical STRING rather than a digest. A hash would buy nothing here — the
 * set of in-flight launches is tiny and lives in memory for seconds — and a string that can be
 * read is worth a great deal when a guard misfires and someone has to find out why.
 */
export function launchIdentity(
  analysisId: string,
  inputs: unknown,
  params: unknown,
): string {
  return `${analysisId}::${canonicalize({ inputs: inputs ?? {}, params: params ?? {} })}`
}
