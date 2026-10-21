// A preview contributed as DATA rather than as code — the interpreter half.
//
// `DatasetPreviewContribution.phrase` is a FUNCTION, which reads as "a contributing
// package must ship TypeScript". It does not have to. A package that owns a datatype
// can ship a `dataset-preview.yaml` beside its `manifest.yaml` naming, per datatype,
// which producer-declared values to read and the sentence to read them into; this
// module turns that declaration into the function the registry wants.
//
// ── The one property this file must keep ────────────────────────────────────────
//
// It knows NOTHING. There is no datatype id here, no declaration key, no word and no
// unit — a declaration supplies every one of them, so the next datatype needs a file
// and no code at all. That is also what keeps this side of the seam clear of
// `lint-no-domain-in-builtin`: the vocabulary lives in `packages/**`, which the
// guard deliberately does not scan because it IS the contributed domain.
//
// ── The template language, in full ──────────────────────────────────────────────
//
// A phrase is a template over ONE group. `{path}` is replaced by the value at that
// path; everything else is literal. There are exactly FOUR roots, and a path must
// start at one of them:
//
//   {count}            how many artifacts of this datatype the dataset holds. The
//                      app's own arithmetic over real rows — not a producer
//                      declaration.
//   {title}            the display title of THIS GROUP's OWN datatype, as its
//                      package declared it in `manifest.yaml`. See below: it is the
//                      one root that is neither arithmetic nor a producer bag.
//   {meta.<key>…}      the representative artifact's `meta` — what the bytes MEAN.
//   {structure.<key>…} the representative artifact's `structure` — how to DECODE
//                      them. A producer states an array's dimensions HERE, so this
//                      is the root a shape comes from.
//
// A path walks mappings by key and ARRAYS BY INDEX, so `{structure.shape.0}` is the
// first entry of the producer's own dimension list. Requiring the root spelt out is
// what makes a typo fail loudly: a bare `{n_vars}` names no root and is REJECTED,
// rather than silently resolving to nothing forever.
//
//   * A phrase is DROPPED — not rendered with a hole in it — when ANY path it names
//     is absent, `null`, or not a scalar. That is the degradation contract: a dataset
//     imported by a path that declared different keys shows the app's count-and-title
//     fallback, never `undefined × undefined`.
//   * A phrase MUST name at least one path that READS something — `{count}` or a bag
//     path. A constant string would be the file ASSERTING something about bytes
//     nobody read — the forecast INV-5 forbids — rather than reading a declaration
//     (or a real count), and `{title}` ALONE is that same assertion wearing a
//     placeholder: it renders the same words for a dataset holding one artifact and
//     for one holding a thousand.
//   * A stray `{` or `}` that is not part of a well-formed `{path}` is a REJECTION,
//     not literal text: silently rendering a typo'd `{structure.shap.0}` as itself is
//     how a broken template ships looking deliberate.
//
// ── Why `{title}` exists, when a template could just spell the word ─────────────
//
// A phrase made only of extents says how BIG the thing is and never what it IS, so a
// dataset holding two arrays of the same rank renders two bare number pairs and the
// reader cannot tell which is which. The missing word has to come from somewhere, and
// there are only three places it could:
//
//   a LITERAL in the template — rejected. A contribution is matched EXACTLY and then
//     up the `is_a` lattice, so ONE declaration on a supertype answers for every
//     subtype that has none of its own. A literal noun is therefore printed verbatim
//     over subtypes it was never written for, and the failure is the worst kind: a
//     confident, wrong label on a line whose whole job is to tell two things apart.
//   a word the APP composes — rejected, and not available anyway: nothing in the app
//     connects a producer's declaration to a display word, which is the leak
//     INV-1/INV-2/INV-3 forbid and the reason this seam exists.
//   the datatype's OWN declared title — this. It is the word the owning package
//     already chose in its `manifest.yaml`, resolved PER GROUP from the group's own
//     datatype, and passed through verbatim (the app never inflects or edits it —
//     the same rule `summary.ts::fallbackPartText` already follows for the same
//     string). A subtype states its own name; a supertype states the supertype's.
//
// So `{title}` widens the vocabulary rather than the app's licence: the app still
// contributes no word of its own, it only carries one package's word to the place
// another package's sentence asked for it.
//
// ── Cardinality ─────────────────────────────────────────────────────────────────
//
// An entry may declare `one:` beside `text:`; the app renders it when the group holds
// exactly ONE artifact. The app selects by CARDINALITY (arithmetic it owns) and never
// edits either string — inventing a plural for a contributed word is language- and
// term-specific, and it is not the app's word to inflect. Two forms is what a
// one-line preview needs; a language with more cardinality classes than that is a
// reason to widen this contract, not to guess here.
//
// Validation is FAIL-CLOSED PER FILE (the same choice `registerDeclarativeViews`
// makes at the analysis): one malformed entry drops that file's whole contribution
// and logs, so a half-applied declaration can never render a half-true line.

