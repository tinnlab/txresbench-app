// Link reference definition:  [id]: url "optional title"   (indented ≤3 spaces)
const DEF_RE =
  /^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(<[^>\r\n]*>|\S+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/gm

// Inline image:  ![alt](url "title")
const IMG_RE =
  /!\[([^\]\r\n]*)\]\(\s*(<[^>\r\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g

const normId = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

function isSameOriginImage(url: string): boolean {
  if (url.startsWith('/')) return true
  if (url.startsWith('data:')) return false
  try {
    return new URL(url, window.location.origin).origin === window.location.origin
  } catch {
    return false
  }
}

/**
 * One-pass markdown pre-processing applied before the text reaches Streamdown
 * (which parses block-by-block for streaming). Two fixes, both operating outside
 * code spans/fences:
 *
 * 1. **Reference links** — Streamdown resolves `[text][id]` only within a single
 *    block, so a `[id]: url` definition in another paragraph is invisible and
 *    renders as raw text. We collect every definition in the full document and
 *    rewrite the usages to inline `[text](url)`.
 *
 * 2. **Blocked images** — external / `data:` image `src`s are blocked for
 *    exfil-safety, and Streamdown's own image component just hides the (never-
 *    loaded) image, leaving a broken-looking dangling caption. We rewrite those
 *    to a `🖼 alt` placeholder — a link out for a standalone external image
 *    (opens only on an explicit click; nothing auto-loads), or plain text when
 *    it's a `data:` URI or already wrapped in a link. Same-origin images are
 *    left intact.
 */
export function preprocessMarkdown(md: string): string {
  if (typeof md !== 'string' || md.indexOf('[') === -1) return md

  DEF_RE.lastIndex = 0
  const defs = new Map<string, { url: string; title?: string }>()
  let m: RegExpExecArray | null
  while ((m = DEF_RE.exec(md)) !== null) {
    const id = normId(m[1])
    if (defs.has(id)) continue
    let url = m[2]
    if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1)
    defs.set(id, { url, title: m[3] ?? m[4] ?? m[5] })
  }

  const inlineLink = (label: string, d: { url: string; title?: string }, bang: string) =>
    `${bang}[${label}](${d.url}${d.title ? ` "${d.title.replace(/"/g, '\\"')}"` : ''})`

  // Split on code fences + inline code so we never rewrite inside code. The
  // capture group keeps the delimiters at ODD indices — rewrite EVEN only.
  const parts = md.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\r\n]+`)/)
  for (let i = 0; i < parts.length; i += 2) {
    let s = parts[i]

    // (2) Blocked images → placeholder. Done before the reference pass so the
    // rewritten `[🖼 alt](url)` link isn't itself re-touched.
    s = s.replace(IMG_RE, (whole, alt: string, rawUrl: string, offset: number, str: string) => {
      let url = rawUrl
      if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1)
      if (isSameOriginImage(url)) return whole
      const label = `🖼 ${alt?.trim() || 'image'}`
      // `![…]` preceded by `[` is an image-as-link (`[![…](…)](…)`); keep it as
      // text so we don't create an invalid nested link.
      const insideLink = offset > 0 && str[offset - 1] === '['
      return !insideLink && /^https?:\/\//i.test(url) ? `[${label}](${url})` : label
    })

    // (1) Reference links (only when the doc has definitions).
    if (defs.size > 0) {
      // Full + collapsed:  [label][id]  and  [label][]
      s = s.replace(/(!?)\[([^\]\r\n]+)\]\[([^\]\r\n]*)\]/g, (whole, bang, label, id) => {
        const d = defs.get(normId(id.trim() === '' ? label : id))
        return d ? inlineLink(label, d, bang) : whole
      })
      // Shortcut:  [label]  (not `[](`, `[][`, `[]:`, or a footnote `[^…]`)
      s = s.replace(/(!?)\[([^\]\r\n^][^\]\r\n]*)\](?![[(:])/g, (whole, bang, label) => {
        const d = defs.get(normId(label))
        return d ? inlineLink(label, d, bang) : whole
      })
    }

    parts[i] = s
  }
  return parts.join('')
}
