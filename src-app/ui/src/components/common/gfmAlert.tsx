import { Children, cloneElement, isValidElement, type ReactNode } from 'react'
import { Info, Lightbulb, MessageSquareWarning, OctagonAlert, TriangleAlert } from 'lucide-react'
import { Alert, type AlertTone } from '@ziee/kit/kit/alert'

/**
 * GitHub-Flavored-Markdown alerts (a.k.a. callouts / admonitions):
 *
 *   > [!NOTE]
 *   > Useful information the user should know.
 *
 * remark parses these as a plain blockquote whose first line is the literal
 * `[!TYPE]` marker — Streamdown has no built-in handling, so without this they
 * render as an ordinary blockquote with the raw `[!NOTE]` text showing. This
 * detects the marker and renders the GitHub-style callout via the kit Alert
 * instead. Shared so the chat renderer AND the markdown file viewer render
 * alerts identically.
 *
 * The kit tone palette has no purple, so IMPORTANT reuses the `info` (blue)
 * color but keeps its own icon + "Important" title to stay distinguishable.
 */
const GFM_ALERT: Record<string, { tone: AlertTone; label: string; icon: ReactNode }> = {
  NOTE: { tone: 'info', label: 'Note', icon: <Info /> },
  TIP: { tone: 'success', label: 'Tip', icon: <Lightbulb /> },
  IMPORTANT: { tone: 'info', label: 'Important', icon: <MessageSquareWarning /> },
  WARNING: { tone: 'warning', label: 'Warning', icon: <TriangleAlert /> },
  CAUTION: { tone: 'error', label: 'Caution', icon: <OctagonAlert /> },
}

const MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i
// Strips the marker AND the whitespace/soft-break that follows it (remark keeps
// the `> [!NOTE]\n> body` soft break as a `\n` inside the first text node).
const MARKER_STRIP = /^\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i

/** Depth-first: the first non-empty text encountered in the render tree. */
function leadingText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    for (const n of node) {
      const t = leadingText(n)
      if (t.trim() !== '') return t
    }
    return ''
  }
  if (isValidElement(node)) {
    return leadingText((node.props as { children?: ReactNode }).children)
  }
  return ''
}

/** Remove the leading `[!TYPE]` marker from the first text node it appears in,
 *  leaving the rest of the (inline-formatted) body intact. */
function stripMarker(node: ReactNode, state: { done: boolean }): ReactNode {
  if (state.done) return node
  if (typeof node === 'string') {
    if (node.trim() === '') return node // skip whitespace-only nodes, keep scanning
    const replaced = node.replace(MARKER_STRIP, '')
    state.done = true // the marker is at the very start; first real text is it
    return replaced
  }
  if (Array.isArray(node)) return Children.map(node, n => stripMarker(n, state))
  if (isValidElement(node)) {
    const kids = (node.props as { children?: ReactNode }).children
    if (kids == null) return node
    return cloneElement(node, undefined, stripMarker(kids, state))
  }
  return node
}

/**
 * If `children` (a blockquote's content) begins with a GFM alert marker, returns
 * the rendered callout; otherwise `null` so the caller falls back to its normal
 * blockquote rendering.
 */
export function renderGfmAlert(children: ReactNode): ReactNode | null {
  const m = MARKER.exec(leadingText(children).trimStart())
  if (!m) return null
  const cfg = GFM_ALERT[m[1].toUpperCase()]
  if (!cfg) return null
  const body = stripMarker(children, { done: false })
  return (
    <Alert
      tone={cfg.tone}
      icon={cfg.icon}
      title={cfg.label}
      className="my-3"
      data-testid={`gfm-alert-${m[1].toLowerCase()}`}
    >
      {body}
    </Alert>
  )
}