import type { DatasetArtifactGroup } from '@/api-client/types'
import type { DatasetPreviewContribution } from './types'

/** The declaration-schema version this interpreter understands. */
export const DECLARED_PREVIEW_API_VERSION = '2.0'

/** The root a path may start at, and what it resolves against. */
export const PHRASE_COUNT_ROOT = 'count'
export const PHRASE_TITLE_ROOT = 'title'
export const PHRASE_BAG_ROOTS = ['meta', 'structure'] as const
export type PhraseBagRoot = (typeof PHRASE_BAG_ROOTS)[number]

/** The roots that are a whole value on their own — naming a key inside one is an
 *  error, the same way naming a bag without a key is. */
const PHRASE_SCALAR_ROOTS: Record<string, string> = {
  [PHRASE_COUNT_ROOT]: 'a number',
  [PHRASE_TITLE_ROOT]: 'a word',
}

/**
 * Does this path READ something about the artifacts in the group?
 *
 * `{title}` does not: it is the datatype's own name, identical for every dataset that
 * holds that datatype, so a phrase made only of it states nothing that was measured.
 * That is the same objection the no-`{path}`-at-all rule makes, which is why the two
 * are one check.
 */
function readsSomething(path: string): boolean {
  return path.split('.')[0] !== PHRASE_TITLE_ROOT
}

/** One datatype's declared preview, as AUTHORED. */
export interface DeclaredPreview {
  datatype: string
  /** Where this phrase sits in the dataset's line, ascending. */
  order: number
  /** The phrase template. */
  text: string
  /** The template used instead when the group holds exactly one artifact. */
  one?: string
}

/** The outcome of reading one declaration document. `previews` is empty on failure. */
export interface DeclarationReadResult {
  ok: boolean
  previews: DeclaredPreview[]
  errors: string[]
}

/** What one phrase is rendered against: the app's count, the group's own datatype
 *  title, and both producer bags. */
export interface PhraseContext {
  count: number
  /** The group's OWN datatype's declared display title — VERBATIM, never inflected. */
  title: string
  meta: Record<string, unknown>
  structure: Record<string, unknown>
}

/** `{path}` — a dotted path of plain identifiers / array indices. Deliberately
 *  narrow: producer keys are plain identifiers, and a wider class would swallow a
 *  typo as a valid name. */
const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}/g

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** The paths a template names, in order of first appearance (deduped). */
export function placeholdersOf(template: string): string[] {
  const out: string[] = []
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** Is every brace in `template` part of a well-formed `{path}`? */
function bracesAreWellFormed(template: string): boolean {
  return !/[{}]/.test(template.replace(PLACEHOLDER_RE, ''))
}

/**
 * Why this path is not usable, or `null` when it is. A path that names no root, or
 * names a bag without a key, can never resolve — and a template that can never
 * resolve is indistinguishable, in the product, from a datatype nobody contributed
 * for. It is rejected at read time instead.
 */
export function pathError(path: string): string | null {
  const parts = path.split('.')
  const scalar = PHRASE_SCALAR_ROOTS[parts[0]]
  if (scalar !== undefined) {
    return parts.length === 1 ? null : `\`${parts[0]}\` is ${scalar} and takes no sub-path`
  }
  if (!(PHRASE_BAG_ROOTS as readonly string[]).includes(parts[0])) {
    return (
      `must start with \`${Object.keys(PHRASE_SCALAR_ROOTS).join('\` / `')}\` or ` +
      `\`${PHRASE_BAG_ROOTS.join('.\` / `')}.\``
    )
  }
  if (parts.length < 2) return `\`${parts[0]}\` is a mapping — name a key inside it`
  return null
}

/**
 * One value as display text — or `null` for anything that is not a scalar the server
 * would have kept. `compact_declaration` already drops nulls and mappings on the way
 * out, so this is the client-side restatement of the same rule rather than a second
 * opinion about them.
 */
function formatScalar(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : null
  if (typeof value === 'boolean') return String(value)
  return null
}

/** Walk a dotted path: mappings by key, arrays by index. `undefined` when the path
 *  runs off the end of what the producer declared. */
function valueAtPath(ctx: PhraseContext, path: string): unknown {
  let cur: unknown = ctx
  for (const seg of path.split('.')) {
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined
      cur = cur[Number(seg)]
    } else if (isPlainObject(cur)) {
      cur = cur[seg]
    } else {
      return undefined
    }
  }
  return cur
}

/**
 * A template rendered against one group's context — or `null` when any named path is
 * missing or non-scalar, which is the caller's signal to DROP the phrase entirely.
 */
export function renderPhrase(template: string, ctx: PhraseContext): string | null {
  let missing = false
  const out = template.replace(PLACEHOLDER_RE, (_whole, path: string) => {
    const rendered = formatScalar(valueAtPath(ctx, path))
    if (rendered === null) missing = true
    return rendered ?? ''
  })
  return missing ? null : out
}

