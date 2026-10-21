import { isValidElement, type ReactNode } from 'react'

/**
 * Streamdown's DEFAULT element classes. Overriding a component replaces its
 * renderer, so these must be re-applied by hand or the markdown loses its
 * styling (headings collapse to body text, links lose accent + underline).
 * Kept in sync with `node_modules/streamdown/dist` (the jsx("hN"/"a", …) calls).
 */
export const HEADING_CLASS: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: 'mt-6 mb-2 font-semibold text-3xl',
  2: 'mt-6 mb-2 font-semibold text-2xl',
  3: 'mt-6 mb-2 font-semibold text-xl',
  4: 'mt-6 mb-2 font-semibold text-lg',
  5: 'mt-6 mb-2 font-semibold text-base',
  6: 'mt-6 mb-2 font-semibold text-sm',
}
export const LINK_CLASS = 'wrap-anywhere font-medium text-primary underline'

/** Flatten a React node tree to its text content (for deriving a heading slug). */
export function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeToText).join('')
  if (isValidElement(node)) {
    return nodeToText((node.props as { children?: ReactNode }).children)
  }
  return ''
}

/**
 * GitHub-style heading slug (approximation): lowercase, drop punctuation except
 * word chars / spaces / hyphens, spaces→hyphens, collapse + trim hyphens. Used
 * for BOTH the heading `id` and the hash-link target so `[Foo](#foo)` resolves.
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** decodeURIComponent that never throws on a malformed `%` sequence. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
