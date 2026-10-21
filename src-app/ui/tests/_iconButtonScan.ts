/**
 * _iconButtonScan — the DETECTOR behind "an icon with no words must SAY what it does".
 *
 * Extracted out of `gallery-e2e/icon-button-tooltips.spec.ts` so a SECOND sweep can run
 * byte-identical logic over a second surface family. It lives directly under `tests/` — inside
 * NO config's `testDir`, and carrying no `test.*` call — so neither runner collects it and
 * importing it from either does not register the other's tests. (`check:e2e-routing` R1/R2 are
 * about `*.spec.ts` placement; a shared module is outside that.)
 *
 * ── WHY A SECOND SWEEP EXISTED TO BE WRITTEN ──────────────────────────────────────────────────
 * The gallery sweep walks 94 gallery surfaces and reported a clean tree. Not one of them mounts a
 * `@ziee/viz` component: `modules/visualization/gallery.tsx` is `{ crawlOnly: true }`, so the whole
 * plotting package — its pane chrome, its rails, its legend — was outside the guard's reach and a
 * green run said nothing at all about it. The sibling `viz-e2e/icon-button-tooltips-viz.spec.ts`
 * closes that by driving the same detector over the showcase, which is where those components
 * actually render.
 *
 * ── TWO CORRECTIONS THE SECOND SURFACE FORCED ────────────────────────────────────────────────
 * Both are WIDENINGS of the same claim, not exceptions to it, and both are pinned by probes in the
 * gallery spec's positive control:
 *
 *  (a) A GLYPH IS AN ICON however it is drawn. The predicate used to be "no visible text ⇒
 *      icon-only", so a button whose entire content is `▢`, `✕`, `▸` or `⏮` counted as LABELLED and
 *      was skipped — and, worse, `accessibleName` then answered `"▢"`, so it was not reported as
 *      nameless either. A control can therefore be invisible to BOTH halves of the guard by drawing
 *      its icon as a codepoint instead of an `<svg>`, which is what the viz legend's per-category
 *      show/hide toggle did. Text is now "text" only if it contains a LETTER or a NUMBER in any
 *      script (`\p{L}`/`\p{N}`), so CJK labels still count and geometric shapes do not.
 *
 *  (b) A NATIVE `title` ON AN ANCESTOR IS HOVER TEXT. `tooltipMarker` read `title` off the element
 *      only, while it already accepted the base-ui / kit markers on an ancestor. That asymmetry is
 *      not a policy — the browser really does show an ancestor's `title` when you hover a child, so
 *      reporting such a control as unexplained is a false finding. (Two collapsed kit `Select`
 *      triggers in viz are exactly this shape: the title sits on the wrapper span because Base UI
 *      renders the button.)
 */

/** One reported control. Identity within a surface: testid, else accessible name, else slot+class. */
export interface IconButton {
  id: string
  name: string
  desc: string
  slot: string
  tipMarker: string
  cls: string
}

export interface Scan {
  /** Every VISIBLE icon-only control seen — the denominator that makes "0 bad" mean something. */
  total: number
  /** Icon-only, visible, and nothing explains it on hover. */
  noTooltip: IconButton[]
  /** Icon-only, visible, and it has no accessible name in any channel. */
  noName: IconButton[]
}

/**
 * THE DETECTOR. Kept as a single SELF-CONTAINED serialized function — it is shipped to the browser
 * by `page.evaluate`, so it may close over nothing — so that every probe and every sweep run
 * byte-identical logic. A probe exercising a different predicate would prove nothing about a sweep.
 */