/** A producer bag as a lookup. Anything that is not a mapping (the wire type is
 *  `unknown`) reads as empty. */
function bagOf(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

/** What a phrase is rendered against, for one group. `title` is the group's own
 *  datatype's declared display title, resolved by the caller (the app's only job with
 *  it is to carry it — see the `{title}` note in this file's header). */
export function phraseContextOf(group: DatasetArtifactGroup, title: string): PhraseContext {
  return {
    count: group.count,
    title,
    meta: bagOf(group.representative_meta),
    structure: bagOf(group.representative_structure),
  }
}

/** The keys one entry may carry — anything else is a typo, and a typo that parses is
 *  a declaration that silently does less than it says. */
const PREVIEW_KEYS = ['datatype', 'order', 'text', 'one']
const DOC_KEYS = ['apiVersion', 'previews']

function unknownKeys(obj: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(obj).filter(k => !allowed.includes(k))
}

/** Every problem a phrase template has, as messages. Empty ⇒ it is usable. */
function templateErrors(at: string, template: string): string[] {
  const errors: string[] = []
  const paths = placeholdersOf(template)
  if (!paths.some(readsSomething)) {
    errors.push(
      `${at}: reads nothing — a phrase must be READ from a declaration (or a real ` +
        `count), never asserted by this file. \`{${PHRASE_TITLE_ROOT}}\` on its own ` +
        'is an assertion too: it names the datatype without stating anything that ' +
        'was measured about the artifacts',
    )
  }
  if (!bracesAreWellFormed(template)) {
    errors.push(`${at}: has a brace that is not part of a {path}`)
  }
  for (const path of paths) {
    const why = pathError(path)
    if (why) errors.push(`${at}: \`{${path}}\` ${why}`)
  }
  return errors
}

/**
 * Read one declaration document (already YAML-parsed) into its declared previews.
 *
 * Every problem is collected rather than thrown, and `ok: false` means the WHOLE
 * document contributes nothing.
 */
export function readPreviewDeclaration(doc: unknown): DeclarationReadResult {
  const errors: string[] = []
  const fail = (): DeclarationReadResult => ({ ok: false, previews: [], errors })

  if (!isPlainObject(doc)) {
    errors.push('the document must be a mapping')
    return fail()
  }
  for (const k of unknownKeys(doc, DOC_KEYS)) errors.push(`unknown top-level key \`${k}\``)
  if (doc.apiVersion !== DECLARED_PREVIEW_API_VERSION) {
    errors.push(
      `apiVersion must be "${DECLARED_PREVIEW_API_VERSION}" (found ${JSON.stringify(doc.apiVersion)})`,
    )
  }
  if (!Array.isArray(doc.previews) || doc.previews.length === 0) {
    errors.push('`previews` must be a non-empty list')
    return fail()
  }

  const previews: DeclaredPreview[] = []
  const seen = new Set<string>()
  doc.previews.forEach((raw, i) => {
    const at = `previews[${i}]`
    if (!isPlainObject(raw)) {
      errors.push(`${at}: must be a mapping`)
      return
    }
    for (const k of unknownKeys(raw, PREVIEW_KEYS)) errors.push(`${at}: unknown key \`${k}\``)
    if (!isNonEmptyString(raw.datatype)) {
      errors.push(`${at}: \`datatype\` must be a non-empty string`)
      return
    }
    if (seen.has(raw.datatype)) {
      errors.push(`${at}: \`${raw.datatype}\` is declared twice in one document`)
      return
    }
    seen.add(raw.datatype)
    if (typeof raw.order !== 'number' || !Number.isFinite(raw.order)) {
      errors.push(`${at}: \`order\` must be a number — where this phrase sits in the line`)
      return
    }
    if (!isNonEmptyString(raw.text)) {
      errors.push(`${at}: \`text\` must be a non-empty string`)
      return
    }
    const problems = templateErrors(`${at}.text`, raw.text)
    if (raw.one !== undefined) {
      if (!isNonEmptyString(raw.one)) {
        problems.push(`${at}.one: must be a non-empty string when present`)
      } else {
        problems.push(...templateErrors(`${at}.one`, raw.one))
      }
    }
    if (problems.length > 0) {
      errors.push(...problems)
      return
    }
    previews.push({
      datatype: raw.datatype,
      order: raw.order,
      text: raw.text,
      ...(typeof raw.one === 'string' ? { one: raw.one } : {}),
    })
  })

  if (errors.length > 0) return fail()
  return { ok: true, previews, errors }
}

/** One declared preview as the registry's contribution shape. */
export function contributionOf(declared: DeclaredPreview): DatasetPreviewContribution {
  return {
    datatype: declared.datatype,
    order: declared.order,
    phrase: (group: DatasetArtifactGroup, title: string): string | null => {
      const template = declared.one !== undefined && group.count === 1 ? declared.one : declared.text
      return renderPhrase(template, phraseContextOf(group, title))
    },
  }
}
