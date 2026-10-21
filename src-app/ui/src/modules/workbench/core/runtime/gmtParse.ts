// A generic delimited-text parser (ITEM-6): GMT and flexible pasted text -> a list of records,
// each `{ name, description, values }`. DOMAIN-FREE — it names no domain concept (a "record" with
// "values", never a domain-specific set); the meaning of `values` lives only in the package view
// that binds the parsed rows into its own state shape. Used by a draftable editor's import affordance.

/** One parsed record: a name, an optional description, and its free-text token values. */
export interface ParsedRecord {
  name: string
  description: string
  values: string[]
}

/** Split a run of tokens on tab / comma / semicolon / whitespace, trim, and drop empties +
 *  duplicates (first-seen order preserved). */
function tokenize(parts: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of parts) {
    for (const tok of raw.split(/[\s,;]+/)) {
      const t = tok.trim()
      if (t && !seen.has(t)) {
        seen.add(t)
        out.push(t)
      }
    }
  }
  return out
}

/**
 * Parse GMT text: one record per line, TAB-delimited `name <tab> description <tab> value1 <tab> …`
 * (the GSEA `.gmt` shape). A line with < 2 tab fields is treated as `name <ws> values…`. Blank
 * lines and nameless lines are skipped (malformed lines never produce a nameless record).
 */
export function parseGmt(text: string): ParsedRecord[] {
  const records: ParsedRecord[] = []
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const fields = line.split('\t')
    if (fields.length >= 2) {
      const name = fields[0].trim()
      if (!name) continue
      const description = (fields[1] ?? '').trim()
      records.push({ name, description, values: tokenize(fields.slice(2)) })
    } else {
      // No tabs — fall back to the flexible single-line shape (name then values).
      const rec = parseLineFlexible(line)
      if (rec) records.push(rec)
    }
  }
  return records
}

/** Parse ONE flexible line: the first token is the `name`, the rest are `values` (split on
 *  tab / comma / semicolon / whitespace). Returns `null` for a blank/nameless line. */
function parseLineFlexible(line: string): ParsedRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  // First token = name (up to the first delimiter run), rest = values.
  const m = trimmed.match(/^(\S+)(.*)$/)
  if (!m) return null
  const name = m[1].trim()
  if (!name) return null
  return { name, description: '', values: tokenize([m[2] ?? '']) }
}

/**
 * Parse flexible pasted text: one record per line, `name` then its token values separated by
 * tab / comma / semicolon / whitespace. Blank/nameless lines are skipped.
 */
export function parseFlexible(text: string): ParsedRecord[] {
  const records: ParsedRecord[] = []
  for (const line of (text ?? '').split(/\r?\n/)) {
    const rec = parseLineFlexible(line)
    if (rec) records.push(rec)
  }
  return records
}