export const SCAN = () => {
  /** Does this string say a WORD, in any script? A geometric shape (`▢` `✕` `▸` `⏮` `−`) does not. */
  const hasWords = (s: string): boolean => /\p{L}|\p{N}/u.test(s)

  /** Text a SIGHTED user can read inside this control.
   *
   *  Deliberately not `textContent`/`innerText`:
   *    · an `<svg>` subtree is the icon, and an svg `<title>` is not a visible label;
   *    · `aria-hidden` content is decoration by declaration;
   *    · `display:none`/`visibility:hidden` is not rendered;
   *    · the `sr-only` idiom (clipped, or a 1×1 box) is text for assistive tech ONLY —
   *      counting it as visible is exactly the hole that would hide the kit's own
   *      Dialog close button, whose entire label is `<span class="sr-only">Close</span>`.
   */
  const visibleText = (el: Element): string => {
    let out = ''
    const walk = (node: Node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          out += child.textContent ?? ''
          continue
        }
        if (child.nodeType !== 1) continue
        const e = child as HTMLElement
        if (e.tagName.toLowerCase() === 'svg') continue
        if (e.getAttribute('aria-hidden') === 'true') continue
        const cs = getComputedStyle(e)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        const r = e.getBoundingClientRect()
        if (r.width <= 1 && r.height <= 1) continue
        walk(e)
      }
    }
    walk(el)
    return out.replace(/\s+/g, ' ').trim()
  }

  /** All text, sr-only included — this is what assistive tech gets. */
  const allText = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()

  const idsText = (el: Element, attr: string): string => {
    const ids = (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)
    return ids
      .map(id => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  const accessibleName = (el: Element): string => {
    const label = (el.getAttribute('aria-label') ?? '').trim()
    if (label !== '') return label
    const by = idsText(el, 'aria-labelledby')
    if (by !== '') return by
    // A name made of nothing but glyphs is not a name: a screen reader announcing "▢" has told
    // its user which button this is exactly as well as announcing nothing would.
    const text = allText(el)
    if (hasWords(text)) return text
    return (el.getAttribute('title') ?? '').trim()
  }

  /** Which mechanism, if any, explains this control on hover. '' = none. */
  const tooltipMarker = (el: Element): string => {
    // Self OR ancestor: the browser shows an ancestor's `title` when a child is hovered, and the
    // markers below have always been read with `closest`.
    const titled = el.closest('[title]')
    if (titled && (titled.getAttribute('title') ?? '').trim() !== '') return 'title'
    // The trigger may be the control itself or a wrapper around it (the repo wraps a
    // disabled control in a focusable span so the tooltip can still open).
    if (el.closest('[data-base-ui-tooltip-trigger]')) return 'base-ui'
    if (el.closest('[data-trigger-disabled]')) return 'base-ui-disabled'
    if (el.closest('[data-tooltip-wrapped]')) return 'kit-wrapper'
    return ''
  }

  const els = Array.from(document.querySelectorAll('button, [role="button"]'))
  const out: { total: number; noTooltip: unknown[]; noName: unknown[] } = {
    total: 0,
    noTooltip: [],
    noName: [],
  }
  for (const el of els) {
    // NOT RENDERED → nothing to explain. `.hidden` anchors exist purely to position a
    // dialog and are never seen or reached; a zero box is the honest test for that,
    // and unlike a class-name allowance it cannot be widened by accident.
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    if (hasWords(visibleText(el))) continue

    out.total += 1
    const name = accessibleName(el)
    const rec = {
      id:
        el.getAttribute('data-testid') ||
        name ||
        `${el.getAttribute('data-slot') ?? el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(/\s+/)[0] ?? ''}`,
      name,
      desc: idsText(el, 'aria-describedby'),
      slot: el.getAttribute('data-slot') ?? '',
      tipMarker: tooltipMarker(el),
      cls: (el.getAttribute('class') ?? '').slice(0, 60),
    }
    if (rec.tipMarker === '') out.noTooltip.push(rec)
    if (name === '') out.noName.push(rec)
  }
  return out
}

/**
 * Icon-only controls that CLAIM a kit tooltip, with the two strings that tooltip is allowed to
 * say. Scoped to claimants on purpose: a control with no tooltip at all is the SWEEP's finding
 * (and may be a ledgered one), so re-failing it here would say the same thing twice and couple
 * two independent verdicts. What is left is the sharper question — of the controls that promise
 * a tooltip, does it actually open, and does it say the same thing the name does. A `title`-only
 * control is excluded because a native tooltip is drawn by the OS and cannot be read back.
 */
export const SCAN_TARGETS = () => {
  const hasWords = (s: string): boolean => /\p{L}|\p{N}/u.test(s)
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
  }
  const visibleText = (el: Element): string => {
    let out = ''
    const walk = (node: Node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          out += child.textContent ?? ''
          continue
        }
        if (child.nodeType !== 1) continue
        const e = child as HTMLElement
        if (e.tagName.toLowerCase() === 'svg') continue
        if (e.getAttribute('aria-hidden') === 'true') continue
        const cs = getComputedStyle(e)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        const r = e.getBoundingClientRect()
        if (r.width <= 1 && r.height <= 1) continue
        walk(e)
      }
    }
    walk(el)
    return out.replace(/\s+/g, ' ').trim()
  }
  const idsText = (el: Element, attr: string): string =>
    (el.getAttribute(attr) ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map(id => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  const claimsTooltip = (el: Element) =>
    el.closest('[data-base-ui-tooltip-trigger]') != null || el.closest('[data-tooltip-wrapped]') != null
  return Array.from(document.querySelectorAll('button[data-testid], [role="button"][data-testid]'))
    .filter(el => visible(el) && !hasWords(visibleText(el)) && claimsTooltip(el))
    .map(el => ({
      testid: el.getAttribute('data-testid') ?? '',
      name:
        (el.getAttribute('aria-label') ?? '').trim() ||
        idsText(el, 'aria-labelledby') ||
        (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      desc: idsText(el, 'aria-describedby'),
    }))
    .filter(t => t.testid !== '')
}

/**
 * Does the text a sighted user reads on hover agree with what the control is CALLED?
 *
 * Not string equality, and the loosening is deliberate — equality flagged
 * `tooltip "Share"` against `aria-label "Share Row Three"`, which is not a
 * disagreement: the name carries the row so a screen reader can tell twelve identical bins
 * apart, and the tooltip drops it because the row is right there on screen. Equality also
 * flagged `"Attach to project"` vs `"Attach Row Three to a project"`, where the extra
 * word is INFIX, so "is it a prefix/substring" does not describe the rule either.
 *
 * The rule that does: **the tooltip may not introduce a word the name does not have.** A
 * shorter form of the same sentence passes; a different sentence does not. It still catches
 * every real disagreement this tree had — `"Open the analysis form"` vs
 * `"Open Row Three form"` (the/analysis), `"Open sidebar"` vs
 * `"Open navigation menu"` (sidebar), `"Add to folder"` vs `"Folders for X"` (add, folder).
 *
 * The second arm is the DESCRIPTION, exact: a blocked control's tooltip is its reason, which
 * is a different sentence on purpose and must not be forced to echo the name (the `93167985`
 * precedent — the reason must not swallow what the control IS).
 */
export function tooltipAgrees(shown: string, name: string, desc: string): boolean {
  if (shown === '') return false
  if (desc !== '' && shown === desc) return true
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)
  const have = new Set(words(name))
  return words(shown).every(w => have.has(w))
}

/**
 * Did the behavioural pass actually look at anything? A control the pointer cannot land on
 * (a pannable canvas clips its node's button at this scroll position) is skipped, and a run
 * where EVERY claimant was skipped must not read as a pass — that is a broken fixture, not a
 * clean surface. Pure, so the state can be asserted without engineering an unhittable surface.
 */
export function sweptEnough(checked: number, unreachable: number): boolean {
  return checked > Math.max(2, unreachable)
}

/** The shrink-only ledger comparison, as a pure function so both halves are testable. */
export function diffLedger(
  observed: Record<string, number>,
  committed: Record<string, number>,
): { added: string[]; stale: string[] } {
  return {
    added: Object.entries(observed)
      .filter(([k, n]) => n > (committed[k] ?? 0))
      .map(([k, n]) => `NEW   ${k}  (${n}, ledger allows ${committed[k] ?? 0})`),
    stale: Object.entries(committed)
      .filter(([k, n]) => (observed[k] ?? 0) < n)
      .map(([k, n]) => `STALE ${k}  (ledger says ${n}, only ${observed[k] ?? 0} remain)`),
  }
}
