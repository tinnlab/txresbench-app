// The inverse of `gmtParse` (ITEM-10): a list of records -> GMT text. DOMAIN-FREE — it names
// no domain concept (a "record" with "values", never a domain entity); the domain meaning lives
// only in the package that maps its own state shape onto these records. Used by a frozen-collection
// export affordance.

/** One record to serialize: a name, an optional description, and its token values. */
export interface SerializableRecord {
  name: string
  description?: string
  values: readonly string[]
}

/**
 * Serialize records to GMT: one record per line, TAB-delimited
 * `name <tab> description <tab> value1 <tab> value2 …` (the GSEA `.gmt` shape). A record with
 * no `description` still emits the (empty) description field, so every line has ≥2 tab fields —
 * `gmtParse` round-trips it back to the same `{name, description, values}`. A nameless record is
 * skipped (a GMT line must start with a set name). The output ends with a trailing newline.
 */
export function serializeGmt(records: readonly SerializableRecord[]): string {
  const lines: string[] = []
  for (const rec of records ?? []) {
    const name = (rec?.name ?? '').trim()
    if (!name) continue
    const description = (rec?.description ?? '').trim()
    const values = (rec?.values ?? []).map(v => String(v).trim()).filter(v => v.length > 0)
    lines.push([name, description, ...values].join('\t'))
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}
